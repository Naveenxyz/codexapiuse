import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { loadConfig, isLoggedIn } from "./config.js";
import { allModelRoutes, codexReasoningEffort, resolveModelRoute } from "./models.js";
import type { ChatCompletionRequest, ModelRoute } from "./types.js";
import { buildCodexBody, stablePromptCacheKey } from "./chat.js";
import { fetchCodexResponses, parseSse, type CodexEvent } from "./codex.js";

interface ServeOptions {
  host: string;
  port: number;
}

function setCommonHeaders(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type,x-api-key");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  setCommonHeaders(res);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(body)}\n`);
}

function sendError(res: ServerResponse, status: number, message: string, type = "invalid_request_error"): void {
  sendJson(res, status, { error: { message, type, code: null } });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as unknown;
}

function requireLocalApiKey(req: IncomingMessage): string | undefined {
  const expected = process.env.CODEXAPIUSE_API_KEY;
  if (!expected) return undefined;
  const auth = req.headers.authorization || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;
  const apiKey = Array.isArray(req.headers["x-api-key"]) ? req.headers["x-api-key"][0] : req.headers["x-api-key"];
  if (bearer === expected || apiKey === expected) return undefined;
  return "Invalid or missing local API key.";
}

function listModels() {
  const config = loadConfig();
  const routes = allModelRoutes({ ...config, accounts: config.accounts.filter(isLoggedIn) });
  return {
    object: "list",
    data: routes.map((route) => ({
      id: route.publicModelId,
      object: "model",
      created: 0,
      owned_by: `codexapiuse:${route.account.name}`,
    })),
  };
}

function sseWrite(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sseDone(res: ServerResponse): void {
  res.write("data: [DONE]\n\n");
  res.end();
}

function getNestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const next = (value as Record<string, unknown>)[key];
  return next && typeof next === "object" ? next as Record<string, unknown> : undefined;
}

function getTextDelta(event: CodexEvent): string | undefined {
  return typeof event.delta === "string" ? event.delta : undefined;
}

function getUsage(event: CodexEvent): Record<string, unknown> | undefined {
  const response = getNestedRecord(event, "response");
  const usage = response?.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const total = typeof usage.total_tokens === "number" ? usage.total_tokens : input + output;
  const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total,
    ...(inputDetails ? { prompt_tokens_details: inputDetails } : {}),
    ...(outputDetails ? { completion_tokens_details: outputDetails } : {}),
  };
}

function getFinishReason(event: CodexEvent, hasToolCalls: boolean): "stop" | "length" | "tool_calls" {
  const response = getNestedRecord(event, "response");
  const status = response?.status;
  if (hasToolCalls) return "tool_calls";
  if (status === "incomplete") return "length";
  return "stop";
}

function openAiChunkBase(id: string, model: string) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
}

async function streamChatCompletion(res: ServerResponse, route: ModelRoute, codexResponse: Response): Promise<void> {
  setCommonHeaders(res);
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const id = `chatcmpl-${randomUUID()}`;
  sseWrite(res, { ...openAiChunkBase(id, route.publicModelId), choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

  let hasToolCalls = false;
  let currentToolIndex = -1;
  let usage: ReturnType<typeof getUsage> | undefined;

  for await (const event of parseSse(codexResponse)) {
    if (event.type === "response.reasoning_summary_text.delta") {
      const delta = getTextDelta(event);
      if (delta) {
        sseWrite(res, { ...openAiChunkBase(id, route.publicModelId), choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }] });
      }
    } else if (event.type === "response.reasoning_summary_part.done") {
      sseWrite(res, { ...openAiChunkBase(id, route.publicModelId), choices: [{ index: 0, delta: { reasoning_content: "\n\n" }, finish_reason: null }] });
    } else if (event.type === "response.output_text.delta") {
      const delta = getTextDelta(event);
      if (delta) {
        sseWrite(res, { ...openAiChunkBase(id, route.publicModelId), choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
      }
    } else if (event.type === "response.output_item.added") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        hasToolCalls = true;
        currentToolIndex += 1;
        sseWrite(res, {
          ...openAiChunkBase(id, route.publicModelId),
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: currentToolIndex,
                id: typeof item.call_id === "string" ? item.call_id : `call_${currentToolIndex}`,
                type: "function",
                function: { name: typeof item.name === "string" ? item.name : "", arguments: "" },
              }],
            },
            finish_reason: null,
          }],
        });
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      const delta = getTextDelta(event);
      if (delta && currentToolIndex >= 0) {
        sseWrite(res, {
          ...openAiChunkBase(id, route.publicModelId),
          choices: [{ index: 0, delta: { tool_calls: [{ index: currentToolIndex, function: { arguments: delta } }] }, finish_reason: null }],
        });
      }
    } else if (event.type === "response.completed" || event.type === "response.done" || event.type === "response.incomplete") {
      usage = getUsage(event);
      sseWrite(res, { ...openAiChunkBase(id, route.publicModelId), choices: [{ index: 0, delta: {}, finish_reason: getFinishReason(event, hasToolCalls) }], usage });
      break;
    } else if (event.type === "error" || event.type === "response.failed") {
      const message = typeof event.message === "string" ? event.message : JSON.stringify(event);
      sseWrite(res, { error: { message, type: "codex_error" } });
      break;
    }
  }

  sseDone(res);
}

