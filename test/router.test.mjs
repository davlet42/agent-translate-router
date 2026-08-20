import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { sha256 } from "../dist/segments.js";
import { translateDocument, translateText } from "../dist/router.js";

function config(home, command, policy = {}) {
  return {
    home,
    defaults: { policy: "test", totalDeadlineMs: 3000, segmentTimeoutMs: 800, maxChunkChars: 12000, probeTimeoutMs: 150, allowPartial: false, failOpen: true },
    providers: {
      codex: { enabled: false, command, model: "gpt-5.6-luna", effort: "low" },
      agy: { enabled: "auto", command, model: "fake" },
      cursor: { enabled: false, command, model: "fake" },
      claude: { enabled: false, command, model: "fake" },
    },
    policies: { test: { providers: [{ provider: "agy", ...policy }], totalDeadlineMs: 3000, segmentTimeoutMs: 800, maxChunkChars: 12000, allowPartial: false } },
    hooks: { claude: "test" },
    cache: { ownDir: join(home, "own"), siblingHomes: [], readSiblings: false, writeOwn: true },
  };
}

test("reuses a compatible sibling full document cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-router-cache-"));
  const source = join(root, "README.md");
  const sibling = join(root, "sibling");
  const text = "Русский документ для проверки кэша.";
  await writeFile(source, text);
  const slug = basename(root);
  const target = join(sibling, "cache", slug, "README.en.md");
  await mkdir(join(sibling, "cache", slug), { recursive: true });
  await writeFile(target, `---\ncursor-translate-source: ${source}\ncursor-translate-source-sha256: ${sha256(text)}\ncursor-translate-generated-at: now\ncursor-translate-project: ${slug}\n---\n\nCached English\n`);
  const result = await translateDocument(source, { ...config(root, "missing-command"), cache: { ownDir: join(root, "own"), siblingHomes: [sibling], readSiblings: true, writeOwn: false } }, { cwd: root });
  assert.equal(result.text.trim(), "Cached English");
  assert.equal(result.provider, "cache");
});

test("reuses a document cache when another host used a different workspace slug", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-router-cross-workspace-"));
  const source = join(root, "README.md");
  const sourceText = "Русский документ.";
  const sibling = join(root, "sibling");
  await writeFile(source, sourceText);
  const target = join(sibling, "cache", "other-workspace", "nested", "README.en.md");
  await mkdir(join(sibling, "cache", "other-workspace", "nested"), { recursive: true });
  await writeFile(target, `---\ncursor-translate-source: ${source}\ncursor-translate-source-sha256: ${sha256(sourceText)}\ncursor-translate-project: other-workspace\n---\n\nEnglish document.\n`);
  const result = await translateDocument(source, { ...config(root, "missing-command"), cache: { ownDir: join(root, "own"), siblingHomes: [sibling], readSiblings: true, writeOwn: false } }, { cwd: root });
  assert.equal(result.provider, "cache");
  assert.equal(result.cachePath, target);
});

test("translates all segments through one provider with a shared default timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-router-provider-"));
  const fake = join(root, "fake-provider.sh");
  await writeFile(fake, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo fake; exit 0; fi\nprintf '{\"response\":\"Translated __AGENT_TRANSLATE_DONE__\"}'\n");
  await chmod(fake, 0o755);
  const result = await translateText("Первый абзац.\n\nВторой абзац.", { ...config(root, fake), defaults: { ...config(root, fake).defaults, maxChunkChars: 10, probeTimeoutMs: 1000 }, policies: { test: { providers: [{ provider: "agy" }], totalDeadlineMs: 3000, segmentTimeoutMs: 800, maxChunkChars: 10, allowPartial: false } } });
  assert.equal(result.complete, true);
  assert.equal(result.provider, "agy");
  assert.match(result.text, /Translated/);
  assert.ok(result.attempts.every((attempt) => attempt.provider === "agy"));
});

test("fails open to the complete original document when the deadline is exhausted", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-router-timeout-"));
  const fake = join(root, "slow-provider.sh");
  await writeFile(fake, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo fake; exit 0; fi\nsleep 2\n");
  await chmod(fake, 0o755);
  const text = "Большой русский документ, который нельзя вернуть частично.";
  const result = await translateText(text, config(root, fake));
  assert.equal(result.complete, false);
  assert.equal(result.provider, "original");
  assert.equal(result.text, text);
  assert.ok(result.attempts.some((attempt) => attempt.failure === "timeout"));
});
