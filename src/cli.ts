#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { discoverProvider } from "./providers.js";
import { defaultConfig, loadConfig, PROVIDERS } from "./config.js";
import { cacheStats } from "./cache.js";
import { translateDocument, translateText } from "./router.js";
import { runHostHook } from "./hook-adapters.js";
import { installHooks } from "./install-hooks.js";
import type { HostId, ProviderId, RouterConfig } from "./types.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean { return args.includes(name); }
function configYaml(config: RouterConfig): string {
  return stringify({
    schema: 1,
    defaults: {
      policy: config.defaults.policy,
      total_deadline_ms: config.defaults.totalDeadlineMs,
      segment_timeout_ms: config.defaults.segmentTimeoutMs,
      max_chunk_chars: config.defaults.maxChunkChars,
      probe_timeout_ms: config.defaults.probeTimeoutMs,
      allow_partial: config.defaults.allowPartial,
      fail_open: config.defaults.failOpen,
    },
    providers: config.providers,
    policies: Object.fromEntries(Object.entries(config.policies).map(([name, policy]) => [name, {
      total_deadline_ms: policy.totalDeadlineMs,
      segment_timeout_ms: policy.segmentTimeoutMs,
      max_chunk_chars: policy.maxChunkChars,
      allow_partial: policy.allowPartial,
      providers: policy.providers.map((step) => ({ provider: step.provider, timeout_ms: step.timeoutMs, max_attempts: step.maxAttempts, on: step.on })),
    }])),
    hooks: config.hooks,
    cache: { own_dir: config.cache.ownDir, sibling_homes: config.cache.siblingHomes, read_siblings: config.cache.readSiblings, write_own: config.cache.writeOwn },
  });
}

async function init(args: string[]): Promise<void> {
  const config = defaultConfig();
  await mkdir(config.home, { recursive: true });
  await mkdir(config.cache.ownDir, { recursive: true });
  const path = join(config.home, "config.yaml");
  if (has(args, "--dry-run")) { console.log(configYaml(config)); return; }
  try { await readFile(path, "utf8"); } catch { await writeFile(path, configYaml(config), "utf8"); }
  console.log(`agent-translate-router initialized\n  config: ${path}\n  own cache: ${config.cache.ownDir}\n  sibling caches: ${config.cache.siblingHomes.join(", ")}`);
}

async function providers(config: RouterConfig): Promise<void> {
  for (const id of PROVIDERS) {
    const result = await discoverProvider(id, config.providers[id], config.defaults.probeTimeoutMs);
    console.log(`${id}\t${result.available ? "available" : "missing"}\tauth=${result.authenticated}\t${config.providers[id].command}\t${result.reason ?? result.version ?? ""}`);
  }
}

function explain(config: RouterConfig, args: string[]): void {
  const host = (flag(args, "--host") ?? "unknown") as HostId;
  const name = flag(args, "--policy") ?? config.hooks[host] ?? config.defaults.policy;
  const policy = config.policies[name];
  if (!policy) throw new Error(`unknown policy: ${name}`);
  console.log(`policy: ${name}\nhost: ${host}\nevent: ${flag(args, "--event") ?? "prompt"}\ntotal deadline: ${policy.totalDeadlineMs ?? config.defaults.totalDeadlineMs}ms\nsegment timeout: ${policy.segmentTimeoutMs ?? config.defaults.segmentTimeoutMs}ms\n`);
  policy.providers.forEach((step, index) => console.log(`${index + 1}. ${step.provider} — ${config.providers[step.provider]?.command ?? "unknown"} — ${config.providers[step.provider]?.model ?? ""} — ${step.timeoutMs ?? policy.segmentTimeoutMs ?? config.defaults.segmentTimeoutMs}ms`));
  console.log("final fallback: original text");
}

