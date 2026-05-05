import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { normalizeCodexBuiltinToolType, normalizeToolChoice, normalizeToolList, responseFormatToText, restoreToolName, toolMapsFromChatTools, toolMapsFromResponsesTools, type ToolNameMaps } from "./compat.js";
import { loadConfig, isLoggedIn } from "./config.js";
import { allModelRoutes, codexReasoningEffort, resolveModelRoute } from "./models.js";
import type { ChatCompletionRequest, ModelRoute } from "./types.js";
import { buildCodexBody, stablePromptCacheKey } from "./chat.js";
import { fetchCodexResponses, parseSse, type CodexEvent } from "./codex.js";

interface ServeOptions {
  host: string;
  port: number;
}

const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const requestLogInfo = new WeakMap<IncomingMessage, { model?: string; stream?: boolean }>();

class RequestBodyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
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

function isRequestLoggingEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.CODEXAPIUSE_LOG_REQUESTS ?? "");
}

function rememberRequestBody(req: IncomingMessage, body: { model?: unknown; stream?: unknown }): void {
  requestLogInfo.set(req, {
    model: typeof body.model === "string" ? body.model : undefined,
    stream: typeof body.stream === "boolean" ? body.stream : undefined,
  });
}

function formatLogValue(value: string): string {
  return JSON.stringify(value);
}

function attachRequestLogger(req: IncomingMessage, res: ServerResponse): void {
  if (!isRequestLoggingEnabled()) return;
  const started = process.hrtime.bigint();
  const url = new URL(req.url || "/", "http://localhost");
  res.once("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const info = requestLogInfo.get(req);
    const fields = [
      "request",
      `method=${req.method ?? "UNKNOWN"}`,
      `path=${formatLogValue(url.pathname)}`,
      `status=${res.statusCode}`,
      `duration_ms=${durationMs.toFixed(1)}`,
    ];
    if (info?.model) fields.push(`model=${formatLogValue(info.model)}`);
    if (typeof info?.stream === "boolean") fields.push(`stream=${info.stream}`);
    console.log(fields.join(" "));
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyError(`Request body too large. Limit is ${MAX_REQUEST_BODY_BYTES} bytes.`, 413);
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new RequestBodyError("Invalid JSON request body.", 400);
  }
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
      type: "openai",
      input: ["text", "image"],
      modalities: ["text", "image"],
      supported_input_modalities: ["text", "image"],
      supportedInputModalities: ["TEXT", "IMAGE"],
    })),
  };
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

function unknownModelMessage(model: string, candidates: string[]): string {
  let closest: string | undefined;
  let best = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(model, candidate);
    if (distance < best) {
      best = distance;
      closest = candidate;
    }
  }
  const hint = closest && best <= Math.max(4, Math.floor(model.length / 3)) ? ` Did you mean "${closest}"?` : "";
  return `Unknown or not-logged-in model: ${model}.${hint} Run "cau models" to list available model IDs.`;
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
  const usage = normalizeUsageCacheCreation(response?.usage);
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

function numberFromRecord(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number") return value;
  }
  return undefined;
}

function normalizeUsageCacheCreation(usage: unknown): Record<string, unknown> | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const out: Record<string, unknown> = { ...usage as Record<string, unknown> };
  const inputDetails = out.input_tokens_details && typeof out.input_tokens_details === "object" && !Array.isArray(out.input_tokens_details)
    ? { ...out.input_tokens_details as Record<string, unknown> }
    : undefined;
  const promptDetails = out.prompt_tokens_details && typeof out.prompt_tokens_details === "object" && !Array.isArray(out.prompt_tokens_details)
    ? { ...out.prompt_tokens_details as Record<string, unknown> }
    : undefined;
  const cacheWrite = numberFromRecord(inputDetails, ["cache_write_tokens", "cache_creation_tokens", "cache_creation_input_tokens"])
    ?? numberFromRecord(promptDetails, ["cache_write_tokens", "cache_creation_tokens", "cache_creation_input_tokens"])
    ?? numberFromRecord(out, ["cache_creation_input_tokens", "cache_write_input_tokens", "cache_write_tokens"]);
  if (cacheWrite !== undefined) {
    out.cache_creation_input_tokens = cacheWrite;
    if (inputDetails) {
      inputDetails.cache_write_tokens = cacheWrite;
      inputDetails.cache_creation_tokens = cacheWrite;
      inputDetails.cache_creation_input_tokens = cacheWrite;
      out.input_tokens_details = inputDetails;
    }
    if (promptDetails) {
      promptDetails.cache_write_tokens = cacheWrite;
      promptDetails.cache_creation_tokens = cacheWrite;
      promptDetails.cache_creation_input_tokens = cacheWrite;
      out.prompt_tokens_details = promptDetails;
    }
  }
  return out;
}

