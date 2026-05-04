import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addAccount } from "../src/config.js";
import { buildCodexBody } from "../src/chat.js";
import { modelIdsForAccount, sanitizeModelIdPart } from "../src/models.js";
import { serve } from "../src/server.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = resolve(projectRoot, "src/cli.ts");

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

async function startServer(home: string, port: number): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, ["--import", "tsx", cliPath, "serve", "--port", String(port)], {
    cwd: projectRoot,
    env: { ...process.env, CODEXAPIUSE_HOME: home, CODEXAPIUSE_API_KEY: "" },
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
