import { createHash } from "node:crypto";
import { normalizeToolChoice, normalizeToolList, responseFormatToText, shortenToolName, toolMapsFromChatTools } from "./compat.js";
import { codexReasoningEffort } from "./models.js";
import type { ChatCompletionRequest, ChatMessage, ReasoningEffort } from "./types.js";

type ResponseInput = Array<Record<string, unknown>>;

function imageUrlFromPart(part: Record<string, unknown>): string | undefined {
  const imageUrl = part.image_url;
  if (typeof imageUrl === "string") return imageUrl;
  if (imageUrl && typeof imageUrl === "object") {
    const url = (imageUrl as Record<string, unknown>).url;
    if (typeof url === "string") return url;
  }
  return typeof part.image_url === "string" ? part.image_url : undefined;
}

function imagePartFromPart(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const imageUrl = part.image_url && typeof part.image_url === "object" ? part.image_url as Record<string, unknown> : part;
  const out: Record<string, unknown> = { type: "input_image", detail: typeof part.detail === "string" ? part.detail : typeof imageUrl.detail === "string" ? imageUrl.detail : "auto" };
  const url = imageUrlFromPart(part);
  if (url) out.image_url = url;
  if (typeof imageUrl.file_id === "string") out.file_id = imageUrl.file_id;
  return out.image_url || out.file_id ? out : undefined;
}

function filePartFromPart(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const file = part.file && typeof part.file === "object" ? part.file as Record<string, unknown> : part;
  const out: Record<string, unknown> = { type: "input_file" };
  if (typeof file.file_id === "string") out.file_id = file.file_id;
  if (typeof file.file_data === "string") out.file_data = file.file_data;
  if (typeof file.file_url === "string") out.file_url = file.file_url;
  if (typeof file.filename === "string") out.filename = file.filename;
  return Object.keys(out).length > 1 ? out : undefined;
}

function inputContentFromContent(content: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(content)) {
    const parts: Array<Record<string, unknown>> = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push({ type: "input_text", text: part });
      } else if (part && typeof part === "object") {
        const obj = part as Record<string, unknown>;
        if ((obj.type === "text" || obj.type === "input_text") && typeof obj.text === "string") {
          parts.push({ type: "input_text", text: obj.text });
        } else if (obj.type === "image_url" || obj.type === "input_image") {
          const image = imagePartFromPart(obj);
          if (image) parts.push(image);
        } else if (obj.type === "file" || obj.type === "input_file") {
          const file = filePartFromPart(obj);
          if (file) parts.push(file);
        }
      }
    }
    return parts;
  }
  return [{ type: "input_text", text: textFromContent(content) }];
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const obj = part as Record<string, unknown>;
        if (typeof obj.text === "string") return obj.text;
        if (typeof obj.content === "string") return obj.content;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  if (content == null) return "";
  return String(content);
}

export function splitInstructions(messages: ChatMessage[] = []): { instructions?: string; messages: ChatMessage[] } {
  const instructionParts: string[] = [];
  const rest: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = textFromContent(message.content);
      if (text) instructionParts.push(text);
    } else {
      rest.push(message);
    }
  }
  return {
    instructions: instructionParts.length ? instructionParts.join("\n\n") : undefined,
    messages: rest,
  };
}

export function chatMessagesToResponsesInput(messages: ChatMessage[] = []): ResponseInput {
  return chatMessagesToResponsesInputWithToolNames(messages);
}

export function chatMessagesToResponsesInputWithToolNames(messages: ChatMessage[] = [], toolNameMaps = toolMapsFromChatTools([])): ResponseInput {
  const input: ResponseInput = [];
  let assistantMessageIndex = 0;
  let functionCallIndex = 0;

  for (const message of messages) {
    if (message.role === "user") {
      const content = inputContentFromContent(message.content);
      if (content.length === 0) continue;
      input.push({
        role: "user",
        content,
      });
    } else if (message.role === "assistant") {
      const text = textFromContent(message.content);
      if (text) {
        input.push({
          type: "message",
          id: `msg_${assistantMessageIndex++}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        });
      }
      for (const toolCall of message.tool_calls || []) {
        if (toolCall.type && toolCall.type !== "function") continue;
        const name = toolCall.function?.name;
        if (!name) continue;
        const index = functionCallIndex++;
        const [callId, itemId] = (toolCall.id || `call_${index}`).split("|", 2);
        input.push({
          type: "function_call",
          id: itemId || `fc_${index}`,
          call_id: callId,
          name: shortenToolName(name, toolNameMaps),
          arguments: toolCall.function?.arguments || "{}",
        });
      }
    } else if (message.role === "tool") {
      if (!message.tool_call_id) continue;
      const [callId] = message.tool_call_id.split("|", 1);
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: Array.isArray(message.content) ? inputContentFromContent(message.content) : textFromContent(message.content),
      });
    }
  }

  return input;
}

export function chatToolsToResponsesTools(tools: ChatCompletionRequest["tools"]): Array<Record<string, unknown>> | undefined {
  return normalizeToolList(tools, toolMapsFromChatTools(tools), true);
}

export function stablePromptCacheKey(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

export function buildCodexBody(request: ChatCompletionRequest, codexModel: string, reasoning: ReasoningEffort, fallbackPromptCacheKey?: string): Record<string, unknown> {
  const split = splitInstructions(request.messages || []);
  const toolNameMaps = toolMapsFromChatTools(request.tools);
  const tools = normalizeToolList(request.tools, toolNameMaps, true);
  const body: Record<string, unknown> = {
    model: codexModel,
    store: false,
    stream: true,
    instructions: split.instructions || "You are a helpful assistant.",
    input: chatMessagesToResponsesInputWithToolNames(split.messages, toolNameMaps),
    text: responseFormatToText(request.response_format, request.text),
    include: ["reasoning.encrypted_content"],
    tool_choice: tools ? normalizeToolChoice(request.tool_choice ?? "auto", toolNameMaps) : undefined,
    parallel_tool_calls: true,
    reasoning: { effort: codexReasoningEffort(codexModel, reasoning), summary: "auto" },
    prompt_cache_key: typeof request.prompt_cache_key === "string" ? request.prompt_cache_key : fallbackPromptCacheKey,
  };

  // ChatGPT Codex /backend-api/codex/responses rejects common chat-only knobs
  // like temperature and max_output_tokens. Treat them as client-side compatibility
  // fields and do not forward them upstream.
  // Keep max_tokens as a client-side compatibility field only for now.
  if (tools) body.tools = tools;

  // Remove undefined keys; the Codex backend is stricter than normal JSON APIs.
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  return body;
}
