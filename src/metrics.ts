import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ProviderId, RouterConfig } from "./types.js";

export interface MetricEntry {
  ts: string;
  source: string;
  provider?: string;
  model?: string;
  direction?: string;
  project_slug?: string;
  source_path?: string;
  text_chars?: number;
  served_chars?: number;
  ru_tokens_est?: number;
  en_tokens_est?: number;
  saved_tokens_est?: number;
  translate_cost_tokens_est?: number;
  segments?: number;
  complete?: boolean;
  [key: string]: unknown;
}

export interface ReportBucket {
  events: number;
  savedTokens: number;
  costTokens: number;
}

export interface RouterReport {
  days: number;
  since: string;
  until: string;
  metricsPaths: string[];
  events: number;
  savedTokens: number;
  opportunityTokens: number;
  translationCostTokens: number;
  netSavedTokens: number;
  roiMultiple: number | null;
  breakEvenReads: number | null;
  bySource: Record<string, ReportBucket>;
  byProvider: Record<string, ReportBucket>;
}

export function estimateTokens(text: string, language: "ru" | "en"): number {
  return Math.ceil(text.length / (language === "ru" ? 3 : 4));
}

export function metricForTranslation(options: { source: string; translated: string; provider?: string; model?: string; projectSlug?: string; sourcePath?: string; direction?: string; }): MetricEntry {
  const sourceLanguage = options.direction === "en_ru" ? "en" : "ru";
  const targetLanguage = sourceLanguage === "ru" ? "en" : "ru";
  const sourceTokens = estimateTokens(options.source, sourceLanguage);
  const targetTokens = estimateTokens(options.translated, targetLanguage);
  return {
    ts: new Date().toISOString(),
    source: options.direction === "en_ru" ? "response_translated" : "prompt_translated",
    provider: options.provider,
    model: options.model,
    direction: options.direction ?? "ru_en",
    project_slug: options.projectSlug,
    source_path: options.sourcePath,
    text_chars: options.source.length,
    served_chars: options.translated.length,
    ru_tokens_est: sourceLanguage === "ru" ? sourceTokens : targetTokens,
    en_tokens_est: sourceLanguage === "en" ? sourceTokens : targetTokens,
    saved_tokens_est: Math.max(0, sourceTokens - targetTokens),
    translate_cost_tokens_est: sourceTokens + targetTokens,
  };
}

export async function appendMetric(home: string, entry: MetricEntry): Promise<void> {
  try {
    await mkdir(home, { recursive: true });
    await appendFile(join(home, "metrics.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch { /* metrics must never break translation */ }
}

function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }

function addBucket(map: Record<string, ReportBucket>, key: string, entry: MetricEntry): void {
  const bucket = map[key] ?? { events: 0, savedTokens: 0, costTokens: 0 };
  bucket.events += 1;
  bucket.savedTokens += number(entry.saved_tokens_est);
  bucket.costTokens += number(entry.translate_cost_tokens_est);
  map[key] = bucket;
}

function providerFromHome(home: string): string {
  const parent = basename(dirname(home)).replace(/^\./u, "");
  if (parent === "gemini") return "agy";
  return ["codex", "claude", "cursor"].includes(parent) ? parent : "router";
}

function isOpportunitySource(source: string): boolean {
  return ["user_prompt", "agent_response", "subagent_summary", "subagent_task", "prompt_audit", "response_audit"].includes(source);
}

export async function readReport(config: RouterConfig, days: number): Promise<RouterReport> {
  const until = new Date();
  const sinceDate = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  const homes = [...new Set([config.home, ...config.cache.siblingHomes])];
  const paths = homes.map((home) => join(home, "metrics.jsonl"));
  const seen = new Set<string>();
  const entries: Array<{ entry: MetricEntry; home: string }> = [];
  for (const path of paths) {
    let raw = "";
    try { raw = await readFile(path, "utf8"); } catch { continue; }
    const home = dirname(path);
    for (const line of raw.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as MetricEntry;
        const timestamp = new Date(entry.ts).getTime();
        if (!Number.isFinite(timestamp) || timestamp < sinceDate.getTime() || timestamp > until.getTime()) continue;
        const dedupe = JSON.stringify(entry);
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        entries.push({ entry, home });
      } catch { /* ignore malformed legacy lines */ }
    }
  }
  const bySource: Record<string, ReportBucket> = {};
  const byProvider: Record<string, ReportBucket> = {};
  let savedTokens = 0;
  let opportunityTokens = 0;
  let translationCostTokens = 0;
  for (const { entry, home } of entries) {
    if (isOpportunitySource(entry.source || "")) opportunityTokens += number(entry.saved_tokens_est);
    else savedTokens += number(entry.saved_tokens_est);
    translationCostTokens += number(entry.translate_cost_tokens_est);
    addBucket(bySource, entry.source || "unknown", entry);
    addBucket(byProvider, entry.provider || providerFromHome(home), entry);
  }
  const netSavedTokens = savedTokens - translationCostTokens;
  return {
    days,
    since: sinceDate.toISOString(),
    until: until.toISOString(),
    metricsPaths: paths,
    events: entries.length,
    savedTokens,
    opportunityTokens,
    translationCostTokens,
    netSavedTokens,
    roiMultiple: translationCostTokens > 0 ? savedTokens / translationCostTokens : null,
    breakEvenReads: savedTokens > 0 && translationCostTokens > 0 ? Math.ceil(translationCostTokens / savedTokens) : null,
    bySource,
    byProvider,
  };
}

function formatNumber(value: number): string { return Math.round(value).toLocaleString("en-US"); }

export function formatReport(report: RouterReport): string {
  const roi = report.roiMultiple === null ? "n/a" : `${report.roiMultiple.toFixed(2)}x`;
  const lines = [
    `agent-translate-router report (last ${report.days} days)`,
    `  events: ${formatNumber(report.events)}`,
    `  realized savings: ~${formatNumber(report.savedTokens)} tokens`,
    `  session opportunity: ~${formatNumber(report.opportunityTokens)} tokens (audit-only; not counted as realized)`,
    `  translation work: ~${formatNumber(report.translationCostTokens)} tokens (existing subscriptions; no direct API spend)`,
    `  net estimate: ~${formatNumber(report.netSavedTokens)} tokens`,
    `  ROI: ${roi}${report.breakEvenReads === null ? "" : `; break-even: ~${report.breakEvenReads} read(s)`}`,
    "  by source:",
  ];
  for (const [source, bucket] of Object.entries(report.bySource).sort(([a], [b]) => a.localeCompare(b))) {
    const kind = isOpportunitySource(source) ? "opportunity" : "realized";
    lines.push(`    ${source} [${kind}]: saved ~${formatNumber(bucket.savedTokens)}, cost ~${formatNumber(bucket.costTokens)} (${bucket.events} events)`);
  }
  lines.push("  by provider:");
  for (const [provider, bucket] of Object.entries(report.byProvider).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`    ${provider}: saved ~${formatNumber(bucket.savedTokens)}, cost ~${formatNumber(bucket.costTokens)} (${bucket.events} events)`);
  }
  lines.push(`  metrics: ${report.metricsPaths.join(", ")}`);
  return lines.join("\n");
}