async function collectChatCompletion(route: ModelRoute, codexResponse: Response) {
  let content = "";
  let reasoningContent = "";
  let usage: ReturnType<typeof getUsage> | undefined;
  let finishReason: "stop" | "length" | "tool_calls" = "stop";
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  let currentToolIndex = -1;

  for await (const event of parseSse(codexResponse)) {
    if (event.type === "response.reasoning_summary_text.delta") {
      reasoningContent += getTextDelta(event) || "";
    } else if (event.type === "response.reasoning_summary_part.done") {
      reasoningContent += "\n\n";
    } else if (event.type === "response.output_text.delta") {
      content += getTextDelta(event) || "";
    } else if (event.type === "response.output_item.added") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        currentToolIndex += 1;
        toolCalls[currentToolIndex] = {
          id: typeof item.call_id === "string" ? item.call_id : `call_${currentToolIndex}`,
          type: "function",
          function: { name: typeof item.name === "string" ? item.name : "", arguments: "" },
        };
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      if (currentToolIndex >= 0) toolCalls[currentToolIndex].function.arguments += getTextDelta(event) || "";
    } else if (event.type === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call" && currentToolIndex >= 0 && typeof item.arguments === "string") {
        toolCalls[currentToolIndex].function.arguments = item.arguments;
      }
    } else if (event.type === "response.completed" || event.type === "response.done" || event.type === "response.incomplete") {
      usage = getUsage(event);
      finishReason = getFinishReason(event, toolCalls.length > 0);
      break;
    } else if (event.type === "error" || event.type === "response.failed") {
      throw new Error(typeof event.message === "string" ? event.message : JSON.stringify(event));
    }
  }

  const id = `chatcmpl-${randomUUID()}`;
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: route.publicModelId,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: toolCalls.length > 0 ? null : content,
        ...(reasoningContent ? { reasoning_content: reasoningContent.trim() } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
    usage,
  };
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const authError = requireLocalApiKey(req);
  if (authError) return sendError(res, 401, authError, "authentication_error");

  const body = await readJson(req) as ChatCompletionRequest;
  if (!body.model) return sendError(res, 400, "Missing model.");

  const config = loadConfig();
  const route = resolveModelRoute({ ...config, accounts: config.accounts.filter(isLoggedIn) }, body.model);
  if (!route) return sendError(res, 404, `Unknown or not-logged-in model: ${body.model}`);

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  const fallbackCacheKey = stablePromptCacheKey(`codexapiuse:chat:${route.account.id}:${route.publicModelId}`);
  const codexBody = buildCodexBody(body, route.codexModel, route.reasoning, fallbackCacheKey);
  const sessionId = typeof codexBody.prompt_cache_key === "string" ? codexBody.prompt_cache_key : fallbackCacheKey;
  const codexResponse = await fetchCodexResponses(route, codexBody, abort.signal, sessionId);
  if (!codexResponse.ok) {
    const text = await codexResponse.text().catch(() => "");
    return sendError(res, codexResponse.status, text || codexResponse.statusText || "Codex request failed", "codex_error");
  }

  if (body.stream) {
    await streamChatCompletion(res, route, codexResponse);
  } else {
    sendJson(res, 200, await collectChatCompletion(route, codexResponse));
  }
}

interface ResponsesRequest {
  model?: string;
  stream?: boolean;
  instructions?: unknown;
  input?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
  text?: unknown;
  include?: unknown;
  prompt_cache_key?: unknown;
  previous_response_id?: unknown;
}

function normalizeResponsesInput(input: unknown): unknown {
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "input_text", text: input }] }];
  }
  return input ?? [];
}

function buildCodexResponsesBody(request: ResponsesRequest, route: ModelRoute): Record<string, unknown> {
  const text = request.text && typeof request.text === "object" ? request.text : { verbosity: "low" };
  const body: Record<string, unknown> = {
    model: route.codexModel,
    store: false,
    stream: true,
    instructions: typeof request.instructions === "string" && request.instructions.trim()
      ? request.instructions
      : "You are a helpful assistant.",
    input: normalizeResponsesInput(request.input),
    text,
    include: Array.isArray(request.include) && request.include.length > 0
      ? [...new Set([...request.include, "reasoning.encrypted_content"])]
      : ["reasoning.encrypted_content"],
    tool_choice: request.tool_choice,
    parallel_tool_calls: typeof request.parallel_tool_calls === "boolean" ? request.parallel_tool_calls : true,
    reasoning: { effort: codexReasoningEffort(route.codexModel, route.reasoning), summary: "auto" },
    prompt_cache_key: typeof request.prompt_cache_key === "string"
      ? request.prompt_cache_key
      : stablePromptCacheKey(`codexapiuse:responses:${route.account.id}:${route.publicModelId}`),
    // The ChatGPT Codex SSE endpoint currently rejects previous_response_id.
    // Do not forward it; clients can still send it without breaking requests.
  };
  if (Array.isArray(request.tools) && request.tools.length > 0) body.tools = request.tools;
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  return body;
}

