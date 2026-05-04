#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { addAccount, configDir, configPath, isLoggedIn, loadConfig, removeAccount, requireAccount, saveConfig } from "./config.js";
import { loginAccount } from "./oauth.js";
import { allModelRoutes, modelIdsForAccount, sanitizeModelIdPart } from "./models.js";
import { serve } from "./server.js";
import { summarizeCodexUsage } from "./usage.js";
import type { Account } from "./types.js";

function help(): void {
  console.log(`codexapiuse - terminal-first Codex OAuth accounts + local OpenAI-compatible API

Usage:
  codexapiuse add <name>            Add a named Codex account slot
  codexapiuse list                  List accounts and current usage
  codexapiuse models                Print model IDs only
  codexapiuse login [id|name]       Login selected account through ChatGPT OAuth
  codexapiuse remove <id|name>      Remove an account from local config
  codexapiuse serve [options]       Start local OpenAI-compatible API server
  codexapiuse serve bg [options]    Start API server in the background
  codexapiuse status                Show background server status
  codexapiuse stop                  Stop background server
  codexapiuse config                Create/migrate config and print accounts.json path
  codexapiuse doctor                Check config, aliases, and background server health
  codexapiuse limits                Alias for list

Serve options:
  --host <host>                     Default: 127.0.0.1
  --port <port>                     Default: 3145

Environment:
  CODEXAPIUSE_HOME                  Config directory. Default: ~/.codexapiuse
  CODEXAPIUSE_API_KEY               Optional local API key required by /v1/* endpoints

Factory/custom OpenAI endpoint:
  Base URL: http://127.0.0.1:3145/v1
  Models:   <account-name>-<codex-model>-low|medium|high

Edit accounts.json routes to add custom aliases, e.g.
  "norm-gpt-5.5-low": { "account": "norms", "model": "gpt-5.5", "reasoning": "low" }

Config file:
  ${configPath()}`);
}

async function formatAccount(account: Account): Promise<string> {
  const status = isLoggedIn(account) ? "logged in" : "not logged in";
  const expires = account.expires ? new Date(account.expires).toLocaleString() : "-";
  const lines = [`${account.id}. ${account.name}  [${status}]  expires: ${expires}`];
  if (!isLoggedIn(account)) return lines.join("\n");
  try {
    const usage = await summarizeCodexUsage(account);
    lines.push(`   ${usage.fiveHour}`);
    lines.push(`   ${usage.weekly}`);
  } catch (error) {
    lines.push(`   usage: unavailable · ${error instanceof Error ? error.message : String(error)}`);
  }
  return lines.join("\n");
}

async function mapChunks<T, R>(items: T[], chunkSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    results.push(...await Promise.all(items.slice(i, i + chunkSize).map(fn)));
  }
  return results;
}

async function cmdList(): Promise<void> {
  const config = loadConfig();
  if (config.accounts.length === 0) {
    console.log("No accounts yet. Add one with: codexapiuse add <name>");
    return;
  }
  console.log(`Config: ${configPath()}\n`);
  const formatted = await mapChunks(config.accounts, 3, formatAccount);
  console.log(formatted.join("\n\n"));
}

function cmdModels(): void {
  const config = loadConfig();
  const routes = allModelRoutes({ ...config, accounts: config.accounts.filter(isLoggedIn) });
  for (const route of routes) console.log(route.publicModelId);
}

async function selectAccount(accounts: Account[]): Promise<Account | undefined> {
  if (accounts.length === 0) return undefined;
  if (accounts.length === 1) return accounts[0];
  console.log("Select account:");
  for (const account of accounts) {
    console.log(`  ${account.id}. ${account.name}${isLoggedIn(account) ? " [logged in]" : ""}`);
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("id/name> ");
    const numeric = Number(answer.trim());
    if (Number.isInteger(numeric)) return accounts.find((a) => a.id === numeric);
    return accounts.find((a) => a.name === answer.trim());
  } finally {
    rl.close();
  }
}

async function cmdLogin(idOrName?: string): Promise<void> {
  const beforeConfig = loadConfig();
  if (beforeConfig.accounts.length === 0) {
    console.log("No accounts yet. Add one with: codexapiuse add <name>");
    return;
  }
  const account = idOrName ? requireAccount(beforeConfig, idOrName) : await selectAccount(beforeConfig.accounts);
  if (!account) throw new Error("No account selected.");
  const updated = await loginAccount(account);
  console.log(`\nLogged in account ${updated.id} (${updated.name}).`);
  console.log("Available model IDs:");
  const config = loadConfig();
  for (const model of modelIdsForAccount(updated, config.defaults)) console.log(`  ${model}`);
}

