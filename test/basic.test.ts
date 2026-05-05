import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addAccount } from "../src/config.js";
import { toolMapsFromChatTools, toolMapsFromResponsesTools } from "../src/compat.js";
import { buildCodexBody } from "../src/chat.js";
import { parseSse } from "../src/codex.js";
import { modelIdsForAccount, sanitizeModelIdPart } from "../src/models.js";
import { buildCodexResponsesBody, collectChatCompletion, collectResponse, serve, streamChatCompletion } from "../src/server.js";
import type { ModelRoute } from "../src/types.js";
import type { ServerResponse } from "node:http";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = resolve(projectRoot, "src/cli.ts");
const testRoute: ModelRoute = {
  publicModelId: "test-gpt-5.5-medium",
  codexModel: "gpt-5.5",
  reasoning: "medium",
  source: "account-name",
  account: {
    id: 1,
    name: "test",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
};

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "codexapiuse-test-"));
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    previous.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  assert(address && typeof address === "object");
  return address.port;
}

async function startServer(home: string, port: number, env: Record<string, string> = {}): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, ["--import", "tsx", cliPath, "serve", "--port", String(port)], {
    cwd: projectRoot,
    env: { ...process.env, CODEXAPIUSE_HOME: home, CODEXAPIUSE_API_KEY: "", ...env },
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error("server did not start")), 5000);
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("codexapiuse listening")) {
        clearTimeout(timeout);
        resolvePromise();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectPromise(new Error(`server exited before startup: ${code}\n${output}`));
    });
  });

  return child;
}

async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const payload = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return new Response(stream);
}

test("model IDs sanitize account names and hide unsupported xhigh levels", () => {
  assert.equal(sanitizeModelIdPart(" Work Account! "), "work-account");
  const ids = modelIdsForAccount({ id: 1, name: "Work Account" }, {
    models: ["gpt-5.1", "gpt-5.5"],
    reasoning: ["low", "xhigh"],
  });
  assert.deepEqual(ids, ["work-account-gpt-5.1-low", "work-account-gpt-5.5-low", "work-account-gpt-5.5-xhigh"]);
});

test("addAccount rejects sanitized alias collisions", async () => {
  const home = tempHome();
  await withEnv({ CODEXAPIUSE_HOME: home }, () => {
    addAccount("work account");
    assert.throws(() => addAccount("work-account"), /collides/);
  });
  rmSync(home, { recursive: true, force: true });
});

test("quickstart rejects args and non-interactive usage", async () => {
  const home = tempHome();
  try {
    const withArgs = spawn(process.execPath, ["--import", "tsx", cliPath, "quickstart", "work"], {
      cwd: projectRoot,
      env: { ...process.env, CODEXAPIUSE_HOME: home },
    });
    let argOutput = "";
    withArgs.stderr.on("data", (chunk: Buffer) => { argOutput += chunk.toString("utf8"); });
    const argCode = await new Promise<number | null>((resolvePromise) => withArgs.once("exit", resolvePromise));
    assert.notEqual(argCode, 0);
    assert.match(argOutput, /Usage: codexapiuse quickstart/);

    const nonInteractive = spawn(process.execPath, ["--import", "tsx", cliPath, "quickstart"], {
      cwd: projectRoot,
      env: { ...process.env, CODEXAPIUSE_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputText = "";
    nonInteractive.stderr.on("data", (chunk: Buffer) => { outputText += chunk.toString("utf8"); });
    const code = await new Promise<number | null>((resolvePromise) => nonInteractive.once("exit", resolvePromise));
    assert.notEqual(code, 0);
    assert.match(outputText, /quickstart requires an interactive terminal/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildCodexBody converts chat messages to Codex Responses input", () => {
  const body = buildCodexBody({
    model: "public-model",
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello" },
    ],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
  }, "gpt-5.5", "minimal", "cache-key");

  assert.equal(body.model, "gpt-5.5");
  assert.equal(body.instructions, "Be concise.");
  assert.equal(body.prompt_cache_key, "cache-key");
  assert.deepEqual(body.reasoning, { effort: "low", summary: "auto" });
  assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }]);
  assert.deepEqual(body.tools, [{ type: "function", name: "lookup", description: "", parameters: { type: "object" }, strict: null }]);
});

test("buildCodexBody preserves multimodal input and Responses tool item IDs", () => {
  const body = buildCodexBody({
    model: "public-model",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      },
      {
        role: "assistant",
        tool_calls: [{
          id: "call_1|fc_1",
          type: "function",
          function: { name: "lookup", arguments: "{\"q\":\"x\"}" },
        }],
      },
      { role: "tool", tool_call_id: "call_1|fc_1", content: "ok" },
    ],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    tool_choice: "auto",
  }, "gpt-5.5", "medium", "cache-key");

  assert.deepEqual(body.input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: "Describe this" },
        { type: "input_image", detail: "auto", image_url: "data:image/png;base64,abc" },
      ],
    },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" },
    { type: "function_call_output", call_id: "call_1", output: "ok" },
  ]);
});

