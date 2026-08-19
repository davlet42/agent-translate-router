import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { adaptClaudePretool, adaptCursorPretool } from "../dist/hook-adapters.js";
import { mergeClaudeSettings, mergeCursorHooks } from "../dist/install-hooks.js";
import { sha256 } from "../dist/segments.js";

test("Claude and Cursor hook installers preserve unrelated hooks and replace router hooks", () => {
  const claude = mergeClaudeSettings({
    enabledPlugins: { "claude-translate@claude-translate": true, unrelated: true },
    hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "/old/translate-proxy/hooks/read.sh" }] }, { matcher: "Bash", hooks: [{ type: "command", command: "keep-me" }] }] },
  });
  assert.equal(claude.enabledPlugins["claude-translate@claude-translate"], false);
  assert.equal(claude.hooks.PreToolUse.length, 2);
  assert.equal(claude.hooks.PreToolUse[0].matcher, "Bash");
  assert.match(claude.hooks.PreToolUse[1].hooks[0].command, /agent-translate-router hook claude-pretool/);

  const cursor = mergeCursorHooks({ version: 1, hooks: { preToolUse: [{ command: "/old/translate-proxy/hooks/read.sh" }, { command: "keep-me" }] } });
  assert.equal(cursor.hooks.preToolUse.length, 2);
  assert.equal(cursor.hooks.preToolUse[0].command, "keep-me");
  assert.match(cursor.hooks.preToolUse[1].command, /agent-translate-router hook cursor-pretool/);
});

test("host adapters rewrite only to a complete shared-cache document", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-router-hooks-"));
  const source = join(root, "README.md");
  const sibling = join(root, "sibling");
  const sourceText = "Русский документ.";
  const slug = basename(root);
  await writeFile(source, sourceText);
  const cached = join(sibling, "cache", slug, "README.en.md");
  await mkdir(join(sibling, "cache", slug), { recursive: true });
  await writeFile(cached, `---\ncursor-translate-source: ${source}\ncursor-translate-source-sha256: ${sha256(sourceText)}\ncursor-translate-project: ${slug}\n---\n\nEnglish document.\n`);
  const config = {
    home: join(root, "router"),
    defaults: { policy: "test", totalDeadlineMs: 1000, segmentTimeoutMs: 200, maxChunkChars: 12000, probeTimeoutMs: 50, allowPartial: false, failOpen: true },
    providers: { codex: {}, agy: {}, cursor: {}, claude: {} },
    policies: { test: { providers: [] } },
    hooks: { claude: "test", cursor: "test" },
    cache: { ownDir: join(root, "own"), siblingHomes: [sibling], readSiblings: true, writeOwn: false },
  };
  const claude = await adaptClaudePretool({ tool_input: { file_path: source }, cwd: root }, config);
  assert.equal(claude.hookSpecificOutput.updatedInput.file_path, cached);
  const cursor = await adaptCursorPretool({ tool_input: { path: source }, cwd: root }, config);
  assert.equal(cursor.updated_input.path, cached);
});