function cmdAdd(name: string | undefined): void {
  if (!name) throw new Error("Usage: codexapiuse add <name>");
  const account = addAccount(name);
  console.log(`Added account ${account.id} (${account.name}).`);
  console.log(`Login with: codexapiuse login ${account.id}`);
  console.log("Future model IDs after login:");
  const config = loadConfig();
  for (const model of modelIdsForAccount(account, config.defaults)) console.log(`  ${model}`);
}

function cmdRemove(idOrName: string | undefined): void {
  if (!idOrName) throw new Error("Usage: codexapiuse remove <id|name>");
  const removed = removeAccount(idOrName);
  console.log(`Removed account ${removed.id} (${removed.name}).`);
}

function valueAfter(args: string[], flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  if (idx < 0) return fallback;
  return args[idx + 1] || fallback;
}

interface DaemonState {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  logPath: string;
  command: string[];
}

function daemonStatePath(): string {
  return join(configDir(), "server.json");
}

function daemonLogPath(): string {
  return join(configDir(), "server.log");
}

function ensureConfigDir(): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
}

function readDaemonState(): DaemonState | undefined {
  const path = daemonStatePath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonState>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
    if (typeof parsed.host !== "string" || typeof parsed.port !== "number") return undefined;
    return {
      pid: parsed.pid,
      host: parsed.host,
      port: parsed.port,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      logPath: typeof parsed.logPath === "string" ? parsed.logPath : daemonLogPath(),
      command: Array.isArray(parsed.command) ? parsed.command.filter((item): item is string => typeof item === "string") : [],
    };
  } catch {
    return undefined;
  }
}