test("buildCodexBody maps structured outputs, tool_choice, long names, built-ins, and rich tool output", () => {
  const longName = `mcp__server__${"x".repeat(80)}__lookup`;
  const body = buildCodexBody({
    model: "public-model",
    messages: [
      {
        role: "assistant",
        tool_calls: [{
          id: "call_long|fc_long",
          type: "function",
          function: { name: longName, arguments: "{}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_long|fc_long",
        content: [
          { type: "text", text: "ok" },
          { type: "image_url", image_url: { file_id: "file_img", detail: "high" } },
          { type: "file", file: { file_data: "data", file_url: "https://example.test/file.txt", filename: "file.txt" } },
        ],
      },
    ],
    tools: [
      { type: "function", function: { name: longName, parameters: { type: "object" } } },
      { type: "web_search_preview_2025_03_11" },
    ] as never,
    tool_choice: { type: "function", function: { name: longName } },
    response_format: {
      type: "json_schema",
      json_schema: { name: "answer", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } } } },
    },
  }, "gpt-5.5", "medium", "cache-key");
  const shortName = ((body.tools as Array<Record<string, unknown>>)[0]).name as string;

  assert.equal(shortName.length <= 64, true);
  assert.notEqual(shortName, longName);
  assert.equal((body.tool_choice as Record<string, unknown>).name, shortName);
  assert.equal((body.tools as Array<Record<string, unknown>>)[1].type, "web_search");
  assert.deepEqual((body.text as Record<string, unknown>).format, {
    type: "json_schema",
    name: "answer",
    strict: true,
    schema: { type: "object", properties: { ok: { type: "boolean" } } },
  });
  assert.deepEqual(body.input, [
    { type: "function_call", id: "fc_long", call_id: "call_long", name: shortName, arguments: "{}" },
    {
      type: "function_call_output",
      call_id: "call_long",
      output: [
        { type: "input_text", text: "ok" },
        { type: "input_image", detail: "high", file_id: "file_img" },
        { type: "input_file", file_data: "data", file_url: "https://example.test/file.txt", filename: "file.txt" },
      ],
    },
  ]);
});

test("buildCodexResponsesBody rewrites system roles, normalizes tools, and allow-lists passthrough fields", () => {
  const longName = `mcp__server__${"y".repeat(80)}__lookup`;
  const body = buildCodexResponsesBody({
    model: "public-model",
    input: [
      { role: "system", content: "rules" },
      { type: "function_call", call_id: "call_1", name: longName, arguments: "{}" },
    ],
    tools: [
      { type: "function", name: longName, parameters: { type: "object" } },
      { type: "web_search_preview" },
    ],
    tool_choice: { type: "allowed_tools", tools: [{ type: "web_search_preview_2025_03_11" }, { type: "function", name: longName }] },
    response_format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" } } },
    temperature: 1,
    top_p: 0.5,
    max_output_tokens: 10,
    user: "u",
    context_management: { compaction: {} },
  } as never, testRoute);
  const shortName = ((body.tools as Array<Record<string, unknown>>)[0]).name as string;

  assert.equal(((body.input as Array<Record<string, unknown>>)[0]).role, "developer");
  assert.equal(((body.input as Array<Record<string, unknown>>)[1]).name, shortName);
  assert.equal((body.tools as Array<Record<string, unknown>>)[1].type, "web_search");
  assert.equal(((body.tool_choice as Record<string, unknown>).tools as Array<Record<string, unknown>>)[0].type, "web_search");
  assert.equal(((body.tool_choice as Record<string, unknown>).tools as Array<Record<string, unknown>>)[1].name, shortName);
  assert.deepEqual((body.text as Record<string, unknown>).format, { type: "json_schema", name: "answer", schema: { type: "object" } });
  for (const unsupported of ["temperature", "top_p", "max_output_tokens", "max_completion_tokens", "truncation", "user", "context_management"]) {
    assert.equal(Object.hasOwn(body, unsupported), false);
  }
});

test("parseSse reports invalid upstream JSON", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {bad json}\n\n"));
      controller.close();
    },
  });
  await assert.rejects(async () => {
    for await (const _event of parseSse(new Response(stream))) {}
  }, /Invalid Codex SSE JSON/);
});

