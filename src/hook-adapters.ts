import type { HostId, RouterConfig } from "./types.js";
import { translateDocument } from "./router.js";

export type HookInput = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function readHookInput(): Promise<HookInput | null> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return record(parsed);
  } catch {
    return null;
  }
}

function nestedToolInput(input: HookInput): Record<string, unknown> {
  const toolCall = record(input.toolCall);
  return record(
    toolCall.args
      ?? toolCall.arguments
      ?? input.tool_input
      ?? input.toolInput
      ?? input.arguments
      ?? input,
  );
}

function pathValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function cwdOf(input: HookInput): string | undefined {
  const workspacePaths = Array.isArray(input.workspacePaths) ? input.workspacePaths : [];
  return workspacePaths.map(pathValue).find((value): value is string => Boolean(value))
    ?? pathValue(input.cwd)
    ?? pathValue(input.working_directory)
    ?? pathValue(input.workspace);
}

function hostPath(input: HookInput, host: HostId): { toolInput: Record<string, unknown>; path?: string; key?: string } {
  const toolInput = nestedToolInput(input);
  const candidates = host === "agy"
    ? ["AbsolutePath", "absolute_path", "file_path", "path", "TargetFile"]
    : host === "cursor"
      ? ["path", "file_path", "absolute_path", "target"]
      : ["file_path", "path", "absolute_path"];
  for (const key of candidates) {
    const value = pathValue(toolInput[key]);
    if (value) return { toolInput, path: value, key };
  }
  return { toolInput };
}

function reason(result: { provider: string; model: string; cachePath?: string }): string {
  return `agent-translate-router: translated via ${result.provider}${result.model ? ` / ${result.model}` : ""}; serving the cached English document`;
}

export async function adaptClaudePretool(input: HookInput, config: RouterConfig): Promise<Record<string, unknown>> {
  const found = hostPath(input, "claude");
  if (!found.path || !/\.md(?:x)?$/iu.test(found.path)) return {};
  try {
    const result = await translateDocument(found.path, config, { host: "claude", event: "file_read", cwd: cwdOf(input) });
    if (!result.complete || !result.cachePath || result.cachePath === found.path) return { decision: "allow" };
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { ...found.toolInput, file_path: result.cachePath },
        additionalContext: reason(result),
      },
      suppressOutput: true,
    };
  } catch {
    return { decision: "allow", failOpen: true };
  }
}

export async function adaptCursorPretool(input: HookInput, config: RouterConfig): Promise<Record<string, unknown>> {
  const found = hostPath(input, "cursor");
  if (!found.path || !/\.md(?:x)?$/iu.test(found.path)) return { permission: "allow" };
  try {
    const result = await translateDocument(found.path, config, { host: "cursor", event: "file_read", cwd: cwdOf(input) });
    if (!result.complete || !result.cachePath || result.cachePath === found.path) return { permission: "allow" };
    return {
      permission: "allow",
      updated_input: { ...found.toolInput, path: result.cachePath },
      agent_message: reason(result),
    };
  } catch {
    return { permission: "allow", failOpen: true };
  }
}

export async function adaptAgyPretool(input: HookInput, config: RouterConfig): Promise<Record<string, unknown>> {
  const found = hostPath(input, "agy");
  if (!found.path || !/\.md(?:x)?$/iu.test(found.path)) return { decision: "allow" };
  try {
    const result = await translateDocument(found.path, config, { host: "agy", event: "file_read", cwd: cwdOf(input) });
    if (!result.complete || !result.cachePath || result.cachePath === found.path || !found.key) return { decision: "allow" };
    return { decision: "allow", overwrite: { [found.key]: result.cachePath }, reason: reason(result) };
  } catch {
    return { decision: "allow", failOpen: true };
  }
}

export async function runHostHook(host: string | undefined, config: RouterConfig): Promise<void> {
  const input = await readHookInput();
  if (!input) { process.stdout.write(JSON.stringify({ decision: "allow", failOpen: true }) + "\n"); return; }
  const result = host === "claude-pretool"
    ? await adaptClaudePretool(input, config)
    : host === "cursor-pretool"
      ? await adaptCursorPretool(input, config)
      : host === "agy-pretool"
        ? await adaptAgyPretool(input, config)
        : { decision: "allow" };
  process.stdout.write(JSON.stringify(result) + "\n");
}
