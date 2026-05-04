import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { Account } from "./types.js";
import { updateAccount } from "./config.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";

export interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
  email?: string;
  planType?: string;
}

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function createAuthUrl(state: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  // Match the working Codex OAuth flow used by pi/Codex-style clients.
  url.searchParams.set("originator", "pi");
  return url.toString();
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function tokenMetadata(access: string): { accountId: string; email?: string; planType?: string } {
  const payload = decodeJwtPayload(access);
  const auth = payload[JWT_AUTH_CLAIM] as Record<string, unknown> | undefined;
  const profile = payload[JWT_PROFILE_CLAIM] as Record<string, unknown> | undefined;
  const accountId = auth?.chatgpt_account_id;
  if (typeof accountId !== "string" || !accountId) {
    throw new Error("Could not extract chatgpt_account_id from access token.");
  }
  return {
    accountId,
    email: typeof profile?.email === "string" ? profile.email : undefined,
    planType: typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
  };
}

function parseAuthorizationInput(raw: string): { code?: string; state?: string } {
  const value = raw.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {}
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
  }
  return { code: value };
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // Showing the URL is enough for terminal-first usage.
  }
}

function startCallbackServer(expectedState: string): Promise<{ server: Server; codePromise: Promise<string> }> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost:1455");
    if (url.pathname !== "/auth/callback") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (state !== expectedState) {
      res.statusCode = 400;
      res.end("State mismatch. Return to the terminal.");
      rejectCode(new Error("OAuth state mismatch"));
      return;
    }
    if (!code) {
      res.statusCode = 400;
      res.end("Missing code. Return to the terminal.");
      rejectCode(new Error("OAuth callback missing code"));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<h1>codexapiuse login complete</h1><p>You can close this tab.</p>");
    resolveCode(code);
  });

  return new Promise((resolve) => {
    server.once("error", (error) => {
      console.warn(`Could not listen on localhost:1455 (${error instanceof Error ? error.message : String(error)}). Use manual paste.`);
      resolve({ server, codePromise: new Promise<string>(() => {}) });
    });
    server.listen(1455, "127.0.0.1", () => resolve({ server, codePromise }));
  });
}

async function exchangeCode(code: string, verifier: string): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  }
  const json = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("Token exchange response did not contain access_token, refresh_token, and expires_in.");
  }
  const meta = tokenMetadata(json.access_token);
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    ...meta,
  };
}

export async function refreshCredentials(refreshToken: string): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`);
  }
  const json = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("Token refresh response did not contain access_token, refresh_token, and expires_in.");
  }
  const meta = tokenMetadata(json.access_token);
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    ...meta,
  };
}

export async function loginAccount(account: Account): Promise<Account> {
  const { verifier, challenge } = await generatePKCE();
  const state = randomUUID();
  const url = createAuthUrl(state, challenge);
  const { server, codePromise } = await startCallbackServer(state);

  console.log(`\nOpen this URL to login account ${account.id} (${account.name}):\n`);
  console.log(url);
  console.log("\nWaiting for browser callback on http://localhost:1455/auth/callback");
  console.log("If needed, paste the full callback URL or code below and press Enter.\n");
  openBrowser(url);

  const rl = createInterface({ input, output });
  const manualPromise = rl.question("code/callback URL> ").then((answer) => {
    const parsed = parseAuthorizationInput(answer);
    if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch in pasted input.");
    if (!parsed.code) throw new Error("No authorization code found in pasted input.");
    return parsed.code;
  });

  try {
    const code = await Promise.race([codePromise, manualPromise]);
    const credentials = await exchangeCode(code, verifier);
    const updated: Account = {
      ...account,
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
      accountId: credentials.accountId,
      updatedAt: new Date().toISOString(),
    };
    updateAccount(updated);
    if (credentials.email || credentials.planType) {
      console.log(`Logged in as ${credentials.email ?? "unknown email"}${credentials.planType ? ` (${credentials.planType})` : ""}.`);
    }
    return updated;
  } finally {
    rl.close();
    try { server.close(); } catch {}
  }
}