test("collectChatCompletion keeps interleaved parallel tool call arguments separate", async () => {
  const body = await collectChatCompletion(testRoute, sseResponse([
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "first" } },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "second" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_b", output_index: 1, delta: "{\"b\":" },
    { type: "response.function_call_arguments.delta", item_id: "fc_a", output_index: 0, delta: "{\"a\":" },
    { type: "response.function_call_arguments.done", item_id: "fc_a", output_index: 0, arguments: "{\"a\":1}" },
    { type: "response.function_call_arguments.done", item_id: "fc_b", output_index: 1, arguments: "{\"b\":2}" },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 } } } },
  ]));

  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(body.choices[0].message.tool_calls, [
    { id: "call_a", type: "function", function: { name: "first", arguments: "{\"a\":1}" } },
    { id: "call_b", type: "function", function: { name: "second", arguments: "{\"b\":2}" } },
  ]);
  assert.deepEqual(body.usage, {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
    prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 3, cache_creation_tokens: 3, cache_creation_input_tokens: 3 },
  });
});

test("collectChatCompletion restores shortened tool names and image outputs", async () => {
  const longName = `mcp__server__${"z".repeat(80)}__lookup`;
  const maps = toolMapsFromChatTools([{ type: "function", function: { name: longName } }]);
  const shortName = maps.originalToShort.get(longName);
  assert(shortName);
  const body = await collectChatCompletion(testRoute, sseResponse([
    { type: "response.reasoning_summary_text.delta", delta: "thinking" },
    { type: "response.reasoning_summary_text.done" },
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: shortName } },
    { type: "response.function_call_arguments.done", item_id: "fc_a", output_index: 0, arguments: "{}" },
    { type: "response.image_generation_call.partial_image", item_id: "img_1", partial_image_b64: "abc", output_format: "jpeg" },
    { type: "response.output_item.done", output_index: 1, item: { type: "image_generation_call", id: "img_1", result: "abc", output_format: "jpeg" } },
    { type: "response.completed", response: { status: "completed" } },
  ]), maps);

  assert.equal(body.choices[0].message.tool_calls[0].function.name, longName);
  assert.equal(body.choices[0].message.reasoning_content, "thinking");
  assert.deepEqual(body.choices[0].message.images, [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } }]);
  assert.equal(body.choices[0].native_finish_reason, "tool_calls");
});

test("streamChatCompletion keeps interleaved parallel tool call chunks indexed correctly", async () => {
  const chunks: string[] = [];
  const res = {
    setHeader() {},
    flushHeaders() {},
    write(chunk: string) { chunks.push(chunk); return true; },
    end() {},
  } as unknown as ServerResponse;

  await streamChatCompletion(res, testRoute, sseResponse([
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "first" } },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "second" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_b", output_index: 1, delta: "{\"b\":" },
    { type: "response.function_call_arguments.delta", item_id: "fc_a", output_index: 0, delta: "{\"a\":" },
    { type: "response.function_call_arguments.done", item_id: "fc_a", output_index: 0, arguments: "{\"a\":1}" },
    { type: "response.function_call_arguments.done", item_id: "fc_b", output_index: 1, arguments: "{\"b\":2}" },
    { type: "response.completed", response: { status: "completed" } },
  ]));

  const payloads = chunks
    .flatMap((chunk) => chunk.split("\n\n"))
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice(6)) as { choices?: Array<{ delta?: { tool_calls?: Array<{ index: number; function?: { arguments?: string } }> } }> });
  const toolDeltas = payloads.flatMap((payload) => payload.choices?.[0]?.delta?.tool_calls || []);
  const terminal = payloads.find((payload) => payload.choices?.[0]?.finish_reason);

  assert.deepEqual(toolDeltas.map((delta) => [delta.index, delta.function?.arguments || ""]), [
    [0, ""],
    [1, ""],
    [1, "{\"b\":"],
    [0, "{\"a\":"],
    [0, "1}"],
    [1, "2}"],
  ]);
  assert.equal(terminal?.choices?.[0]?.native_finish_reason, "tool_calls");
});

test("collectResponse reduces reasoning, message, and interleaved function call items", async () => {
  const body = await collectResponse(testRoute, sseResponse([
    { type: "response.created", response: { id: "resp_test" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
    { type: "response.reasoning_summary_part.added", item_id: "rs_1", output_index: 0, part: { type: "summary_text", text: "" } },
    { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, delta: "thinking" },
    { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: "msg_1", output_index: 1, part: { type: "output_text", text: "" } },
    { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup" } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, delta: "hello" },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 2, delta: "{\"q\":" },
    { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 2, arguments: "{\"q\":\"pong\"}" },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] },
    },
    { type: "response.output_item.done", output_index: 3, item: { type: "image_generation_call", id: "img_1", result: "abc", output_format: "png" } },
    { type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 } } } },
  ]));

  assert.equal(body.id, "resp_test");
  assert.equal(body.status, "completed");
  assert.deepEqual(body.output, [
    { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }] },
    { type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "hello", annotations: [] }] },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"pong\"}" },
    { type: "image_generation_call", id: "img_1", result: "abc", output_format: "png" },
  ]);
  assert.deepEqual(body.usage, {
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
    input_tokens_details: { cached_tokens: 4, cache_write_tokens: 3, cache_creation_tokens: 3, cache_creation_input_tokens: 3 },
    cache_creation_input_tokens: 3,
  });
});

