import { readFile } from "node:fs/promises";
import { buildTranslationPrompt, isCompleteTranslation, sha256, splitText, stripCompletionMarker } from "./segments.js";
import { findCache, projectRoot, projectSlug, writeCache } from "./cache.js";
import { discoverProvider, ProviderError, runProvider } from "./providers.js";
import { isBlocked, loadState, markFailure, markSuccess, saveState, type RouterState } from "./state.js";
import type { AttemptResult, DocumentResult, HostId, PolicyConfig, ProviderId, RouterConfig, TranslationDirection, TranslationResult } from "./types.js";

export interface TranslateOptions {
  cwd?: string;
  host?: HostId;
  event?: "prompt" | "file_read" | "document" | "response";
  policy?: string;
  projectSlug?: string;
  glossary?: string;
  direction?: TranslationDirection;
}

interface PreparedPolicy { name: string; policy: PolicyConfig; }

function choosePolicy(config: RouterConfig, options: TranslateOptions): PreparedPolicy {
  const name = options.policy || (options.host ? config.hooks[options.host] : undefined) || config.defaults.policy;
  return { name, policy: config.policies[name] ?? config.policies[config.defaults.policy] ?? Object.values(config.policies)[0] };
}

function remaining(start: number, deadline: number): number { return Math.max(0, deadline - (Date.now() - start)); }

function accepted(step: { on?: string[] }, error: ProviderError): boolean {
  return !step.on || step.on.length === 0 || step.on.includes(error.kind);
}

async function routeSegment(text: string, config: RouterConfig, options: TranslateOptions, prepared: PreparedPolicy, deadlineStart: number, discoveries: Map<ProviderId, Awaited<ReturnType<typeof discoverProvider>>>, state: RouterState, requestBlocked: Set<ProviderId>): Promise<{ text?: string; attempts: AttemptResult[]; provider?: ProviderId; model?: string; complete: boolean }> {
  const attempts: AttemptResult[] = [];
  const absoluteDeadline = deadlineStart + (prepared.policy.totalDeadlineMs ?? config.defaults.totalDeadlineMs);
  for (const step of prepared.policy.providers) {
    if (remaining(deadlineStart, absoluteDeadline) <= 0) break;
    if (requestBlocked.has(step.provider) || isBlocked(state, step.provider)) continue;
    const providerConfig = config.providers[step.provider];
    if (!providerConfig) continue;
    let discovery = discoveries.get(step.provider);
    if (!discovery) {
      discovery = await discoverProvider(step.provider, providerConfig, Math.min(config.defaults.probeTimeoutMs, remaining(deadlineStart, absoluteDeadline)));
      discoveries.set(step.provider, discovery);
    }
    if (!discovery.available) {
      attempts.push({ provider: step.provider, model: providerConfig.model, ok: false, elapsedMs: 0, failure: discovery.reason as AttemptResult["failure"] ?? "missing", message: discovery.reason });
      requestBlocked.add(step.provider);
      markFailure(state, step.provider, (discovery.reason as ProviderError["kind"]) || "missing", discovery.reason);
      continue;
    }
    const maxAttempts = step.maxAttempts ?? 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const available = remaining(deadlineStart, absoluteDeadline);
      if (available <= 0) break;
      const timeout = Math.min(step.timeoutMs ?? prepared.policy.segmentTimeoutMs ?? config.defaults.segmentTimeoutMs, available);
      const started = Date.now();
      try {
        const prompts = buildTranslationPrompt(text, options.glossary, options.direction);
        const raw = await runProvider(step.provider, providerConfig, prompts.system, prompts.prompt, timeout);
        const translated = stripCompletionMarker(raw);
        const elapsedMs = Date.now() - started;
        if (!isCompleteTranslation(translated, text)) throw new ProviderError("invalid_output", `${step.provider}: incomplete translation marker/output`);
        attempts.push({ provider: step.provider, model: providerConfig.model, ok: true, elapsedMs });
        markSuccess(state, step.provider);
        return { text: translated, attempts, provider: step.provider, model: providerConfig.model, complete: true };
      } catch (error) {
        const normalized = error instanceof ProviderError ? error : new ProviderError("unknown", String(error));
        attempts.push({ provider: step.provider, model: providerConfig.model, ok: false, elapsedMs: Date.now() - started, failure: normalized.kind, message: normalized.message });
        requestBlocked.add(step.provider);
        markFailure(state, step.provider, normalized.kind, normalized.message);
        if (!accepted(step, normalized)) return { attempts, complete: false };
        if (normalized.kind === "auth" || normalized.kind === "quota" || normalized.kind === "rate_limit" || normalized.kind === "missing") break;
      }
    }
  }
  return { attempts, complete: false };
}