function sseWriteResponseEvent(res: ServerResponse, event: CodexEvent): void {
  if (typeof event.type === "string") res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function streamResponses(res: ServerResponse, codexResponse: Response): Promise<void> {
  setCommonHeaders(res);
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();
  for await (const event of parseSse(codexResponse)) {
    sseWriteResponseEvent(res, event);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

async function collectResponse(route: ModelRoute, codexResponse: Response) {
  const id = `resp_${randomUUID().replace(/-/g, "")}`;
  let responseId = id;
  let status = "completed";
  let content = "";
  let reasoning = "";
  let usage: Record<string, unknown> | undefined;
  const output: Array<Record<string, unknown>> = [];

  for await (const event of parseSse(codexResponse)) {
    if (event.type === "response.created") {
      const response = event.response as Record<string, unknown> | undefined;
      if (typeof response?.id === "string") responseId = response.id;
    } else if (event.type === "response.reasoning_summary_text.delta") {
      reasoning += getTextDelta(event) || "";
    } else if (event.type === "response.reasoning_summary_part.done") {
      reasoning += "\n\n";
    } else if (event.type === "response.output_text.delta") {
      content += getTextDelta(event) || "";
    } else if (event.type === "response.completed" || event.type === "response.done" || event.type === "response.incomplete") {
      const response = event.response as Record<string, unknown> | undefined;
      if (typeof response?.id === "string") responseId = response.id;
      if (typeof response?.status === "string") status = response.status;
      usage = response?.usage as Record<string, unknown> | undefined;
      break;
    } else if (event.type === "error" || event.type === "response.failed") {
      status = "failed";
      throw new Error(typeof event.message === "string" ? event.message : JSON.stringify(event));
    }
  }

  if (reasoning.trim()) {
    output.push({
      type: "reasoning",
      id: `rs_${randomUUID().replace(/-/g, "")}`,
      summary: [{ type: "summary_text", text: reasoning.trim() }],
    });
  }
  output.push({
    type: "message",
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: content, annotations: [] }],
  });

  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: route.publicModelId,
    output,
    usage,
  };
}

async function handleResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const authError = requireLocalApiKey(req);
  if (authError) return sendError(res, 401, authError, "authentication_error");

  const body = await readJson(req) as ResponsesRequest;
  if (!body.model) return sendError(res, 400, "Missing model.");

  const config = loadConfig();
  const route = resolveModelRoute({ ...config, accounts: config.accounts.filter(isLoggedIn) }, body.model);
  if (!route) return sendError(res, 404, `Unknown or not-logged-in model: ${body.model}`);

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  const codexBody = buildCodexResponsesBody(body, route);
  const sessionId = typeof codexBody.prompt_cache_key === "string" ? codexBody.prompt_cache_key : undefined;
  const codexResponse = await fetchCodexResponses(route, codexBody, abort.signal, sessionId);
  if (!codexResponse.ok) {
    const text = await codexResponse.text().catch(() => "");
    return sendError(res, codexResponse.status, text || codexResponse.statusText || "Codex request failed", "codex_error");
  }

  if (body.stream) {
    await streamResponses(res, codexResponse);
  } else {
    sendJson(res, 200, await collectResponse(route, codexResponse));
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    setCommonHeaders(res);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return sendJson(res, 200, { ok: true, name: "codexapiuse" });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const authError = requireLocalApiKey(req);
      if (authError) return sendError(res, 401, authError, "authentication_error");
      return sendJson(res, 200, listModels());
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return await handleChatCompletions(req, res);
    }
    if (req.method === "POST" && url.pathname === "/v1/responses") {
      return await handleResponses(req, res);
    }
    return sendError(res, 404, `No route for ${req.method} ${url.pathname}`);
  } catch (error) {
    if (!res.headersSent) {
      sendError(res, 500, error instanceof Error ? error.message : String(error), "server_error");
    } else {
      res.end();
    }
  }
}

export function serve(options: ServeOptions): void {
  const server = createServer((req, res) => void handleRequest(req, res));
  server.listen(options.port, options.host, () => {
    console.log(`codexapiuse listening on http://${options.host}:${options.port}`);
    console.log("OpenAI-compatible endpoints:");
    console.log(`  GET  http://${options.host}:${options.port}/v1/models`);
    console.log(`  POST http://${options.host}:${options.port}/v1/chat/completions`);
    console.log(`  POST http://${options.host}:${options.port}/v1/responses`);
    if (process.env.CODEXAPIUSE_API_KEY) console.log("Local API key protection: enabled");
  });
}