function writeDaemonState(state: DaemonState): void {
  ensureConfigDir();
  writeFileSync(daemonStatePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function clearDaemonState(): void {
  try { unlinkSync(daemonStatePath()); } catch {}
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function parseServeOptions(args: string[]): { host: string; port: number } {
  const host = valueAfter(args, "--host", process.env.HOST || "127.0.0.1");
  const portRaw = valueAfter(args, "--port", process.env.PORT || "3145");
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid port: ${portRaw}`);
  return { host, port };
}

function cmdStatus(): void {
  const state = readDaemonState();
  if (!state) {
    console.log("codexapiuse server is not running in the background.");
    return;
  }
  if (!isProcessRunning(state.pid)) {
    clearDaemonState();
    console.log("codexapiuse server is not running in the background. Removed stale status file.");
    return;
  }
  console.log(`codexapiuse server is running.`);
  console.log(`PID: ${state.pid}`);
  console.log(`URL: http://${state.host}:${state.port}`);
  console.log(`Log: ${state.logPath}`);
  if (state.startedAt) console.log(`Started: ${new Date(state.startedAt).toLocaleString()}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function cmdServeBg(args: string[]): Promise<void> {
  const existing = readDaemonState();
  if (existing && isProcessRunning(existing.pid)) {
    throw new Error(`Background server is already running on http://${existing.host}:${existing.port} (PID ${existing.pid}).`);
  }
  if (!process.argv[1]) throw new Error("Could not determine CLI entrypoint.");
  clearDaemonState();
  ensureConfigDir();
  const { host, port } = parseServeOptions(args);
  const logPath = daemonLogPath();
  const logFd = openSync(logPath, "a", 0o600);
  const childArgs = [process.argv[1], "serve", ...args];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  closeSync(logFd);
  writeDaemonState({
    pid: child.pid || 0,
    host,
    port,
    startedAt: new Date().toISOString(),
    logPath,
    command: [process.execPath, ...childArgs],
  });
  await sleep(350);
  const state = readDaemonState();
  if (!state || !isProcessRunning(state.pid)) {
    clearDaemonState();
    throw new Error(`Background server failed to start. Check log: ${logPath}`);
  }
  console.log(`Started codexapiuse server in the background.`);
  console.log(`PID: ${state.pid}`);
  console.log(`URL: http://${host}:${port}`);
  console.log(`Log: ${logPath}`);
}

async function cmdStop(): Promise<void> {
  const state = readDaemonState();
  if (!state) {
    console.log("codexapiuse server is not running in the background.");
    return;
  }
  if (!isProcessRunning(state.pid)) {
    clearDaemonState();
    console.log("codexapiuse server was not running. Removed stale status file.");
    return;
  }
  process.kill(state.pid, "SIGTERM");
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    if (!isProcessRunning(state.pid)) {
      clearDaemonState();
      console.log(`Stopped codexapiuse server (PID ${state.pid}).`);
      return;
    }
  }
  throw new Error(`Server did not stop after SIGTERM. PID: ${state.pid}`);
}

async function cmdServe(args: string[]): Promise<void> {
  if (args[0] === "bg" || args[0] === "background") {
    await cmdServeBg(args.slice(1));
    return;
  }
  const { host, port } = parseServeOptions(args);
  serve({ host, port });
}

function cmdConfig(): void {
  const config = loadConfig();
  saveConfig(config);
  console.log(configPath());
  console.log("Edit routes/defaults in this accounts.json file to customize exposed model IDs.");
}

type DoctorLevel = "ok" | "warning" | "error";

interface DoctorFinding {
  level: DoctorLevel;
  message: string;
}

function printFinding(finding: DoctorFinding): void {
  const label = finding.level === "ok" ? "OK" : finding.level === "warning" ? "WARN" : "ERROR";
  console.log(`[${label}] ${finding.message}`);
}

async function checkServerHealth(state: DaemonState | undefined): Promise<DoctorFinding> {
  if (!state) return { level: "warning", message: "Background server is not running." };
  if (!isProcessRunning(state.pid)) {
    clearDaemonState();
    return { level: "warning", message: "Background server status was stale and has been cleared." };
  }
  try {
    const response = await fetch(`http://${state.host}:${state.port}/health`, { signal: AbortSignal.timeout(1000) });
    if (response.ok) return { level: "ok", message: `Background server is reachable at http://${state.host}:${state.port}.` };
    return { level: "warning", message: `Background server responded with HTTP ${response.status}.` };
  } catch (error) {
    return { level: "warning", message: `Background server is running but health check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function cmdDoctor(): Promise<void> {
  const findings: DoctorFinding[] = [];
  const config = loadConfig();
  findings.push({ level: "ok", message: `Config loaded: ${configPath()}` });

  if (config.accounts.length === 0) {
    findings.push({ level: "warning", message: "No accounts configured. Add one with: cau add <name>" });
  } else {
    findings.push({ level: "ok", message: `${config.accounts.length} account(s) configured.` });
  }

  const prefixes = new Map<string, string>();
  const generatedModelIds = new Map<string, string>();
  for (const account of config.accounts) {
    const prefix = sanitizeModelIdPart(account.name);
    if (!prefix) {
      findings.push({ level: "error", message: `Account ${account.id} (${account.name}) cannot produce valid model IDs.` });
      continue;
    }
    const existing = prefixes.get(prefix);
    if (existing) {
      findings.push({ level: "error", message: `Accounts "${existing}" and "${account.name}" share model alias prefix "${prefix}".` });
    } else {
      prefixes.set(prefix, account.name);
    }
    for (const modelId of modelIdsForAccount(account, config.defaults)) {
      const previous = generatedModelIds.get(modelId);
      if (previous) {
        findings.push({ level: "error", message: `Generated model ID collision: "${modelId}" from "${previous}" and "${account.name}".` });
      } else {
        generatedModelIds.set(modelId, account.name);
      }
    }
  }

  for (const routeId of Object.keys(config.routes || {})) {
    if (generatedModelIds.has(routeId)) {
      findings.push({ level: "warning", message: `Custom route "${routeId}" is shadowed by an account-name model ID.` });
    }
  }

  const loggedInAccounts = config.accounts.filter(isLoggedIn);
  if (loggedInAccounts.length === 0) {
    findings.push({ level: "warning", message: "No logged-in accounts; /v1/models will be empty." });
  } else {
    const modelCount = allModelRoutes({ ...config, accounts: loggedInAccounts }).length;
    findings.push({ level: "ok", message: `${loggedInAccounts.length} logged-in account(s), ${modelCount} exposed model ID(s).` });
  }

  findings.push(await checkServerHealth(readDaemonState()));
  for (const finding of findings) printFinding(finding);
  if (findings.some((finding) => finding.level === "error")) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      help();
      return;
    case "add":
      cmdAdd(args.join(" ").trim());
      return;
    case "list":
    case "ls":
      await cmdList();
      return;
    case "models":
      cmdModels();
      return;
    case "login":
      await cmdLogin(args[0]);
      return;
    case "remove":
    case "rm":
      cmdRemove(args[0]);
      return;
    case "serve":
      await cmdServe(args);
      return;
    case "status":
      cmdStatus();
      return;
    case "stop":
      await cmdStop();
      return;
    case "config":
      cmdConfig();
      return;
    case "doctor":
    case "check":
      await cmdDoctor();
      return;
    case "limits":
    case "limit":
      await cmdList();
      return;
    default:
      throw new Error(`Unknown command: ${command}. Run codexapiuse help.`);
  }
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
