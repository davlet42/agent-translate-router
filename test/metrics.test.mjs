import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatReport, readReport } from "../dist/metrics.js";

test("report aggregates router and sibling metrics and removes exact duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-router-report-"));
  const sibling = join(root, "cursor", "translate-proxy");
  await mkdir(sibling, { recursive: true });
  const now = new Date().toISOString();
  const line = JSON.stringify({ ts: now, source: "doc_cache_served", provider: "cache", saved_tokens_est: 100, translate_cost_tokens_est: 0 });
  await writeFile(join(root, "metrics.jsonl"), `${line}\n`);
  await writeFile(join(sibling, "metrics.jsonl"), `${line}\n${JSON.stringify({ ts: now, source: "doc_translate_cost", host: "agy", provider: "agy", saved_tokens_est: 0, translate_cost_tokens_est: 40 })}\n`);
  const result = await readReport({ home: root, defaults: {}, providers: {}, policies: {}, hooks: {}, cache: { ownDir: join(root, "cache"), siblingHomes: [sibling], readSiblings: true, writeOwn: true } }, 7);
  assert.equal(result.events, 2);
  assert.equal(result.savedTokens, 100);
  assert.equal(result.translationCostTokens, 40);
  assert.equal(result.netSavedTokens, 60);
  assert.equal(result.byHost.agy.events, 1);
  assert.match(formatReport(result), /by host:[\s\S]*agy: saved/);
  assert.match(formatReport(result), /ROI: 2\.50x/);
});
