import type { Account, ConfigFile, CustomRouteObject, CustomRouteValue, ModelRoute, ReasoningEffort } from "./types.js";

export const DEFAULT_CODEX_MODELS = [
  "gpt-5.1",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
] as const;

export const DEFAULT_REASONING_LEVELS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

const CODEX_MODEL_REASONING: Record<string, ReasoningEffort[]> = {
  "gpt-5.1": ["minimal", "low", "medium", "high"],
  "gpt-5.1-codex-max": ["minimal", "low", "medium", "high"],
  "gpt-5.1-codex-mini": ["minimal", "low", "medium", "high"],
  "gpt-5.2": ["minimal", "low", "medium", "high", "xhigh"],
  "gpt-5.2-codex": ["minimal", "low", "medium", "high", "xhigh"],
  "gpt-5.3-codex": ["minimal", "low", "medium", "high", "xhigh"],
  "gpt-5.3-codex-spark": ["minimal", "low", "medium", "high", "xhigh"],
  "gpt-5.4": ["minimal", "low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["minimal", "low", "medium", "high", "xhigh"],
  "gpt-5.5": ["minimal", "low", "medium", "high", "xhigh"],
};

const CODEX_REASONING_EFFORT_MAP: Record<string, Partial<Record<ReasoningEffort, ReasoningEffort>>> = {
  "gpt-5.1-codex-mini": { minimal: "medium", low: "medium", medium: "medium" },
  "gpt-5.2": { minimal: "low" },
  "gpt-5.2-codex": { minimal: "low" },
  "gpt-5.3-codex": { minimal: "low" },
  "gpt-5.3-codex-spark": { minimal: "low" },
  "gpt-5.4": { minimal: "low" },
  "gpt-5.4-mini": { minimal: "low" },
  "gpt-5.5": { minimal: "low" },
};

export function supportedReasoningForModel(model: string): ReasoningEffort[] {
  return CODEX_MODEL_REASONING[model] || [...DEFAULT_REASONING_LEVELS];
}

export function codexReasoningEffort(model: string, reasoning: ReasoningEffort): ReasoningEffort {
  return CODEX_REASONING_EFFORT_MAP[model]?.[reasoning] || reasoning;
}

export function sanitizeModelIdPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

export function validateAccountModelIdPart(name: string): string {
  const sanitized = sanitizeModelIdPart(name);
  if (!sanitized) {
    throw new Error("Account name must contain at least one letter or number.");
  }
  return sanitized;
}

function accountNameModelId(account: Pick<Account, "name">, codexModel: string, reasoning: ReasoningEffort): string {
  return `${sanitizeModelIdPart(account.name)}-${codexModel}-${reasoning}`;
}

function getDefaults(defaults?: ConfigFile["defaults"]): ConfigFile["defaults"] {
  return {
    models: defaults?.models?.length ? defaults.models : [...DEFAULT_CODEX_MODELS],
    reasoning: defaults?.reasoning?.length ? defaults.reasoning : [...DEFAULT_REASONING_LEVELS],
  };
}

export function modelIdsForAccount(account: Pick<Account, "id" | "name">, defaults?: ConfigFile["defaults"]): string[] {
  const d = getDefaults(defaults);
  const ids: string[] = [];
  for (const model of d.models) {
    const supported = new Set(supportedReasoningForModel(model));
    for (const reasoning of d.reasoning) {
      if (!supported.has(reasoning)) continue;
      const accountAlias = accountNameModelId(account, model, reasoning);
      if (!ids.includes(accountAlias)) ids.push(accountAlias);
    }
  }
  return ids;
}

function accountByRef(accounts: Account[], ref: string | number): Account | undefined {
  const value = String(ref);
  const numeric = Number(value);
  if (Number.isInteger(numeric)) {
    const byId = accounts.find((account) => account.id === numeric);
    if (byId) return byId;
  }
  return accounts.find((account) => account.name === value || sanitizeModelIdPart(account.name) === sanitizeModelIdPart(value));
}

function parseCustomRouteValue(value: CustomRouteValue): CustomRouteObject | undefined {
  if (typeof value === "string") {
    const parts = value.split(":");
    if (parts.length !== 3) return undefined;
    const [account, model, reasoning] = parts;
    return { account, model, reasoning: reasoning as ReasoningEffort };
  }
  if (!value || typeof value !== "object") return undefined;
  return value;
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function addRoute(routes: ModelRoute[], seen: Set<string>, route: ModelRoute): void {
  if (!route.publicModelId) return;
  if (seen.has(route.publicModelId)) return;
  seen.add(route.publicModelId);
  routes.push(route);
}

export function allModelRoutes(configOrAccounts: ConfigFile | Account[]): ModelRoute[] {
  const config: ConfigFile = Array.isArray(configOrAccounts)
    ? {
        version: 1,
        nextId: 1,
        accounts: configOrAccounts,
        routes: {},
        defaults: getDefaults(),
      }
    : configOrAccounts;
  const d = getDefaults(config.defaults);
  const routes: ModelRoute[] = [];
  const seen = new Set<string>();

  for (const account of config.accounts) {
    for (const model of d.models) {
      const supported = new Set(supportedReasoningForModel(model));
      for (const reasoning of d.reasoning) {
        if (!supported.has(reasoning)) continue;
        addRoute(routes, seen, {
          publicModelId: accountNameModelId(account, model, reasoning),
          account,
          codexModel: model,
          reasoning,
          source: "account-name",
        });
      }
    }
  }

  for (const [publicModelId, rawRoute] of Object.entries(config.routes || {})) {
    const parsed = parseCustomRouteValue(rawRoute);
    if (!parsed || typeof parsed.model !== "string" || typeof parsed.reasoning !== "string") continue;
    if (!isReasoningEffort(parsed.reasoning)) continue;
    const account = accountByRef(config.accounts, parsed.account);
    if (!account) continue;
    addRoute(routes, seen, {
      publicModelId,
      account,
      codexModel: parsed.model,
      reasoning: parsed.reasoning,
      source: "custom",
    });
  }

  return routes;
}

export function resolveModelRoute(configOrAccounts: ConfigFile | Account[], id: string): ModelRoute | undefined {
  return allModelRoutes(configOrAccounts).find((route) => route.publicModelId === id);
}
