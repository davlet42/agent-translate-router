import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

async function packageVersion(): Promise<string> {
  try {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return packageJson.version ?? "unknown";
  } catch { return "unknown"; }
}

export function mergeAgyConfig(input: JsonObject, disableOld = true): JsonObject {
  const result = { ...input };
  const plugins = { ...object(result.plugins) };
  if (disableOld) plugins["agy-translate"] = { ...object(plugins["agy-translate"]), enabled: false };
  plugins["agent-translate-router"] = { ...object(plugins["agent-translate-router"]), enabled: true };
  result.plugins = plugins;
  return result;
}

function agyReadHook(command: string, matcher: string): JsonObject {
  return { matcher, hooks: [{ type: "command", command, timeout: 12 }] };
}

export function mergeAgyImportManifest(input: JsonObject, name: string, components: string[]): JsonObject {
  const imports = Array.isArray(input.imports)
    ? input.imports.filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
  const existing = imports.find((item) => item.name === name);
  const merged = {
    ...(existing ?? {}),
    name,
    source: "antigravity",
    importedAt: typeof existing?.importedAt === "string" ? existing.importedAt : new Date().toISOString(),
    components: [...new Set([...(Array.isArray(existing?.components) ? existing.components.map(String) : []), ...components])],
  };
  return { ...input, imports: [...imports.filter((item) => item.name !== name), merged] };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
  const manifestPath = join(home, ".gemini", "config", "import_manifest.json");
  const dryRun = options.dryRun === true;
  const version = await packageVersion();
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  const mcpPath = fileURLToPath(new URL("./mcp-server.js", import.meta.url));
  const command = `${shellQuote(process.execPath)} ${shellQuote(cliPath)} hook agy-pretool`;
  const files: Array<[string, JsonObject]> = [
    [join(pluginDir, "plugin.json"), { name: "agent-translate-router", version }],
    [join(pluginDir, "hooks.json"), {
      "agent-translate-router-read": {
        PreToolUse: [agyReadHook(command, "view_file")],
      },
    }],
    [join(pluginDir, "mcp_config.json"), { mcpServers: { "agent-translate-router": { command: process.execPath, args: [mcpPath] } } }],
  ];
  const backups: string[] = [];
  for (const [path, value] of files) {
    if (await exists(path)) {
      const backupPath = await backup(path, dryRun);
      if (backupPath) backups.push(`backup: ${backupPath}`);
    }
    await saveJson(path, value, dryRun);
  }
  const manifest = await readJson(manifestPath, {});
  const manifestBackup = await backup(manifestPath, dryRun);
  if (manifestBackup) backups.push(`backup: ${manifestBackup}`);
  await saveJson(manifestPath, mergeAgyImportManifest(manifest, "agent-translate-router", ["mcpServers", "hooks"]), dryRun);
  const config = await readJson(configPath, {});
  const configBackup = await backup(configPath, dryRun);
  if (configBackup) backups.push(`backup: ${configBackup}`);
  await saveJson(configPath, mergeAgyConfig(config, options.disableOld !== false), dryRun);
  return [
    `Agy: ${dryRun ? "would install" : "installed"} ${pluginDir}`,
    "Agy: registered plugin and PreToolUse view_file hook",
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
