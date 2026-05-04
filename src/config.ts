import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Account, ConfigFile, ReasoningEffort } from "./types.js";
import { DEFAULT_CODEX_MODELS, DEFAULT_REASONING_LEVELS } from "./models.js";

const DEFAULT_CONFIG: ConfigFile = {
  version: 1,
  nextId: 1,
  accounts: [],
  routes: {},
  defaults: {
    models: [...DEFAULT_CODEX_MODELS],
    reasoning: [...DEFAULT_REASONING_LEVELS],
  },
};

export function defaultConfig(): ConfigFile {
  return {
    ...DEFAULT_CONFIG,
    accounts: [],
    routes: {},
    defaults: {
      ...DEFAULT_CONFIG.defaults,
      models: [...DEFAULT_CONFIG.defaults.models],
      reasoning: [...DEFAULT_CONFIG.defaults.reasoning],
    },
  };
}

export function configDir(): string {
  return process.env.CODEXAPIUSE_HOME || join(homedir(), ".codexapiuse");
}

export function configPath(): string {
  return join(configDir(), "accounts.json");
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function normalizeReasoning(value: unknown): ReasoningEffort[] {
  const allowed = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);
  if (!Array.isArray(value)) return [...DEFAULT_CONFIG.defaults.reasoning];
  const levels = value.filter((item): item is ReasoningEffort => typeof item === "string" && allowed.has(item as ReasoningEffort));
  const unique = [...new Set(levels)];
  // Migrate the original MVP default to the expanded pi-style set.
  if (unique.join(",") === "low,medium,high") return [...DEFAULT_CONFIG.defaults.reasoning];
  return unique.length > 0 ? unique : [...DEFAULT_CONFIG.defaults.reasoning];
}

function normalizeStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const list = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  return list.length > 0 ? [...new Set(list)] : [...fallback];
}

export function loadConfig(): ConfigFile {
  const path = configPath();
  if (!existsSync(path)) return defaultConfig();
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ConfigFile>;
  return {
    version: 1,
    nextId: typeof raw.nextId === "number" && raw.nextId > 0 ? raw.nextId : 1,
    accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
    routes: raw.routes && typeof raw.routes === "object" && !Array.isArray(raw.routes) ? raw.routes : {},
    defaults: {
      models: normalizeStringList(raw.defaults?.models, DEFAULT_CONFIG.defaults.models),
      reasoning: normalizeReasoning(raw.defaults?.reasoning),
    },
  };
}

export function saveConfig(config: ConfigFile): void {
  const path = configPath();
  ensureDir(path);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch {}
}

export function findAccount(config: ConfigFile, idOrName: string | number | undefined): Account | undefined {
  if (idOrName === undefined) return undefined;
  const value = String(idOrName);
  const numeric = Number(value);
  if (Number.isInteger(numeric)) {
    const byId = config.accounts.find((a) => a.id === numeric);
    if (byId) return byId;
  }
  return config.accounts.find((a) => a.name === value);
}

export function requireAccount(config: ConfigFile, idOrName: string | number | undefined): Account {
  const account = findAccount(config, idOrName);
  if (!account) {
    const suffix = idOrName !== undefined ? `: ${idOrName}` : "";
    throw new Error(`Account not found${suffix}. Run \"codexapiuse list\".`);
  }
  return account;
}

export function addAccount(name: string): Account {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Account name is required.");
  const config = loadConfig();
  if (config.accounts.some((a) => a.name === trimmed)) {
    throw new Error(`Account name already exists: ${trimmed}`);
  }
  const now = new Date().toISOString();
  const account: Account = {
    id: config.nextId,
    name: trimmed,
    createdAt: now,
    updatedAt: now,
  };
  config.nextId += 1;
  config.accounts.push(account);
  saveConfig(config);
  return account;
}

export function updateAccount(updated: Account): void {
  const config = loadConfig();
  const idx = config.accounts.findIndex((a) => a.id === updated.id);
  if (idx < 0) throw new Error(`Account not found: ${updated.id}`);
  config.accounts[idx] = { ...updated, updatedAt: new Date().toISOString() };
  saveConfig(config);
}

export function removeAccount(idOrName: string): Account {
  const config = loadConfig();
  const account = requireAccount(config, idOrName);
  config.accounts = config.accounts.filter((a) => a.id !== account.id);
  saveConfig(config);
  return account;
}

export function isLoggedIn(account: Account): boolean {
  return Boolean(account.access && account.refresh && account.expires && account.accountId);
}
