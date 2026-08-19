export type ProviderId = "codex" | "agy" | "cursor" | "claude";
export type HostId = ProviderId | "unknown";
export type EventKind = "prompt" | "file_read" | "document" | "response";
export type FailureKind = "missing" | "auth" | "quota" | "rate_limit" | "timeout" | "unavailable" | "invalid_output" | "unknown";

export interface ProviderConfig {
  enabled: boolean | "auto";
  command: string;
  model: string;
  effort?: string;
  env?: Record<string, string>;
}

export interface PolicyStep {
  provider: ProviderId;
  timeoutMs?: number;
  maxAttempts?: number;
  on?: FailureKind[];
}

export interface PolicyConfig {
  providers: PolicyStep[];
  totalDeadlineMs?: number;
  segmentTimeoutMs?: number;
  maxChunkChars?: number;
  allowPartial?: boolean;
}

export interface RouterConfig {
  home: string;
  defaults: {
    policy: string;
    totalDeadlineMs: number;
    segmentTimeoutMs: number;
    maxChunkChars: number;
    probeTimeoutMs: number;
    allowPartial: boolean;
    failOpen: boolean;
  };
  providers: Record<ProviderId, ProviderConfig>;
  policies: Record<string, PolicyConfig>;
  hooks: Record<string, string>;
  cache: {
    ownDir: string;
    siblingHomes: string[];
    readSiblings: boolean;
    writeOwn: boolean;
  };
}

export interface DiscoveryResult {
  provider: ProviderId;
  command: string;
  available: boolean;
  authenticated: "yes" | "no" | "unknown";
  version?: string;
  reason?: string;
}

export interface TranslationResult {
  text: string;
  provider: ProviderId | "cache" | "original";
  model: string;
  cached: boolean;
  complete: boolean;
  attempts: AttemptResult[];
}

export interface AttemptResult {
  provider: ProviderId;
  model: string;
  ok: boolean;
  elapsedMs: number;
  failure?: FailureKind;
  message?: string;
}

export interface DocumentResult extends TranslationResult {
  sourceSha256: string;
  segments: number;
  translatedSegments: number;
  cachePath?: string;
}
