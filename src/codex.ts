import type { Account, ModelRoute } from "./types.js";
import { updateAccount } from "./config.js";
import { refreshCredentials } from "./oauth.js";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

export interface CodexEvent {
  type?: string;
  [key: string]: unknown;
}

function decodeAccountId(access: string): string | undefined {
  const [, payload] = access.split(".");
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = json[JWT_AUTH_CLAIM] as Record<string, unknown> | undefined;
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

export async function ensureFreshAccount(account: Account): Promise<Account> {
  if (!account.refresh) throw new Error(`Account ${account.id} (${account.name}) is not logged in.`);
  const refreshSkewMs = 60_000;
  if (account.access && account.expires && Date.now() < account.expires - refreshSkewMs) {
    return account;
  }
  const next = await refreshCredentials(account.refresh);
  const updated: Account = {
    ...account,
    access: next.access,
    refresh: next.refresh,
    expires: next.expires,
    accountId: next.accountId,
    updatedAt: new Date().toISOString(),
  };
  updateAccount(updated);
  return updated;
}

function codexUrl(baseUrl = DEFAULT_CODEX_BASE_URL): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function codexHeaders(account: Account, sessionId?: string): Headers {
  if (!account.access) throw new Error(`Account ${account.id} (${account.name}) is missing an access token.`);
  const accountId = account.accountId || decodeAccountId(account.access);
  if (!accountId) throw new Error(`Account ${account.id} (${account.name}) is missing chatgpt account id.`);

  const headers = new Headers();
  headers.set("authorization", `Bearer ${account.access}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "pi");
  headers.set("openai-beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  headers.set("user-agent", `codexapiuse/0.1 (${process.platform}; ${process.arch})`);
  if (sessionId) {
    headers.set("session_id", sessionId);
    headers.set("x-client-request-id", sessionId);
    headers.set("conversation_id", sessionId);
  }
  return headers;
}

function isRetryableCodexStatus(status: number, errorText: string): boolean {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request was aborted"));
      return;
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error("Request was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchCodexResponses(route: ModelRoute, body: Record<string, unknown>, signal?: AbortSignal, sessionId?: string): Promise<Response> {
  let account = await ensureFreshAccount(route.account);
  const bodyJson = JSON.stringify(body);
  let didAuthRefresh = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response = await fetch(codexUrl(), {
      method: "POST",
      headers: codexHeaders(account, sessionId),
      body: bodyJson,
      signal,
    });

    // One explicit refresh/retry on auth failure. No smart account rotation.
    if ((response.status === 401 || response.status === 403) && account.refresh && !didAuthRefresh) {
      didAuthRefresh = true;
      const next = await refreshCredentials(account.refresh);
      account = { ...account, access: next.access, refresh: next.refresh, expires: next.expires, accountId: next.accountId };
      updateAccount(account);
      response = await fetch(codexUrl(), {
        method: "POST",
        headers: codexHeaders(account, sessionId),
        body: bodyJson,
        signal,
      });
    }

    if (response.ok || attempt === MAX_RETRIES) return response;

    const text = await response.clone().text().catch(() => "");
    if (!isRetryableCodexStatus(response.status, text)) return response;
    await sleep(BASE_RETRY_DELAY_MS * 2 ** attempt, signal);
  }

  throw new Error("Codex request failed after retries.");
}

class CodexProtocolError extends Error {
  constructor(message: string, readonly payload?: unknown) {
    super(message);
    this.name = "CodexProtocolError";
  }
}

export async function* parseSse(response: Response): AsyncGenerator<CodexEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();
        if (data && data !== "[DONE]") {
          try {
            yield JSON.parse(data) as CodexEvent;
          } catch (error) {
            throw new CodexProtocolError(`Invalid Codex SSE JSON: ${error instanceof Error ? error.message : String(error)}`, data);
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}