function normalizeResponseUsage(event: CodexEvent): CodexEvent {
  const response = getNestedRecord(event, "response");
  const usage = normalizeUsageCacheCreation(response?.usage);
  if (!response || !usage) return event;
  return { ...event, response: { ...response, usage } };
}

function getFinishReason(event: CodexEvent, hasToolCalls: boolean): "stop" | "length" | "tool_calls" {
  const response = getNestedRecord(event, "response");
  const status = response?.status;
  if (hasToolCalls) return "tool_calls";
  if (status === "incomplete") return "length";
  return "stop";
}

function finishReasonWithNative(event: CodexEvent, hasToolCalls: boolean): { finish_reason: "stop" | "length" | "tool_calls"; native_finish_reason: string } {
  const finish_reason = getFinishReason(event, hasToolCalls);
  return { finish_reason, native_finish_reason: finish_reason };
}

function isTerminalResponseEvent(event: CodexEvent): boolean {
  return event.type === "response.completed" || event.type === "response.done" || event.type === "response.incomplete";
}

function eventOutputIndex(event: CodexEvent): number | undefined {
  return typeof event.output_index === "number" ? event.output_index : undefined;
}

function eventItemKey(event: CodexEvent, item?: Record<string, unknown>): string | undefined {
  if (typeof item?.id === "string") return `id:${item.id}`;
  if (typeof event.item_id === "string") return `id:${event.item_id}`;
  const outputIndex = eventOutputIndex(event);
  return outputIndex === undefined ? undefined : `output:${outputIndex}`;
}

function openAiChunkBase(id: string, model: string) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
}

function mimeTypeFromOutputFormat(format: unknown): string {
  if (typeof format !== "string" || !format) return "image/png";
  if (format.includes("/")) return format;
  switch (format.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "png":
    default:
      return "image/png";
  }
}

function imageDeltaFromBase64(itemId: string, b64: string, outputFormat: unknown, seenHashes: Map<string, string>): Record<string, unknown> | undefined {
  if (!b64) return undefined;
  const hash = createHash("sha256").update(b64).digest("hex");
  if (itemId && seenHashes.get(itemId) === hash) return undefined;
  if (itemId) seenHashes.set(itemId, hash);
  const imageUrl = `data:${mimeTypeFromOutputFormat(outputFormat)};base64,${b64}`;
  return { type: "image_url", image_url: { url: imageUrl } };
}

function restoreFunctionCallName(item: Record<string, unknown>, toolNameMaps?: ToolNameMaps): Record<string, unknown> {
  if (item.type !== "function_call" || typeof item.name !== "string") return item;
  return { ...item, name: restoreToolName(item.name, toolNameMaps) };
}

function restoreResponseEventToolNames(event: CodexEvent, toolNameMaps?: ToolNameMaps): CodexEvent {
  if (!toolNameMaps) return event;
  const item = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : undefined;
  if (item?.type === "function_call") return { ...event, item: restoreFunctionCallName(item, toolNameMaps) };
  const response = event.response && typeof event.response === "object" ? event.response as Record<string, unknown> : undefined;
  if (!response || !Array.isArray(response.output)) return event;
  return {
    ...event,
    response: {
      ...response,
      output: response.output.map((outputItem) => outputItem && typeof outputItem === "object" ? restoreFunctionCallName(outputItem as Record<string, unknown>, toolNameMaps) : outputItem),
    },
  };
}

