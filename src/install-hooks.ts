import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type JsonObject = Record<string, unknown>;
type HookEntry = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function array(value: unknown): HookEntry[] {
  return Array.isArray(value) ? value.filter((item): item is HookEntry => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
}

function isRouterCommand(entry: HookEntry): boolean {
  const serialized = JSON.stringify(entry);
  return serialized.includes("/translate-proxy/hooks/") || serialized.includes("agent-translate-router");
}

export function mergeClaudeSettings(input: JsonObject, disableOld = true): JsonObject {
  const result = { ...input };
  const enabledPlugins = { ...object(result.enabledPlugins) };
  if (disableOld && Object.prototype.hasOwnProperty.call(enabledPlugins, "claude-translate@claude-translate")) {
    enabledPlugins["claude-translate@claude-translate"] = false;
  }
  result.enabledPlugins = enabledPlugins;
  const hooks = { ...object(result.hooks) };
  const cleaned = Object.fromEntries(Object.entries(hooks).map(([event, value]) => [event, array(value).filter((entry) => !isRouterCommand(entry))]));
  const preToolUse = array(cleaned.PreToolUse);
  preToolUse.push({ matcher: "Read", hooks: [{ type: "command", command: "agent-translate-router hook claude-pretool", timeout: 12 }] });
  cleaned.PreToolUse = preToolUse;
  result.hooks = cleaned;
  return result;
}

export function mergeCursorHooks(input: JsonObject): JsonObject {
  const result: JsonObject = { ...input, version: Number(input.version) || 1 };
  const hooks = { ...object(result.hooks) };
  const cleaned = Object.fromEntries(Object.entries(hooks).map(([event, value]) => [event, array(value).filter((entry) => !isRouterCommand(entry))]));
  const preToolUse = array(cleaned.preToolUse);
  preToolUse.push({ command: "agent-translate-router hook cursor-pretool", matcher: "Read", timeout: 12 });
  cleaned.preToolUse = preToolUse;
  result.hooks = cleaned;
  return result;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function readJson(path: string, fallback: JsonObject): Promise<JsonObject> {
  try { return object(JSON.parse(await readFile(path, "utf8"))); } catch { return fallback; }
}

async function saveJson(path: string, value: JsonObject, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function backup(path: string, dryRun: boolean): Promise<string | undefined> {
  if (!(await exists(path))) return undefined;
  const target = `${path}.backup-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  if (!dryRun) await copyFile(path, target);
  return target;
}

export interface InstallHooksOptions { dryRun?: boolean; disableOld?: boolean; home?: string; }

export async function installClaudeHooks(options: InstallHooksOptions = {}): Promise<string[]> {
  const path = join(options.home ?? homedir(), ".claude", "settings.json");
  const current = await readJson(path, {});
  const next = mergeClaudeSettings(current, options.disableOld !== false);
  const backupPath = await backup(path, options.dryRun === true);
  await saveJson(path, next, options.dryRun === true);
  return [`Claude: ${options.dryRun ? "would update" : "updated"} ${path}`, ...(backupPath ? [`backup: ${backupPath}`] : [])];
}

export async function installCursorHooks(options: InstallHooksOptions = {}): Promise<string[]> {
  const path = join(options.home ?? homedir(), ".cursor", "hooks.json");
  const current = await readJson(path, { version: 1, hooks: {} });
  const next = mergeCursorHooks(current);
  const backupPath = await backup(path, options.dryRun === true);
  await saveJson(path, next, options.dryRun === true);
  return [`Cursor: ${options.dryRun ? "would update" : "updated"} ${path}`, ...(backupPath ? [`backup: ${backupPath}`] : [])];
}

export function agyHookInstructions(): string[] {
  return [
    "Agy: no active global hook configuration was detected; no file was changed.",
    "Wire this command into the Agy view-file/PreToolUse hook: agent-translate-router hook agy-pretool",
  ];
}

export function codexHookInstructions(): string[] {
  return [
    "Codex: no generic pre-tool hook is installed by this package; no file was changed.",
    "Keep codex-translate MCP enabled, or call: agent-translate-router hook-resolve",
  ];
}

export async function installHooks(target: string | undefined, options: InstallHooksOptions = {}): Promise<string[]> {
  const selected = target && target !== "all" ? [target] : ["claude", "cursor", "agy", "codex"];
  const output: string[] = [];
  for (const item of selected) {
    if (item === "claude") output.push(...await installClaudeHooks(options));
    else if (item === "cursor") output.push(...await installCursorHooks(options));
    else if (item === "agy") output.push(...agyHookInstructions());
    else if (item === "codex") output.push(...codexHookInstructions());
    else throw new Error(`unknown hook host: ${item}`);
  }
  return output;
}
