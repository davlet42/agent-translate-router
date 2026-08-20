import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installAgyPlugin } from "./install-hooks.js";

const execFileAsync = promisify(execFile);
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function readJson(path: string, fallback: JsonObject): Promise<JsonObject> {
  try { return object(JSON.parse(await readFile(path, "utf8"))); } catch { return fallback; }
}

async function backup(path: string, dryRun: boolean): Promise<string | undefined> {
  if (!(await exists(path))) return undefined;
  const target = `${path}.backup-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  if (!dryRun) await copyFile(path, target);
  return target;
}

async function saveJson(path: string, value: JsonObject, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function mergeCursorMcp(input: JsonObject, disableOld = true): JsonObject {
  const servers = { ...object(input.mcpServers) };
  if (disableOld) delete servers["cursor-translate"];
  servers["agent-translate-router"] = { command: "agent-translate-router-mcp", args: ["cursor"] };
  return { ...input, mcpServers: servers };
}

function setTomlEnabled(text: string, section: string): string {
  const lines = text.split(/\r?\n/u);
  const header = `[mcp_servers.${section}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return text;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/u.test(lines[i])) { end = i; break; }
  }
  const enabled = lines.findIndex((line, index) => index > start && index < end && /^\s*enabled\s*=/u.test(line));
  if (enabled >= 0) lines[enabled] = "enabled = false";
  else lines.splice(start + 1, 0, "enabled = false");
  return lines.join("\n");
}

export function mergeCodexMcp(input: string, disableOld = true): string {
  let result = disableOld ? setTomlEnabled(input, "codex-translate") : input;
  const header = "[mcp_servers.agent-translate-router]";
  const block = `${header}\ncommand = \"agent-translate-router-mcp\"\nargs = [\"codex\"]`;
  const start = result.split(/\r?\n/u).findIndex((line) => line.trim() === header);
  if (start < 0) return result.trimEnd() + `\n\n${block}\n`;
  const lines = result.split(/\r?\n/u);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/u.test(lines[index])) { end = index; break; }
  }
  lines.splice(start, end - start, ...block.split("\n"));
  result = lines.join("\n");
  return result;
}

export interface InstallMcpOptions { dryRun?: boolean; disableOld?: boolean; home?: string; }

async function installCursor(options: InstallMcpOptions): Promise<string[]> {
  const path = join(options.home ?? homedir(), ".cursor", "mcp.json");
  const current = await readJson(path, { mcpServers: {} });
  const backupPath = await backup(path, options.dryRun === true);
  await saveJson(path, mergeCursorMcp(current, options.disableOld !== false), options.dryRun === true);
  return [`Cursor MCP: ${options.dryRun ? "would update" : "updated"} ${path}`, ...(backupPath ? [`backup: ${backupPath}`] : [])];
}

async function installCodex(options: InstallMcpOptions): Promise<string[]> {
  const path = join(options.home ?? homedir(), ".codex", "config.toml");
  let current = "";
  try { current = await readFile(path, "utf8"); } catch { /* create below */ }
  const backupPath = await backup(path, options.dryRun === true);
  if (!current && !(options.dryRun === true)) await mkdir(dirname(path), { recursive: true });
  if (!options.dryRun) await writeFile(path, mergeCodexMcp(current, options.disableOld !== false), "utf8");
  return [`Codex MCP: ${options.dryRun ? "would update" : "updated"} ${path}`, ...(backupPath ? [`backup: ${backupPath}`] : [])];
}

async function installClaude(options: InstallMcpOptions): Promise<string[]> {
  const home = options.home ?? homedir();
  const settingsPath = join(home, ".claude", "settings.json");
  const settings = await readJson(settingsPath, {});
  const enabledPlugins = { ...object(settings.enabledPlugins) };
  if (options.disableOld !== false) enabledPlugins["claude-translate@claude-translate"] = false;
  const settingsBackup = await backup(settingsPath, options.dryRun === true);
  await saveJson(settingsPath, { ...settings, enabledPlugins }, options.dryRun === true);
  const claudeJson = join(home, ".claude.json");
  const claudeBackup = await backup(claudeJson, options.dryRun === true);
  if (!options.dryRun) {
    try {
      let alreadyRegistered = false;
      try {
        await execFileAsync("claude", ["mcp", "get", "agent-translate-router"], { env: { ...process.env, HOME: home } });
        alreadyRegistered = true;
      } catch { /* register below */ }
      if (alreadyRegistered) await execFileAsync("claude", ["mcp", "remove", "agent-translate-router"], { env: { ...process.env, HOME: home } });
      await execFileAsync("claude", ["mcp", "add", "--scope", "user", "agent-translate-router", "--", "agent-translate-router-mcp", "claude"], { env: { ...process.env, HOME: home } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [`Claude MCP: could not register automatically (${message})`, ...(settingsBackup ? [`backup: ${settingsBackup}`] : []), ...(claudeBackup ? [`backup: ${claudeBackup}`] : [])];
    }
  }
  return [`Claude MCP: ${options.dryRun ? "would register" : "registered"} agent-translate-router`, ...(settingsBackup ? [`backup: ${settingsBackup}`] : []), ...(claudeBackup ? [`backup: ${claudeBackup}`] : [])];
}

export async function installMcp(target: string | undefined, options: InstallMcpOptions = {}): Promise<string[]> {
  const selected = target && target !== "all" ? [target] : ["claude", "cursor", "agy", "codex"];
  const output: string[] = [];
  for (const item of selected) {
    if (item === "claude") output.push(...await installClaude(options));
    else if (item === "cursor") output.push(...await installCursor(options));
    else if (item === "agy") output.push(...await installAgyPlugin(options));
    else if (item === "codex") output.push(...await installCodex(options));
    else throw new Error(`unknown MCP host: ${item}`);
  }
  return output;
}