export async function streamChatCompletion(res: ServerResponse, route: ModelRoute, codexResponse: Response, toolNameMaps?: ToolNameMaps): Promise<void> {
  setCommonHeaders(res);
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const id = `chatcmpl-${randomUUID()}`;
  sseWrite(res, { ...openAiChunkBase(id, route.publicModelId), choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

  let hasToolCalls = false;
  let nextToolIndex = 0;
  let usage: ReturnType<typeof getUsage> | undefined;
  const toolStates = new Map<string, { index: number; arguments: string }>();
  let currentToolState: { index: number; arguments: string } | undefined;
  const seenImageHashes = new Map<string, string>();

  const findToolState = (event: CodexEvent, item?: Record<string, unknown>) => {
    const key = eventItemKey(event, item);
    return key ? toolStates.get(key) : currentToolState;
  };

  for await (const event of parseSse(codexResponse)) {
    if (event.type === "response.reasoning_summary_text.delta") {
      const delta = getTextDelta(event);
      if (delta) {
        sseWrite(res, { ...openAiChunkBase(id, route.publicModelId), choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }] });
      }
    } else if (event.type === "response.reasoning_summary_part.done") {
      sseWrite(res, { ...openAiChunkBase(id, route.publicModelId), choices: [{ index: 0, delta: { reasoning_content: "\n\n" }, finish_reason: null }] });
    } else if (event.type === "response.reasoning_summary_text.done") {
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
        const state = { index: nextToolIndex++, arguments: "" };
        const key = eventItemKey(event, item);
        if (key) toolStates.set(key, state);
        currentToolState = state;
        sseWrite(res, {
          ...openAiChunkBase(id, route.publicModelId),
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: state.index,
                id: typeof item.call_id === "string" ? item.call_id : `call_${state.index}`,
                type: "function",
                function: { name: typeof item.name === "string" ? restoreToolName(item.name, toolNameMaps) : "", arguments: "" },
              }],
            },
            finish_reason: null,
          }],
        });
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      const delta = getTextDelta(event);
      const state = findToolState(event);
      if (delta && state) {
        state.arguments += delta;
        sseWrite(res, {
          ...openAiChunkBase(id, route.publicModelId),
          choices: [{ index: 0, delta: { tool_calls: [{ index: state.index, function: { arguments: delta } }] }, finish_reason: null }],
        });
      }
    } else if (event.type === "response.function_call_arguments.done") {
      const item = event.item as Record<string, unknown> | undefined;
      const finalArguments = typeof event.arguments === "string"
        ? event.arguments
        : undefined;
      const state = findToolState(event, item);
      if (finalArguments !== undefined && state) {
        const previous = state.arguments;
        state.arguments = finalArguments;
        const delta = finalArguments.startsWith(previous) ? finalArguments.slice(previous.length) : "";
        if (delta) {
          sseWrite(res, {
            ...openAiChunkBase(id, route.publicModelId),
            choices: [{ index: 0, delta: { tool_calls: [{ index: state.index, function: { arguments: delta } }] }, finish_reason: null }],
          });
        }
      }
    } else if (event.type === "response.image_generation_call.partial_image") {
      const image = imageDeltaFromBase64(typeof event.item_id === "string" ? event.item_id : "", typeof event.partial_image_b64 === "string" ? event.partial_image_b64 : "", event.output_format, seenImageHashes);
      if (image) sseWrite(res, { ...openAiChunkBase(id, route.publicModelId), choices: [{ index: 0, delta: { role: "assistant", images: [image] }, finish_reason: null }] });
    } else if (event.type === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call" && typeof item.arguments === "string") {
        let state = findToolState(event, item);
        if (!state) {
          hasToolCalls = true;
          state = { index: nextToolIndex++, arguments: "" };
          const key = eventItemKey(event, item);
          if (key) toolStates.set(key, state);
          sseWrite(res, {
            ...openAiChunkBase(id, route.publicModelId),
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: state.index,
                  id: typeof item.call_id === "string" ? item.call_id : `call_${state.index}`,
                  type: "function",
                  function: { name: typeof item.name === "string" ? restoreToolName(item.name, toolNameMaps) : "", arguments: "" },
                }],
              },
              finish_reason: null,
            }],
          });
        }
        if (state) {
          const previous = state.arguments;
          state.arguments = item.arguments;
          const delta = item.arguments.startsWith(previous) ? item.arguments.slice(previous.length) : "";
          if (delta) {
            sseWrite(res, {
              ...openAiChunkBase(id, route.publicModelId),
              choices: [{ index: 0, delta: { tool_calls: [{ index: state.index, function: { arguments: delta } }] }, finish_reason: null }],
            });
          }
        }
      } else if (item?.type === "image_generation_call") {
        const image = imageDeltaFromBase64(typeof item.id === "string" ? item.id : "", typeof item.result === "string" ? item.result : "", item.output_format, seenImageHashes);
        if (image) sseWrite(res, { ...openAiChunkBase(id, route.publicModelId), choices: [{ index: 0, delta: { role: "assistant", images: [image] }, finish_reason: null }] });
      }
    } else if (isTerminalResponseEvent(event)) {
      usage = getUsage(event);
      sseWrite(res, { ...openAiChunkBase(id, route.publicModelId), choices: [{ index: 0, delta: {}, ...finishReasonWithNative(event, hasToolCalls) }], usage });
      break;
    } else if (event.type === "error" || event.type === "response.failed") {
      const message = typeof event.message === "string" ? event.message : JSON.stringify(event);
      sseWrite(res, { error: { message, type: "codex_error" } });
      break;
    }
  }

  sseDone(res);
}

