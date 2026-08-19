import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { adaptAgyPretool, adaptClaudePretool, adaptCursorPretool } from "../dist/hook-adapters.js";
import { mergeAgyConfig, mergeAgyImportManifest, mergeClaudeSettings, mergeCursorHooks } from "../dist/install-hooks.js";
import { mergeCodexMcp, mergeCursorMcp } from "../dist/install-mcp.js";
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

test("Agy installer registers only the current view_file tool name", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-router-agy-hooks-"));
  const { installAgyPlugin } = await import("../dist/install-hooks.js");
  await installAgyPlugin({ home, registerAgy: false });
  const hooks = JSON.parse(await (await import("node:fs/promises")).readFile(join(home, ".gemini", "config", "plugins", "agent-translate-router", "hooks.json"), "utf8"));
  assert.deepEqual(
    hooks["agent-translate-router-read"].PreToolUse.map((entry) => entry.matcher),
    ["view_file"],
  );
  assert.equal(hooks["agent-translate-router-read"].PreToolUse[0].hooks[0].timeout, 360);
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(join(home, ".gemini", "config", "import_manifest.json"), "utf8"));
  assert.deepEqual(manifest.imports[0].components, ["mcpServers", "hooks"]);
  assert.equal(manifest.imports[0].source, "antigravity");
});

test("Agy import manifest preserves unrelated plugins", () => {
  const manifest = mergeAgyImportManifest({ imports: [{ name: "Figma", source: "gemini-cli", components: ["mcpServers"] }] }, "agent-translate-router", ["mcpServers", "hooks"]);
  assert.equal(manifest.imports.length, 2);
  assert.equal(manifest.imports[0].name, "Figma");
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
  const agy = await adaptAgyPretool({ toolCall: { name: "view_file", args: { AbsolutePath: source } }, workspacePaths: [root] }, config);
  assert.equal(agy.overwrite.AbsolutePath, cached);
});

test("MCP installation disables only the old translation servers", () => {
  const agy = mergeAgyConfig({ plugins: { figma: { enabled: true } } });
  assert.equal(agy.plugins.figma.enabled, true);
  assert.equal(agy.plugins["agy-translate"].enabled, false);
  assert.equal(agy.plugins["agent-translate-router"].enabled, true);

  const cursor = mergeCursorMcp({ mcpServers: { "cursor-translate": {}, playwright: { command: "playwright" } } });
  assert.equal(cursor.mcpServers["cursor-translate"], undefined);
  assert.equal(cursor.mcpServers.playwright.command, "playwright");
  assert.equal(cursor.mcpServers["agent-translate-router"].command, "agent-translate-router-mcp");

  const codex = mergeCodexMcp("[mcp_servers.codex-translate]\ncommand = \"codex-translate-mcp\"\n\n[projects.\"/\"]\ntrust_level = \"trusted\"\n");
  assert.match(codex, /\[mcp_servers\.codex-translate\][\s\S]*enabled = false/);
  assert.match(codex, /\[mcp_servers\.agent-translate-router\]/);
});

test("MCP server exposes the cross-provider tools", async () => {
  const child = spawn(process.execPath, ["dist/mcp-server.js"], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
  const responses = output.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses[0].result.serverInfo.name, "agent-translate-router");
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ["translate", "resolve_doc"]);
});
