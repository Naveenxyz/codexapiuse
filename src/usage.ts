import type { Account } from "./types.js";
import { ensureFreshAccount } from "./codex.js";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

interface UsageWindow {
  used_percent?: number;
  reset_at?: number;
  limit_window_seconds?: number;
}

interface CodexUsageResponse {
  email?: string;
  rate_limit?: {
    primary_window?: UsageWindow;
    secondary_window?: UsageWindow;
  };
}

export interface AccountUsageSummary {
  label: string;
  fiveHour: string;
  weekly: string;
}

function fmtReset(timestamp: number | undefined): string {
  if (!timestamp) return "unknown";
  return new Date(timestamp * 1000).toLocaleString();
}

function fmtRemaining(timestamp: number | undefined): string {
  if (!timestamp) return "unknown";
  const seconds = Math.floor(timestamp - Date.now() / 1000);
  if (seconds <= 0) return "now";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes && parts.length < 2) parts.push(`${minutes}m`);
  return parts.length ? parts.join(" ") : "<1m";
}

function percentLeft(usedPercent: number | undefined): string {
  if (typeof usedPercent !== "number") return "?";
  return String(Math.max(0, 100 - Math.round(usedPercent)));
}

function formatWindow(label: string, win: UsageWindow | undefined): string {
  if (!win) return `${label}: unavailable`;
  return `${label}: ${percentLeft(win.used_percent)}% left · resets in ${fmtRemaining(win.reset_at)} · ${fmtReset(win.reset_at)}`;
}

async function callUsage(account: Account): Promise<CodexUsageResponse> {
  const fresh = await ensureFreshAccount(account);
  if (!fresh.access) throw new Error("missing access token");
  const headers = new Headers();
  headers.set("authorization", `Bearer ${fresh.access}`);
  headers.set("accept", "application/json");
  headers.set("user-agent", `codexapiuse/0.1 (${process.platform}; ${process.arch})`);
  if (fresh.accountId) headers.set("chatgpt-account-id", fresh.accountId);

  const response = await fetch(CODEX_USAGE_URL, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return await response.json() as CodexUsageResponse;
}

export async function summarizeCodexUsage(account: Account): Promise<AccountUsageSummary> {
  const data = await callUsage(account);
  const rateLimit = data.rate_limit || {};
  return {
    label: data.email || account.name,
    fiveHour: formatWindow("5h", rateLimit.primary_window),
    weekly: formatWindow("1w", rateLimit.secondary_window),
  };
}