export async function collectChatCompletion(route: ModelRoute, codexResponse: Response, toolNameMaps?: ToolNameMaps) {
  let content = "";
  let reasoningContent = "";
  let usage: ReturnType<typeof getUsage> | undefined;
  let finishReason: "stop" | "length" | "tool_calls" = "stop";
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  const toolStates = new Map<string, { toolCall: { id: string; type: "function"; function: { name: string; arguments: string } } }>();
  let currentToolState: { toolCall: { id: string; type: "function"; function: { name: string; arguments: string } } } | undefined;
  const images: Array<Record<string, unknown>> = [];
  const seenImageHashes = new Map<string, string>();

  const findToolState = (event: CodexEvent, item?: Record<string, unknown>) => {
    const key = eventItemKey(event, item);
    return key ? toolStates.get(key) : currentToolState;
  };

  for await (const event of parseSse(codexResponse)) {
    if (event.type === "response.reasoning_summary_text.delta") {
      reasoningContent += getTextDelta(event) || "";
    } else if (event.type === "response.reasoning_summary_part.done") {
      reasoningContent += "\n\n";
    } else if (event.type === "response.reasoning_summary_text.done") {
      reasoningContent += "\n\n";
    } else if (event.type === "response.output_text.delta") {
      content += getTextDelta(event) || "";
    } else if (event.type === "response.output_item.added") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        const toolCall: { id: string; type: "function"; function: { name: string; arguments: string } } = {
          id: typeof item.call_id === "string" ? item.call_id : `call_${toolCalls.length}`,
          type: "function",
          function: { name: typeof item.name === "string" ? restoreToolName(item.name, toolNameMaps) : "", arguments: "" },
        };
        toolCalls.push(toolCall);
        currentToolState = { toolCall };
        const key = eventItemKey(event, item);
        if (key) toolStates.set(key, currentToolState);
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      const state = findToolState(event);
      if (state) state.toolCall.function.arguments += getTextDelta(event) || "";
    } else if (event.type === "response.function_call_arguments.done") {
      const state = findToolState(event);
      if (state && typeof event.arguments === "string") state.toolCall.function.arguments = event.arguments;
    } else if (event.type === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      const state = findToolState(event, item);
      if (item?.type === "function_call" && typeof item.arguments === "string") {
        if (state) {
          state.toolCall.function.arguments = item.arguments;
        } else {
          toolCalls.push({
            id: typeof item.call_id === "string" ? item.call_id : `call_${toolCalls.length}`,
            type: "function",
            function: { name: typeof item.name === "string" ? restoreToolName(item.name, toolNameMaps) : "", arguments: item.arguments },
          });
        }
      } else if (item?.type === "image_generation_call") {
        const image = imageDeltaFromBase64(typeof item.id === "string" ? item.id : "", typeof item.result === "string" ? item.result : "", item.output_format, seenImageHashes);
        if (image) images.push(image);
      }
    } else if (event.type === "response.image_generation_call.partial_image") {
      const image = imageDeltaFromBase64(typeof event.item_id === "string" ? event.item_id : "", typeof event.partial_image_b64 === "string" ? event.partial_image_b64 : "", event.output_format, seenImageHashes);
      if (image) images.push(image);
    } else if (isTerminalResponseEvent(event)) {
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
        ...(images.length > 0 ? { images } : {}),
      },
      finish_reason: finishReason,
      native_finish_reason: finishReason,
    }],
    usage,
  };
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const authError = requireLocalApiKey(req);
  if (authError) return sendError(res, 401, authError, "authentication_error");

  const body = await readJson(req) as ChatCompletionRequest;
  rememberRequestBody(req, body);
  if (!body.model) return sendError(res, 400, "Missing model.");

  const config = loadConfig();
  const loggedInConfig = { ...config, accounts: config.accounts.filter(isLoggedIn) };
  const route = resolveModelRoute(loggedInConfig, body.model);
  if (!route) return sendError(res, 404, unknownModelMessage(body.model, allModelRoutes(loggedInConfig).map((item) => item.publicModelId)));

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  const fallbackCacheKey = stablePromptCacheKey(`codexapiuse:chat:${route.account.id}:${route.publicModelId}`);
  const toolNameMaps = toolMapsFromChatTools(body.tools);
  const codexBody = buildCodexBody(body, route.codexModel, route.reasoning, fallbackCacheKey);
  const sessionId = typeof codexBody.prompt_cache_key === "string" ? codexBody.prompt_cache_key : fallbackCacheKey;
  const codexResponse = await fetchCodexResponses(route, codexBody, abort.signal, sessionId);
  if (!codexResponse.ok) {
    const text = await codexResponse.text().catch(() => "");
    return sendError(res, codexResponse.status, text || codexResponse.statusText || "Codex request failed", "codex_error");
  }

  if (body.stream) {
    await streamChatCompletion(res, route, codexResponse, toolNameMaps);
  } else {
    sendJson(res, 200, await collectChatCompletion(route, codexResponse, toolNameMaps));
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
  response_format?: unknown;
}