async function translate(args: string[], config: RouterConfig): Promise<void> {
  const input = args.filter((arg) => !arg.startsWith("--") && arg !== flag(args, "--host") && arg !== flag(args, "--policy"))[0];
  let text = input;
  if (text === undefined) {
    let stdin = "";
    for await (const chunk of process.stdin) stdin += chunk;
    text = stdin;
  }
  const result = await translateText(text, config, { host: flag(args, "--host") as HostId | undefined, policy: flag(args, "--policy") });
  if (has(args, "--json")) console.log(JSON.stringify(result, null, 2));
  else { console.log(result.text); console.error(`\n[${result.provider}${result.model ? ` / ${result.model}` : ""}${result.complete ? "" : " / fail-open"}]`); }
}

async function doc(args: string[], config: RouterConfig): Promise<void> {
  const path = args.find((arg) => !arg.startsWith("--") && arg !== flag(args, "--project"));
  if (!path) throw new Error("doc requires a file path");
  const result = await translateDocument(path, config, { projectSlug: flag(args, "--project"), host: flag(args, "--host") as HostId | undefined });
  if (has(args, "--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.text}\n\n[${result.provider}${result.complete ? "" : " / fail-open"}; segments ${result.translatedSegments}/${result.segments}; cache ${result.cachePath ?? "none"}]`);
}

async function hookResolve(config: RouterConfig): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input: Record<string, unknown>;
  try { input = JSON.parse(raw) as Record<string, unknown>; } catch { process.stdout.write(raw); return; }
  const toolInput = (input.tool_input ?? input.arguments ?? input) as Record<string, unknown>;
  const text = typeof toolInput.text === "string" ? toolInput.text : typeof input.text === "string" ? input.text : undefined;
  const path = [toolInput.file_path, toolInput.absolute_path, toolInput.path, input.file_path, input.absolute_path].find((value) => typeof value === "string") as string | undefined;
  try {
    if (path && /\.md(?:x)?$/i.test(path)) {
      const result = await translateDocument(path, config, { host: (input.host as HostId) ?? "unknown", event: "file_read" });
      process.stdout.write(JSON.stringify({ decision: "allow", sourcePath: path, readPath: result.cachePath, content: result.text, translated: result.complete, provider: result.provider, model: result.model, failOpen: !result.complete }) + "\n");
      return;
    }
    if (text !== undefined) {
      const result = await translateText(text, config, { host: (input.host as HostId) ?? "unknown", event: "prompt" });
      process.stdout.write(JSON.stringify({ decision: "allow", text: result.text, translated: result.complete, provider: result.provider, model: result.model, failOpen: !result.complete }) + "\n");
      return;
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({ decision: "allow", failOpen: true, reason: error instanceof Error ? error.message : String(error) }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ ...input, decision: "allow", translated: false }) + "\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  const config = await loadConfig(flag(args, "--config"));
  if (command === "init") return init(args);
  if (command === "providers" || command === "doctor") return providers(config);
  if (command === "policy" && args[1] === "explain") return explain(config, args.slice(2));
  if (command === "policy" && args[1] === "validate") { explain(config, []); return; }
  if (command === "translate" || command === "prompt") return translate(args.slice(1), config);
  if (command === "doc") return doc(args.slice(1), config);
  if (command === "hook") return runHostHook(args[1], config);
  if (command === "hook-resolve") return hookResolve(config);
  if (command === "install-hooks") {
    const target = args[1]?.startsWith("--") ? undefined : args[1];
    for (const line of await installHooks(target, { dryRun: has(args, "--dry-run"), disableOld: !has(args, "--no-disable") })) console.log(line);
    return;
  }
  if (command === "cache-stats") { console.log(JSON.stringify(await cacheStats(config.home), null, 2)); return; }
  console.log(`agent-translate-router

Commands:
  init [--dry-run]
  providers | doctor
  policy explain [--host claude] [--policy cheap-first]
  policy validate
  translate|prompt [text] [--host claude] [--json]
  doc <file> [--project slug] [--json]
  hook claude-pretool|cursor-pretool|agy-pretool
  hook-resolve
  install-hooks [all|claude|cursor|agy|codex] [--dry-run] [--no-disable]
  cache-stats

Default chain: codex → agy → cursor → claude → original text`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
