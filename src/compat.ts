export interface ToolNameMaps {
  originalToShort: Map<string, string>;
  shortToOriginal: Map<string, string>;
}

const TOOL_NAME_LIMIT = 64;

export function shortenNameIfNeeded(name: string): string {
  if (name.length <= TOOL_NAME_LIMIT) return name;
  if (name.startsWith("mcp__")) {
    const index = name.lastIndexOf("__");
    if (index > 0) {
      const candidate = `mcp__${name.slice(index + 2)}`;
      return candidate.length > TOOL_NAME_LIMIT ? candidate.slice(0, TOOL_NAME_LIMIT) : candidate;
    }
  }
  return name.slice(0, TOOL_NAME_LIMIT);
}

export function buildToolNameMaps(names: string[]): ToolNameMaps {
  const used = new Set<string>();
  const originalToShort = new Map<string, string>();
  const shortToOriginal = new Map<string, string>();

  const unique = (candidate: string): string => {
    if (!used.has(candidate)) return candidate;
    for (let i = 1; ; i++) {
      const suffix = `_${i}`;
      const prefix = candidate.slice(0, Math.max(0, TOOL_NAME_LIMIT - suffix.length));
      const next = `${prefix}${suffix}`;
      if (!used.has(next)) return next;
    }
  };

  for (const name of names) {
    const short = unique(shortenNameIfNeeded(name));
    used.add(short);
    originalToShort.set(name, short);
    shortToOriginal.set(short, name);
  }

  return { originalToShort, shortToOriginal };
}

export function toolMapsFromChatTools(tools: unknown): ToolNameMaps {
  if (!Array.isArray(tools)) return buildToolNameMaps([]);
  const names = tools
    .map((tool) => tool && typeof tool === "object" ? tool as Record<string, unknown> : undefined)
    .filter((tool): tool is Record<string, unknown> => Boolean(tool))
    .filter((tool) => tool.type === "function")
    .map((tool) => tool.function && typeof tool.function === "object" ? (tool.function as Record<string, unknown>).name : undefined)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  return buildToolNameMaps(names);
}

export function toolMapsFromResponsesTools(tools: unknown): ToolNameMaps {
  if (!Array.isArray(tools)) return buildToolNameMaps([]);
  const names = tools
    .map((tool) => tool && typeof tool === "object" ? tool as Record<string, unknown> : undefined)
    .filter((tool): tool is Record<string, unknown> => Boolean(tool))
    .filter((tool) => tool.type === "function")
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  return buildToolNameMaps(names);
}

export function shortenToolName(name: string, maps: ToolNameMaps): string {
  return maps.originalToShort.get(name) || shortenNameIfNeeded(name);
}

export function restoreToolName(name: string, maps?: ToolNameMaps): string {
  return maps?.shortToOriginal.get(name) || name;
}

export function normalizeCodexBuiltinToolType(type: string): string {
  return type === "web_search_preview" || type === "web_search_preview_2025_03_11" ? "web_search" : type;
}

export function normalizeToolChoice(choice: unknown, maps?: ToolNameMaps): unknown {
  if (typeof choice === "string") return choice;
  if (!choice || typeof choice !== "object") return choice;

  const raw = choice as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...raw };
  if (typeof normalized.type === "string") normalized.type = normalizeCodexBuiltinToolType(normalized.type);
  if (normalized.type === "function") {
    const fn = normalized.function && typeof normalized.function === "object" ? normalized.function as Record<string, unknown> : undefined;
    const name = typeof normalized.name === "string" ? normalized.name : typeof fn?.name === "string" ? fn.name : undefined;
    delete normalized.function;
    if (name) normalized.name = maps ? shortenToolName(name, maps) : shortenNameIfNeeded(name);
  }
  if (Array.isArray(normalized.tools)) {
    normalized.tools = normalized.tools.map((tool) => {
      if (!tool || typeof tool !== "object") return tool;
      const next = { ...tool as Record<string, unknown> };
      if (typeof next.type === "string") next.type = normalizeCodexBuiltinToolType(next.type);
      if (next.type === "function" && typeof next.name === "string") next.name = maps ? shortenToolName(next.name, maps) : shortenNameIfNeeded(next.name);
      return next;
    });
  }
  return normalized;
}

export function normalizeToolList(tools: unknown, maps?: ToolNameMaps, chatCompletionsShape = false): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const normalized: Array<Record<string, unknown>> = [];
  for (const rawTool of tools) {
    if (!rawTool || typeof rawTool !== "object") continue;
    const tool = rawTool as Record<string, unknown>;
    const type = typeof tool.type === "string" ? normalizeCodexBuiltinToolType(tool.type) : "";
    if (type === "function") {
      const source = chatCompletionsShape && tool.function && typeof tool.function === "object" ? tool.function as Record<string, unknown> : tool;
      const name = typeof source.name === "string" ? source.name : "";
      if (!name) continue;
      normalized.push({
        type: "function",
        name: maps ? shortenToolName(name, maps) : shortenNameIfNeeded(name),
        description: typeof source.description === "string" ? source.description : "",
        parameters: source.parameters || { type: "object", properties: {} },
        strict: source.strict ?? null,
      });
    } else if (type) {
      normalized.push({ ...tool, type });
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function responseFormatToText(responseFormat: unknown, text: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = text && typeof text === "object" && !Array.isArray(text) ? { ...text as Record<string, unknown> } : { verbosity: "low" };
  if (!responseFormat || typeof responseFormat !== "object") return result;

  const format = responseFormat as Record<string, unknown>;
  if (format.type === "text") {
    result.format = { type: "text" };
  } else if (format.type === "json_schema" && format.json_schema && typeof format.json_schema === "object") {
    const schema = format.json_schema as Record<string, unknown>;
    result.format = {
      type: "json_schema",
      ...(typeof schema.name === "string" ? { name: schema.name } : {}),
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
      ...(schema.schema ? { schema: schema.schema } : {}),
    };
  }
  return result;
}