export async function translateText(text: string, config: RouterConfig, options: TranslateOptions = {}): Promise<TranslationResult> {
  if (!text.trim()) return { text, provider: "original", model: "", cached: false, complete: true, attempts: [] };
  const prepared = choosePolicy(config, options);
  const chunks = splitText(text, prepared.policy.maxChunkChars ?? config.defaults.maxChunkChars);
  const start = Date.now();
  const discoveries = new Map<ProviderId, Awaited<ReturnType<typeof discoverProvider>>>();
  const state = await loadState(config.home);
  const requestBlocked = new Set<ProviderId>();
  const translated: string[] = [];
  const allAttempts: AttemptResult[] = [];
  let provider: ProviderId | "cache" | "original" = "original";
  let model = "";
  for (const chunk of chunks) {
    if (remaining(start, start + (prepared.policy.totalDeadlineMs ?? config.defaults.totalDeadlineMs)) <= 0) {
      return { text, provider: "original", model: "", cached: false, complete: false, attempts: allAttempts };
    }
    const result = await routeSegment(chunk, config, options, prepared, start, discoveries, state, requestBlocked);
    allAttempts.push(...result.attempts);
    if (!result.complete || !result.text) {
      if (prepared.policy.allowPartial ?? config.defaults.allowPartial) {
        translated.push(chunk);
        continue;
      }
      await saveState(config.home, state);
      return { text, provider: "original", model: "", cached: false, complete: false, attempts: allAttempts };
    }
    translated.push(result.text);
    provider = result.provider ?? provider;
    model = result.model ?? model;
  }
  await saveState(config.home, state);
  return { text: translated.join("\n\n"), provider, model, cached: false, complete: true, attempts: allAttempts };
}

export async function translateDocument(sourcePath: string, config: RouterConfig, options: TranslateOptions = {}): Promise<DocumentResult> {
  const cwd = options.cwd ?? process.cwd();
  const absoluteSource = sourcePath.startsWith("/") ? sourcePath : `${cwd}/${sourcePath}`;
  const sourceText = await readFile(absoluteSource, "utf8");
  const sourceSha256 = sha256(sourceText);
  const root = projectRoot(cwd, absoluteSource);
  const slug = projectSlug(cwd, options.projectSlug, absoluteSource);
  const ownHome = config.cache.ownDir;
  const cache = await findCache({ homes: config.cache.siblingHomes, ownHome, readSiblings: config.cache.readSiblings, slug, sourcePath: absoluteSource, root, sourceSha256 });
  if (cache.fullText) return { text: cache.fullText, provider: "cache", model: "", cached: true, complete: true, attempts: [], sourceSha256, segments: 1, translatedSegments: 1, cachePath: cache.path };

  const prepared = choosePolicy(config, { ...options, event: "document" });
  const chunks = splitText(sourceText, prepared.policy.maxChunkChars ?? config.defaults.maxChunkChars);
  const start = Date.now();
  const discoveries = new Map<ProviderId, Awaited<ReturnType<typeof discoverProvider>>>();
  const state = await loadState(config.home);
  const requestBlocked = new Set<ProviderId>();
  const outputs: string[] = [];
  const sectionMap = new Map(cache.sections);
  const attempts: AttemptResult[] = [];
  let translatedSegments = 0;
  let lastProvider: ProviderId | "cache" | "original" = "original";
  let lastModel = "";
  for (const chunk of chunks) {
    const key = sha256(chunk);
    const hit = sectionMap.get(key);
    if (hit) { outputs.push(hit); translatedSegments += 1; continue; }
    const result = await routeSegment(chunk, config, { ...options, event: "document" }, prepared, start, discoveries, state, requestBlocked);
    attempts.push(...result.attempts);
    if (!result.complete || !result.text) {
      if (!(prepared.policy.allowPartial ?? config.defaults.allowPartial)) {
        await saveState(config.home, state);
        return { text: sourceText, provider: "original", model: "", cached: false, complete: false, attempts, sourceSha256, segments: chunks.length, translatedSegments, cachePath: cache.path };
      }
      outputs.push(chunk);
      continue;
    }
    outputs.push(result.text);
    sectionMap.set(key, result.text);
    translatedSegments += 1;
    lastProvider = result.provider ?? lastProvider;
    lastModel = result.model ?? lastModel;
  }
  const finalText = outputs.join("\n\n");
  let cachePath = cache.path;
  await saveState(config.home, state);
  if (config.cache.writeOwn) cachePath = await writeCache({ home: config.cache.ownDir, slug, sourcePath: absoluteSource, root, sourceSha256, body: finalText, sections: sectionMap });
  return { text: finalText, provider: lastProvider, model: lastModel, cached: translatedSegments === chunks.length && attempts.length === 0, complete: true, attempts, sourceSha256, segments: chunks.length, translatedSegments, cachePath };
}
