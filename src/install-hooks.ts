import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

export function mergeAgyConfig(input: JsonObject, disableOld = true): JsonObject {
  const result = { ...input };
  const plugins = { ...object(result.plugins) };
  if (disableOld) plugins["agy-translate"] = { ...object(plugins["agy-translate"]), enabled: false };
  plugins["agent-translate-router"] = { ...object(plugins["agent-translate-router"]), enabled: true };
  result.plugins = plugins;
  return result;
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

export async function installAgyPlugin(options: InstallHooksOptions = {}): Promise<string[]> {
  const home = options.home ?? homedir();
  const pluginDir = join(home, ".gemini", "config", "plugins", "agent-translate-router");
  const configPath = join(home, ".gemini", "config", "config.json");
  const dryRun = options.dryRun === true;
  const files: Array<[string, JsonObject]> = [
    [join(pluginDir, "plugin.json"), { name: "agent-translate-router", version: "0.1.3" }],
    [join(pluginDir, "hooks.json"), { "agent-translate-router-read": { PreToolUse: [{ matcher: "view_file", hooks: [{ type: "command", command: "agent-translate-router hook agy-pretool", timeout: 12 }] }] } }],
    [join(pluginDir, "mcp_config.json"), { mcpServers: { "agent-translate-router": { command: "agent-translate-router-mcp", args: [] } } }],
  ];
  const backups: string[] = [];
  for (const [path, value] of files) {
    if (await exists(path)) {
      const backupPath = await backup(path, dryRun);
      if (backupPath) backups.push(`backup: ${backupPath}`);
    }
    await saveJson(path, value, dryRun);
  }
  const config = await readJson(configPath, {});
  const configBackup = await backup(configPath, dryRun);
  if (configBackup) backups.push(`backup: ${configBackup}`);
  await saveJson(configPath, mergeAgyConfig(config, options.disableOld !== false), dryRun);
  return [
    `Agy: ${dryRun ? "would install" : "installed"} ${pluginDir}`,
    "Agy: PreToolUse view_file now routes through agent-translate-router",
    "Agy: the old agy-translate plugin is disabled but its package and cache are preserved",
    ...backups,
  ];
}

export function codexHookInstructions(): string[] {
  return [
    "Codex: no generic pre-tool hook is installed by this package; no file was changed.",
    "Use agent-translate-router install-mcp codex to register the cross-provider MCP server.",
  ];
}

export async function installHooks(target: string | undefined, options: InstallHooksOptions = {}): Promise<string[]> {
  const selected = target && target !== "all" ? [target] : ["claude", "cursor", "agy", "codex"];
  const output: string[] = [];
  for (const item of selected) {
    if (item === "claude") output.push(...await installClaudeHooks(options));
    else if (item === "cursor") output.push(...await installCursorHooks(options));
    else if (item === "agy") output.push(...await installAgyPlugin(options));
    else if (item === "codex") output.push(...codexHookInstructions());
    else throw new Error(`unknown hook host: ${item}`);
  }
  return output;
}
