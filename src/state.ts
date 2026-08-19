import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FailureKind, ProviderId } from "./types.js";

interface ProviderState { disabledUntil: number; failure: FailureKind; message?: string; }
export interface RouterState { providers: Partial<Record<ProviderId, ProviderState>>; }

const cooldownMs: Record<FailureKind, number> = {
  missing: 60 * 60 * 1000,
  auth: 10 * 60 * 1000,
  quota: 10 * 60 * 1000,
  rate_limit: 2 * 60 * 1000,
  timeout: 30 * 1000,
  unavailable: 30 * 1000,
  invalid_output: 60 * 1000,
  unknown: 30 * 1000,
};

export async function loadState(home: string): Promise<RouterState> {
  try {
    const parsed = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as RouterState;
    return parsed && typeof parsed.providers === "object" ? parsed : { providers: {} };
  } catch { return { providers: {} }; }
}

export async function saveState(home: string, state: RouterState): Promise<void> {
  await mkdir(home, { recursive: true }).catch(() => undefined);
  await writeFile(join(home, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf8").catch(() => undefined);
}

export function isBlocked(state: RouterState, provider: ProviderId, now = Date.now()): boolean {
  const entry = state.providers[provider];
  return Boolean(entry && entry.disabledUntil > now);
}

export function markFailure(state: RouterState, provider: ProviderId, failure: FailureKind, message?: string): void {
  state.providers[provider] = { failure, message, disabledUntil: Date.now() + cooldownMs[failure] };
}

export function markSuccess(state: RouterState, provider: ProviderId): void {
  delete state.providers[provider];
}