test("collectResponse and stream passthrough restore shortened Responses tool names", async () => {
  const longName = `mcp__server__${"r".repeat(80)}__lookup`;
  const maps = toolMapsFromResponsesTools([{ type: "function", name: longName }]);
  const shortName = maps.originalToShort.get(longName);
  assert(shortName);
  const body = await collectResponse(testRoute, sseResponse([
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: shortName, arguments: "{}" } },
    { type: "response.completed", response: { status: "completed" } },
  ]), maps);
  assert.equal(body.output[0].name, longName);
});

test("serve refuses non-loopback hosts without a local API key", async () => {
  await withEnv({ CODEXAPIUSE_API_KEY: undefined }, () => {
    assert.throws(() => serve({ host: "0.0.0.0", port: 3145 }), /Refusing to listen/);
  });
});

test("server returns client errors for invalid JSON and unknown models", async () => {
  const home = tempHome();
  writeFileSync(join(home, "accounts.json"), `${JSON.stringify({
    version: 1,
    nextId: 2,
    accounts: [{
      id: 1,
      name: "norms",
      access: "fake",
      refresh: "fake",
      expires: Date.now() + 60_000,
      accountId: "acct",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    routes: {},
    defaults: { models: ["gpt-5.5"], reasoning: ["medium"] },
  })}\n`);
  const port = await freePort();
  const child = await startServer(home, port);
  try {
    const invalid = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /Invalid JSON/);

    const unknown = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "norms-gpt-5.5-medum", messages: [] }),
    });
    assert.equal(unknown.status, 404);
    const json = await unknown.json() as { error: { message: string } };
    assert.match(json.error.message, /Did you mean "norms-gpt-5.5-medium"/);
    assert.match(json.error.message, /cau models/);
  } finally {
    await stopServer(child);
    rmSync(home, { recursive: true, force: true });
  }
});

test("models endpoint advertises image input support metadata", async () => {
  const home = tempHome();
  writeFileSync(join(home, "accounts.json"), `${JSON.stringify({
    version: 1,
    nextId: 2,
    accounts: [{
      id: 1,
      name: "norms",
      access: "fake",
      refresh: "fake",
      expires: Date.now() + 60_000,
      accountId: "acct",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    routes: {},
    defaults: { models: ["gpt-5.5"], reasoning: ["medium"] },
  })}\n`);
  const port = await freePort();
  const child = await startServer(home, port);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(response.status, 200);
    const body = await response.json() as { data: Array<Record<string, unknown>> };
    assert.deepEqual(body.data[0].input, ["text", "image"]);
    assert.deepEqual(body.data[0].modalities, ["text", "image"]);
    assert.deepEqual(body.data[0].supported_input_modalities, ["text", "image"]);
    assert.deepEqual(body.data[0].supportedInputModalities, ["TEXT", "IMAGE"]);
  } finally {
    await stopServer(child);
    rmSync(home, { recursive: true, force: true });
  }
});

test("optional request logging records endpoint, model, stream, status, and duration", async () => {
  const home = tempHome();
  writeFileSync(join(home, "accounts.json"), `${JSON.stringify({
    version: 1,
    nextId: 2,
    accounts: [{
      id: 1,
      name: "norms",
      access: "fake",
      refresh: "fake",
      expires: Date.now() + 60_000,
      accountId: "acct",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    routes: {},
    defaults: { models: ["gpt-5.5"], reasoning: ["medium"] },
  })}\n`);
  const port = await freePort();
  const child = await startServer(home, port, { CODEXAPIUSE_LOG_REQUESTS: "1" });
  try {
    let output = "";
    const logged = new Promise<void>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => rejectPromise(new Error(`request log not emitted\n${output}`)), 2000);
      const onData = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.includes("path=\"/v1/responses\"")) {
          clearTimeout(timeout);
          child.stdout.off("data", onData);
          child.stderr.off("data", onData);
          resolvePromise();
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
    });

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "norms-gpt-5.5-medum", stream: true, input: "hi" }),
    });
    assert.equal(response.status, 404);
    await logged;
    assert.match(output, /request method=POST path="\/v1\/responses" status=404 duration_ms=\d+\.\d model="norms-gpt-5\.5-medum" stream=true/);
  } finally {
    await stopServer(child);
    rmSync(home, { recursive: true, force: true });
  }
});