function normalizeResponsesInput(input: unknown, toolNameMaps?: ToolNameMaps): unknown {
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "input_text", text: input }] }];
  }
  if (Array.isArray(input)) {
    return input.map((item) => {
      if (!item || typeof item !== "object") return item;
      const record = { ...item as Record<string, unknown> };
      if (record.role === "system") record.role = "developer";
      if (record.type === "function_call" && typeof record.name === "string" && toolNameMaps) {
        record.name = toolNameMaps.originalToShort.get(record.name) || record.name;
      }
      return record;
    });
  }
  return input ?? [];
}

export function buildCodexResponsesBody(request: ResponsesRequest, route: ModelRoute, toolNameMaps = toolMapsFromResponsesTools(request.tools)): Record<string, unknown> {
  const tools = normalizeToolList(request.tools, toolNameMaps, false);
  const toolChoice = normalizeToolChoice(request.tool_choice, toolNameMaps);
  const body: Record<string, unknown> = {
    model: route.codexModel,
    store: false,
    stream: true,
    instructions: typeof request.instructions === "string" && request.instructions.trim()
      ? request.instructions
      : "You are a helpful assistant.",
    input: normalizeResponsesInput(request.input, toolNameMaps),
    text: responseFormatToText(request.response_format, request.text),
    include: Array.isArray(request.include) && request.include.length > 0
      ? [...new Set([...request.include, "reasoning.encrypted_content"])]
      : ["reasoning.encrypted_content"],
    tool_choice: toolChoice,
    parallel_tool_calls: typeof request.parallel_tool_calls === "boolean" ? request.parallel_tool_calls : true,
    reasoning: { effort: codexReasoningEffort(route.codexModel, route.reasoning), summary: "auto" },
    prompt_cache_key: typeof request.prompt_cache_key === "string"
      ? request.prompt_cache_key
      : stablePromptCacheKey(`codexapiuse:responses:${route.account.id}:${route.publicModelId}`),
    // The ChatGPT Codex SSE endpoint currently rejects previous_response_id.
    // Do not forward it; clients can still send it without breaking requests.
  };
  if (tools) body.tools = tools;
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  return body;
}

