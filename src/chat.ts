import { createHash } from "node:crypto";
import { codexReasoningEffort } from "./models.js";
import type { ChatCompletionRequest, ChatMessage, ReasoningEffort } from "./types.js";

type ResponseInput = Array<Record<string, unknown>>;

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
  const input: ResponseInput = [];
  let assistantMessageIndex = 0;
  let functionCallIndex = 0;

  for (const message of messages) {
    if (message.role === "user") {
      input.push({
        role: "user",
        content: [{ type: "input_text", text: textFromContent(message.content) }],
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
        input.push({
          type: "function_call",
          id: `fc_${functionCallIndex++}`,
          call_id: toolCall.id || `call_${functionCallIndex}`,
          name,
          arguments: toolCall.function?.arguments || "{}",
        });
      }
    } else if (message.role === "tool") {
      if (!message.tool_call_id) continue;
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: textFromContent(message.content),
      });
    }
  }

  return input;
}

export function chatToolsToResponsesTools(tools: ChatCompletionRequest["tools"]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .filter((tool) => tool.type === "function" && tool.function?.name)
    .map((tool) => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description || "",
      parameters: tool.function.parameters || { type: "object", properties: {} },
      strict: tool.function.strict ?? null,
    }));
}

export function stablePromptCacheKey(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

export function buildCodexBody(request: ChatCompletionRequest, codexModel: string, reasoning: ReasoningEffort, fallbackPromptCacheKey?: string): Record<string, unknown> {
  const split = splitInstructions(request.messages || []);
  const body: Record<string, unknown> = {
    model: codexModel,
    store: false,
    stream: true,
    instructions: split.instructions || "You are a helpful assistant.",
    input: chatMessagesToResponsesInput(split.messages),
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    tool_choice: request.tools && request.tools.length > 0 ? "auto" : undefined,
    parallel_tool_calls: true,
    reasoning: { effort: codexReasoningEffort(codexModel, reasoning), summary: "auto" },
    prompt_cache_key: typeof request.prompt_cache_key === "string" ? request.prompt_cache_key : fallbackPromptCacheKey,
  };

  // ChatGPT Codex /backend-api/codex/responses rejects common chat-only knobs
  // like temperature and max_output_tokens. Treat them as client-side compatibility
  // fields and do not forward them upstream.
  // Keep max_tokens as a client-side compatibility field only for now.
  const tools = chatToolsToResponsesTools(request.tools);
  if (tools) body.tools = tools;

  // Remove undefined keys; the Codex backend is stricter than normal JSON APIs.
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  return body;
}
