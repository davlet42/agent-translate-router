import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ProviderConfig, ProviderId, DiscoveryResult } from "./types.js";

export class ProviderError extends Error {
  constructor(public readonly kind: "missing" | "auth" | "quota" | "rate_limit" | "timeout" | "unavailable" | "invalid_output" | "unknown", message: string) { super(message); }
}

interface SpawnResult { stdout: string; stderr: string; code: number | null; timedOut: boolean; }

function runProcess(command: string, args: string[], input: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    // A provider may exit after producing its response before the full prompt
    // has been flushed (common for tiny test/healthcheck commands). That is a
    // subprocess result, not a router crash.
    child.stdin.on("error", () => undefined);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 250).unref(); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ stdout, stderr: `${stderr}\n${error.message}`, code: null, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code, timedOut }); });
    child.stdin.end(input);
  });
}

function classify(message: string, timedOut = false): ProviderError["kind"] {
  if (timedOut || /timed? ?out|timeout|deadline/i.test(message)) return "timeout";
  if (/quota|limit|exhausted|too many requests|rate.?limit|429/i.test(message)) return /rate.?limit|429/i.test(message) ? "rate_limit" : "quota";
  if (/auth|login|unauthorized|forbidden|token|credential|permission/i.test(message)) return "auth";
  if (/not found|enoent|command not found/i.test(message)) return "missing";
  if (/busy|unavailable|temporarily|503|502|connection/i.test(message)) return "unavailable";
  return "unknown";
}

function childEnv(config: ProviderConfig): NodeJS.ProcessEnv {
  const { OPENAI_API_KEY: _ignored, ...safe } = process.env;
  return { ...safe, ...(config.env ?? {}), AGENT_TRANSLATE_ROUTER_ACTIVE: "1", AGENT_TRANSLATE_ROUTER_HOP: "1" };
}

export async function discoverProvider(provider: ProviderId, config: ProviderConfig, timeoutMs: number): Promise<DiscoveryResult> {
  if (config.enabled === false) return { provider, command: config.command, available: false, authenticated: "unknown", reason: "disabled" };
  const result = await runProcess(config.command, ["--version"], "", timeoutMs, childEnv(config));
  if (result.code === null) return { provider, command: config.command, available: false, authenticated: "unknown", reason: classify(result.stderr, result.timedOut) };
  if (result.timedOut || result.code !== 0) {
    const help = await runProcess(config.command, ["--help"], "", timeoutMs, childEnv(config));
    if (help.code !== 0) return { provider, command: config.command, available: false, authenticated: "unknown", reason: classify(help.stderr || help.stdout, help.timedOut) };
    return { provider, command: config.command, available: true, authenticated: "unknown", version: help.stdout.split("\n")[0] };
  }
  let authenticated: DiscoveryResult["authenticated"] = "unknown";
  const authArgs: Record<ProviderId, string[] | null> = {
    codex: ["login", "status"],
    agy: null,
    cursor: ["status", "--format", "json"],
    claude: ["auth", "status"],
  };
  if (authArgs[provider]) {
    const auth = await runProcess(config.command, authArgs[provider]!, "", timeoutMs, childEnv(config));
    const authText = `${auth.stdout}\n${auth.stderr}`;
    if (auth.code === 0 && !/not logged|not authenticated|logged out|unauthenticated|no auth/i.test(authText)) authenticated = "yes";
    else if (/not logged|not authenticated|logged out|unauthenticated|no auth|login required/i.test(authText)) authenticated = "no";
  }
  return { provider, command: config.command, available: true, authenticated, version: (result.stdout || result.stderr).trim().split("\n")[0] };
}

function basePrompt(system: string, prompt: string): string { return `${system}\n\n${prompt}`; }

export async function runProvider(provider: ProviderId, config: ProviderConfig, system: string, prompt: string, timeoutMs: number): Promise<string> {
  const env = childEnv(config);
  const full = basePrompt(system, prompt);
  let result: SpawnResult;
  let temp: string | undefined;
  let outputFile: string | undefined;
  try {
    if (provider === "codex") {
      temp = await mkdtemp(join(tmpdir(), "agent-translate-router-"));
      outputFile = join(temp, "last-message.txt");
      result = await runProcess(config.command, ["exec", "--model", config.model, "-c", `model_reasoning_effort=\"${config.effort ?? "low"}\"`, "--skip-git-repo-check", "--ignore-user-config", "--ephemeral", "--sandbox", "read-only", "--json", "--output-last-message", outputFile, "-"], full, timeoutMs, env);
      if (result.code === 0 && !result.timedOut) {
        const output = (await readFile(outputFile, "utf8").catch(() => "")).trim();
        if (output) return output;
      }
    } else if (provider === "agy") {
      result = await runProcess(config.command, ["-p", full, "--model", config.model, "--output-format", "json", "--disable-slash-commands"], "", timeoutMs, env);
      if (result.code === 0 && !result.timedOut) {
        try { const parsed = JSON.parse(result.stdout) as { response?: string }; if (parsed.response?.trim()) return parsed.response.trim(); } catch { /* plain text fallback */ }
        if (result.stdout.trim()) return result.stdout.trim();
      }
    } else if (provider === "cursor") {
      result = await runProcess(config.command, ["--print", "--mode", "ask", "--output-format", "text", "--model", config.model, "-p", full], "", timeoutMs, env);
      if (result.code === 0 && !result.timedOut && result.stdout.trim()) return result.stdout.trim();
    } else {
      result = await runProcess(config.command, ["--print", "--safe-mode", "--no-session-persistence", "--tools", "", "--output-format", "text", "--model", config.model, "--system-prompt", system], prompt, timeoutMs, env);
      if (result.code === 0 && !result.timedOut && result.stdout.trim()) return result.stdout.trim();
    }
    const message = `${result.stderr}\n${result.stdout}`.trim() || "provider returned empty output";
    throw new ProviderError(result.timedOut ? "timeout" : classify(message), `${provider}: ${message}`);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderError(classify(message), `${provider}: ${message}`);
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}