function sseWriteResponseEvent(res: ServerResponse, event: CodexEvent): void {
  if (typeof event.type === "string") res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function streamResponses(res: ServerResponse, codexResponse: Response, toolNameMaps?: ToolNameMaps): Promise<void> {
  setCommonHeaders(res);
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();
  for await (const event of parseSse(codexResponse)) {
    sseWriteResponseEvent(res, restoreResponseEventToolNames(normalizeResponseUsage(event), toolNameMaps));
    if (isTerminalResponseEvent(event)) break;
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function messageContentFromItem(item: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = Array.isArray(item.content) ? item.content : [];
  return content.flatMap((part): Array<Record<string, unknown>> => {
    if (!part || typeof part !== "object") return [];
    const obj = part as Record<string, unknown>;
    if (obj.type === "output_text") {
      return [{
        type: "output_text",
        text: typeof obj.text === "string" ? obj.text : "",
        annotations: Array.isArray(obj.annotations) ? obj.annotations : [],
      }];
    }
    if (obj.type === "refusal") {
      return [{ type: "refusal", refusal: typeof obj.refusal === "string" ? obj.refusal : "" }];
    }
    return [];
  });
}

function appendMessageText(message: Record<string, unknown>, delta: string, type: "output_text" | "refusal"): void {
  const content = Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [];
  if (!Array.isArray(message.content)) message.content = content;
  let part = content[content.length - 1];
  if (!part || part.type !== type) {
    part = type === "output_text" ? { type, text: "", annotations: [] } : { type, refusal: "" };
    content.push(part);
  }
  const key = type === "output_text" ? "text" : "refusal";
  part[key] = `${typeof part[key] === "string" ? part[key] : ""}${delta}`;
}

function appendReasoningText(reasoning: Record<string, unknown>, delta: string): void {
  const summary = Array.isArray(reasoning.summary) ? reasoning.summary as Array<Record<string, unknown>> : [];
  if (!Array.isArray(reasoning.summary)) reasoning.summary = summary;
  let part = summary[summary.length - 1];
  if (!part || part.type !== "summary_text") {
    part = { type: "summary_text", text: "" };
    summary.push(part);
  }
  part.text = `${typeof part.text === "string" ? part.text : ""}${delta}`;
}

export async function collectResponse(route: ModelRoute, codexResponse: Response, toolNameMaps?: ToolNameMaps) {
  const id = `resp_${randomUUID().replace(/-/g, "")}`;
  let responseId = id;
  let status = "completed";
  let usage: Record<string, unknown> | undefined;
  const output: Array<Record<string, unknown>> = [];
  const outputItems = new Map<string, Record<string, unknown>>();
  let currentMessage: Record<string, unknown> | undefined;
  let currentReasoning: Record<string, unknown> | undefined;
  let currentFunctionCall: Record<string, unknown> | undefined;

  const rememberOutput = (event: CodexEvent, item: Record<string, unknown> | undefined, record: Record<string, unknown>) => {
    const key = eventItemKey(event, item);
    if (key) outputItems.set(key, record);
  };

  const findOutput = (event: CodexEvent, item: Record<string, unknown> | undefined, fallback: Record<string, unknown> | undefined) => {
    const key = eventItemKey(event, item);
    return key ? outputItems.get(key) : fallback;
  };

  const ensureMessage = (event: CodexEvent, item?: Record<string, unknown>) => {
    const existing = findOutput(event, item, currentMessage);
    if (existing?.type === "message") return existing;
    const message: Record<string, unknown> = {
      type: "message",
      id: typeof item?.id === "string" ? item.id : `msg_${randomUUID().replace(/-/g, "")}`,
      status: typeof item?.status === "string" ? item.status : "in_progress",
      role: "assistant",
      content: item ? messageContentFromItem(item) : [],
    };
    output.push(message);
    rememberOutput(event, item, message);
    currentMessage = message;
    return message;
  };

  const ensureReasoning = (event: CodexEvent, item?: Record<string, unknown>) => {
    const existing = findOutput(event, item, currentReasoning);
    if (existing?.type === "reasoning") return existing;
    const reasoning: Record<string, unknown> = {
      type: "reasoning",
      id: typeof item?.id === "string" ? item.id : `rs_${randomUUID().replace(/-/g, "")}`,
      summary: Array.isArray(item?.summary) ? item.summary : [],
    };
    output.push(reasoning);
    rememberOutput(event, item, reasoning);
    currentReasoning = reasoning;
    return reasoning;
  };

  const ensureFunctionCall = (event: CodexEvent, item?: Record<string, unknown>) => {
    const existing = findOutput(event, item, currentFunctionCall);
    if (existing?.type === "function_call") return existing;
    const functionCall: Record<string, unknown> = {
      type: "function_call",
      id: typeof item?.id === "string" ? item.id : `fc_${randomUUID().replace(/-/g, "")}`,
      call_id: typeof item?.call_id === "string" ? item.call_id : `call_${output.length}`,
      name: typeof item?.name === "string" ? restoreToolName(item.name, toolNameMaps) : "",
      arguments: typeof item?.arguments === "string" ? item.arguments : "",
    };
    output.push(functionCall);
    rememberOutput(event, item, functionCall);
    currentFunctionCall = functionCall;
    return functionCall;
  };

  const ensureGenericOutput = (event: CodexEvent, item: Record<string, unknown>) => {
    const existing = findOutput(event, item, undefined);
    if (existing) return existing;
    const record = { ...item };
    output.push(record);
    rememberOutput(event, item, record);
    return record;
  };

  for await (const event of parseSse(codexResponse)) {
    if (event.type === "response.created") {
      const response = event.response as Record<string, unknown> | undefined;
      if (typeof response?.id === "string") responseId = response.id;
    } else if (event.type === "response.output_item.added") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "reasoning") {
        ensureReasoning(event, item);
      } else if (item?.type === "message") {
        ensureMessage(event, item);
      } else if (item?.type === "function_call") {
        ensureFunctionCall(event, item);
      } else if (item?.type) {
        ensureGenericOutput(event, item);
      }
    } else if (event.type === "response.reasoning_summary_part.added") {
      const reasoning = ensureReasoning(event);
      const summary = Array.isArray(reasoning.summary) ? reasoning.summary as Array<Record<string, unknown>> : [];
      if (!Array.isArray(reasoning.summary)) reasoning.summary = summary;
      const part = event.part && typeof event.part === "object" ? event.part as Record<string, unknown> : undefined;
      summary.push({ type: "summary_text", text: typeof part?.text === "string" ? part.text : "" });
    } else if (event.type === "response.reasoning_summary_text.delta") {
      appendReasoningText(ensureReasoning(event), getTextDelta(event) || "");
    } else if (event.type === "response.reasoning_summary_part.done") {
      const item = event.item as Record<string, unknown> | undefined;
      const reasoning = ensureReasoning(event, item);
      if (Array.isArray(item?.summary)) reasoning.summary = item.summary;
      else appendReasoningText(reasoning, "\n\n");
    } else if (event.type === "response.content_part.added") {
      const part = event.part && typeof event.part === "object" ? event.part as Record<string, unknown> : undefined;
      if (part?.type === "output_text") appendMessageText(ensureMessage(event), typeof part.text === "string" ? part.text : "", "output_text");
      if (part?.type === "refusal") appendMessageText(ensureMessage(event), typeof part.refusal === "string" ? part.refusal : "", "refusal");
    } else if (event.type === "response.output_text.delta") {
      appendMessageText(ensureMessage(event), getTextDelta(event) || "", "output_text");
    } else if (event.type === "response.refusal.delta") {
      appendMessageText(ensureMessage(event), getTextDelta(event) || "", "refusal");
    } else if (event.type === "response.function_call_arguments.delta") {
      const functionCall = ensureFunctionCall(event);
      functionCall.arguments = `${typeof functionCall.arguments === "string" ? functionCall.arguments : ""}${getTextDelta(event) || ""}`;
    } else if (event.type === "response.function_call_arguments.done") {
      const functionCall = ensureFunctionCall(event);
      if (typeof event.arguments === "string") functionCall.arguments = event.arguments;
    } else if (event.type === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "reasoning") {
        const reasoning = ensureReasoning(event, item);
        if (Array.isArray(item.summary)) reasoning.summary = item.summary;
      } else if (item?.type === "message") {
        const message = ensureMessage(event, item);
        message.id = typeof item.id === "string" ? item.id : message.id;
        message.status = typeof item.status === "string" ? item.status : "completed";
        message.content = messageContentFromItem(item);
      } else if (item?.type === "function_call") {
        const functionCall = ensureFunctionCall(event, item);
        if (typeof item.id === "string") functionCall.id = item.id;
        if (typeof item.call_id === "string") functionCall.call_id = item.call_id;
        if (typeof item.name === "string") functionCall.name = restoreToolName(item.name, toolNameMaps);
        if (typeof item.arguments === "string") functionCall.arguments = item.arguments;
      } else if (item?.type) {
        const record = ensureGenericOutput(event, item);
        for (const key of Object.keys(record)) delete record[key];
        Object.assign(record, item);
      }
    } else if (isTerminalResponseEvent(event)) {
      const response = event.response as Record<string, unknown> | undefined;
      if (typeof response?.id === "string") responseId = response.id;
      if (typeof response?.status === "string") status = response.status;
      usage = normalizeUsageCacheCreation(response?.usage);
      break;
    } else if (event.type === "error" || event.type === "response.failed") {
      status = "failed";
      throw new Error(typeof event.message === "string" ? event.message : JSON.stringify(event));
    }
  }

  if (output.length === 0) {
    output.push({
      type: "message",
      id: `msg_${randomUUID().replace(/-/g, "")}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [] }],
    });
  }

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
  rememberRequestBody(req, body);
  if (!body.model) return sendError(res, 400, "Missing model.");

  const config = loadConfig();
  const loggedInConfig = { ...config, accounts: config.accounts.filter(isLoggedIn) };
  const route = resolveModelRoute(loggedInConfig, body.model);
  if (!route) return sendError(res, 404, unknownModelMessage(body.model, allModelRoutes(loggedInConfig).map((item) => item.publicModelId)));

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  const toolNameMaps = toolMapsFromResponsesTools(body.tools);
  const codexBody = buildCodexResponsesBody(body, route, toolNameMaps);
  const sessionId = typeof codexBody.prompt_cache_key === "string" ? codexBody.prompt_cache_key : undefined;
  const codexResponse = await fetchCodexResponses(route, codexBody, abort.signal, sessionId);
  if (!codexResponse.ok) {
    const text = await codexResponse.text().catch(() => "");
    return sendError(res, codexResponse.status, text || codexResponse.statusText || "Codex request failed", "codex_error");
  }

  if (body.stream) {
    await streamResponses(res, codexResponse, toolNameMaps);
  } else {
    sendJson(res, 200, await collectResponse(route, codexResponse, toolNameMaps));
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    attachRequestLogger(req, res);
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
      if (error instanceof RequestBodyError) {
        sendError(res, error.status, error.message);
      } else {
        sendError(res, 500, error instanceof Error ? error.message : String(error), "server_error");
      }
    } else {
      res.end();
    }
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function serve(options: ServeOptions): void {
  if (!process.env.CODEXAPIUSE_API_KEY && !isLoopbackHost(options.host)) {
    throw new Error("Refusing to listen on a non-loopback host without CODEXAPIUSE_API_KEY. Use --host 127.0.0.1 or set CODEXAPIUSE_API_KEY.");
  }
  const server = createServer((req, res) => void handleRequest(req, res));
  server.on("error", (error) => {
    console.error(`Server error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
  server.listen(options.port, options.host, () => {
    console.log(`codexapiuse listening on http://${options.host}:${options.port}`);
    console.log("OpenAI-compatible endpoints:");
    console.log(`  GET  http://${options.host}:${options.port}/v1/models`);
    console.log(`  POST http://${options.host}:${options.port}/v1/chat/completions`);
    console.log(`  POST http://${options.host}:${options.port}/v1/responses`);
    if (process.env.CODEXAPIUSE_API_KEY) console.log("Local API key protection: enabled");
    if (isRequestLoggingEnabled()) console.log("Request logging: enabled (CODEXAPIUSE_LOG_REQUESTS=1)");
  });
}
