import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { PolicyConfig, ProviderConfig, ProviderId, RouterConfig } from "./types.js";

export const PROVIDERS: ProviderId[] = ["codex", "agy", "cursor", "claude"];

const defaultHome = resolve(process.env.AGENT_TRANSLATE_HOME?.trim() || join(homedir(), ".agent-translate-router"));
const defaultSiblings = [
  join(homedir(), ".cursor", "translate-proxy"),
  join(homedir(), ".claude", "translate-proxy"),
  join(homedir(), ".gemini", "translate-proxy"),
  join(homedir(), ".codex", "translate-proxy"),
];

export function expandPath(value: string, base = homedir()): string {
  const expanded = value.replace(/^~(?=\/|$)/, homedir());
  return resolve(expanded.startsWith("/") ? expanded : join(base, expanded));
}

function providerDefaults(): Record<ProviderId, ProviderConfig> {
  return {
    codex: { enabled: "auto", command: "codex", model: "gpt-5.6-luna", effort: "low" },
    agy: { enabled: "auto", command: "agy", model: "Gemini 3.7 Flash (Low)" },
    cursor: { enabled: "auto", command: "agent", model: "auto" },
    claude: { enabled: "auto", command: "claude", model: "claude-haiku-4-5" },
  };
}

function cheapFirst(): PolicyConfig {
  const on = ["missing", "auth", "quota", "rate_limit", "timeout", "unavailable", "invalid_output"] as const;
  return {
    providers: PROVIDERS.map((provider) => ({ provider, on: [...on] })),
    totalDeadlineMs: 12000,
    segmentTimeoutMs: 6000,
    maxChunkChars: 12000,
    allowPartial: false,
  };
}

export function defaultConfig(): RouterConfig {
  return {
    home: defaultHome,
    defaults: {
      policy: "cheap-first",
      totalDeadlineMs: 12000,
      segmentTimeoutMs: 6000,
      maxChunkChars: 12000,
      probeTimeoutMs: 1500,
      allowPartial: false,
      failOpen: true,
    },
    providers: providerDefaults(),
    policies: { "cheap-first": cheapFirst() },
    hooks: { codex: "cheap-first", claude: "cheap-first", agy: "cheap-first", cursor: "cheap-first" },
    cache: { ownDir: join(defaultHome, "cache"), siblingHomes: defaultSiblings, readSiblings: true, writeOwn: true },
  };
}

function asNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export async function loadConfig(path?: string): Promise<RouterConfig> {
  const base = defaultConfig();
  const configPath = expandPath(path || join(base.home, "config.yaml"));
  let raw: Record<string, unknown> = {};
  try {
    raw = (parse(await readFile(configPath, "utf8")) ?? {}) as Record<string, unknown>;
  } catch {
    return base;
  }

  const defaults = (raw.defaults ?? {}) as Record<string, unknown>;
  const legacy = (raw.routing ?? {}) as Record<string, unknown>;
  const providers = { ...base.providers };
  const rawProviders = (raw.providers ?? {}) as Record<string, Record<string, unknown>>;
  for (const id of PROVIDERS) {
    const item = rawProviders[id] ?? {};
    providers[id] = {
      ...providers[id],
      ...(item.enabled === undefined ? {} : { enabled: item.enabled as boolean | "auto" }),
      ...(item.command === undefined ? {} : { command: String(item.command) }),
      ...(item.model === undefined ? {} : { model: String(item.model) }),
      ...(item.effort === undefined ? {} : { effort: String(item.effort) }),
      ...(item.env === undefined ? {} : { env: item.env as Record<string, string> }),
    };
  }

  const policies = { ...base.policies };
  const rawPolicies = (raw.policies ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, policyRaw] of Object.entries(rawPolicies)) {
    const entries = Array.isArray(policyRaw) ? policyRaw : (policyRaw.providers ?? []);
    const steps = Array.isArray(entries) ? entries : [];
    policies[name] = {
      providers: steps.map((step) => {
        const s = step as Record<string, unknown>;
        return {
          provider: String(s.provider) as ProviderId,
          timeoutMs: s.timeout_ms === undefined ? undefined : asNumber(s.timeout_ms, base.defaults.segmentTimeoutMs),
          maxAttempts: s.max_attempts === undefined ? undefined : asNumber(s.max_attempts, 1),
          on: Array.isArray(s.on) ? s.on.map(String) as never : undefined,
        };
      }),
      totalDeadlineMs: asNumber(policyRaw.total_deadline_ms, base.defaults.totalDeadlineMs),
      segmentTimeoutMs: asNumber(policyRaw.segment_timeout_ms, base.defaults.segmentTimeoutMs),
      maxChunkChars: asNumber(policyRaw.max_chunk_chars, base.defaults.maxChunkChars),
      allowPartial: asBool(policyRaw.allow_partial, base.defaults.allowPartial),
    };
  }

  const cacheRaw = (raw.cache ?? {}) as Record<string, unknown>;
  const siblingHomes = Array.isArray(cacheRaw.sibling_homes)
    ? cacheRaw.sibling_homes.map(String).map((value) => expandPath(value))
    : base.cache.siblingHomes;
  const home = expandPath(String(raw.home ?? base.home));
  const configuredPolicy = String(defaults.policy ?? legacy.default_policy ?? base.defaults.policy);

  return {
    home,
    defaults: {
      policy: configuredPolicy,
      totalDeadlineMs: asNumber(defaults.total_deadline_ms, base.defaults.totalDeadlineMs),
      segmentTimeoutMs: asNumber(defaults.segment_timeout_ms, base.defaults.segmentTimeoutMs),
      maxChunkChars: asNumber(defaults.max_chunk_chars, base.defaults.maxChunkChars),
      probeTimeoutMs: asNumber(defaults.probe_timeout_ms, base.defaults.probeTimeoutMs),
      allowPartial: asBool(defaults.allow_partial, base.defaults.allowPartial),
      failOpen: asBool(defaults.fail_open, base.defaults.failOpen),
    },
    providers,
    policies,
    hooks: { ...base.hooks, ...((raw.hooks ?? {}) as Record<string, string>) },
    cache: {
      ownDir: expandPath(String(cacheRaw.own_dir ?? join(home, "cache"))),
      siblingHomes: [...new Set([...siblingHomes, ...defaultSiblings.map((value) => expandPath(value))])],
      readSiblings: asBool(cacheRaw.read_siblings, true),
      writeOwn: asBool(cacheRaw.write_own, true),
    },
  };
}
