# agent-translate-router

Standalone cross-provider translation router for AI-agent hooks.

It translates text and Markdown through locally installed provider CLIs, using an ordered policy such as:

```text
Codex / gpt-5.6-luna (Low) → Agy → Cursor → Claude → original text
```

The router does not depend on `codex-translate`, `agy-translate`, `cursor-translate`, or `claude-translate` being installed. It invokes provider CLIs directly and can read their existing document caches without importing their packages.

## Important behavior

- No direct provider API calls are made by the router.
- Provider timeouts use one equal default for every provider: `45000ms` per segment.
- A request-wide deadline defaults to `300000ms` (5 minutes) and is shared by all segments and fallback attempts.
- Markdown chunks default to `4000` characters so technical Russian documents do not spend 45 seconds generating one oversized segment.
- Large Markdown files are split into stable sections/chunks.
- A segment is accepted only after a completion marker is returned.
- By default, an incomplete document is never written to cache: the complete original is returned (fail-open).
- Existing caches under `~/.cursor/translate-proxy`, `~/.claude/translate-proxy`, `~/.gemini/translate-proxy`, and `~/.codex/translate-proxy` are read automatically.
- New cache entries are written to `~/.agent-translate-router/cache` by default.

OpenAI's official model guidance describes GPT-5.6 Luna as optimized for cost-sensitive, high-volume workloads and supports low reasoning effort for latency-sensitive tasks. The router still treats the Codex CLI and its subscription authentication as the runtime boundary; it does not call the OpenAI API. ([OpenAI Docs](https://developers.openai.com/api/docs/models/gpt-5.6-luna))

## Install

```bash
npm install -g agent-translate-router
agent-translate-router init
agent-translate-router install-hooks --dry-run all
agent-translate-router install-hooks all
agent-translate-router install-mcp --dry-run all
agent-translate-router install-mcp all
agent-translate-router report --days 7
```

The installers back up existing configuration before changing it. `install-hooks` connects the `Read` adapter for Claude and Cursor, and registers Agy's `view_file` hook. It also registers the plugin in Agy's `import_manifest.json`, which is required for hooks to load. `install-mcp` registers one cross-provider server and disables only the old translation MCP integrations; unrelated MCP servers and old packages/caches remain untouched.

Use a project checkout during development:

```bash
npm ci
npm test
npm run build
```

## Configure

The generated file is `~/.agent-translate-router/config.yaml`. The complete example is in [`templates/config.yaml`](templates/config.yaml).

```yaml
defaults:
  policy: cheap-first
  total_deadline_ms: 300000
  segment_timeout_ms: 45000
  max_chunk_chars: 4000
  probe_timeout_ms: 1500
  allow_partial: false
  fail_open: true

providers:
  codex:
    enabled: auto
    command: codex
    model: gpt-5.6-luna
    effort: low
  agy:
    enabled: auto
    command: agy
    model: Gemini 3.7 Flash (Low)
  cursor:
    enabled: auto
    command: agent
    model: auto
  claude:
    enabled: auto
    command: claude
    model: claude-haiku-4-5

policies:
  cheap-first:
    total_deadline_ms: 300000
    segment_timeout_ms: 45000
    max_chunk_chars: 4000
    allow_partial: false
    providers:
      - provider: codex
      - provider: agy
      - provider: cursor
      - provider: claude

hooks:
  codex: cheap-first
  claude: cheap-first
  agy: cheap-first
  cursor: cheap-first

cache:
  own_dir: ~/.agent-translate-router/cache
  read_siblings: true
  write_own: true
```

The same `segment_timeout_ms` is used for every provider unless a policy step explicitly overrides it:

```yaml
providers:
  - provider: codex
    timeout_ms: 45000
  - provider: agy
    timeout_ms: 45000
```

`total_deadline_ms` remains the upper bound for the complete request. If it expires in the middle of a large document, the default result is the untouched original document.

## Commands

```bash
agent-translate-router providers
agent-translate-router doctor
agent-translate-router policy explain --host claude
agent-translate-router policy validate
agent-translate-router translate "Русский prompt" --host claude --json
agent-translate-router doc README.md --json
agent-translate-router hook claude-pretool < hook.json
agent-translate-router hook cursor-pretool < hook.json
agent-translate-router hook agy-pretool < hook.json
agent-translate-router hook-resolve < hook.json
agent-translate-router install-hooks [all|claude|cursor|agy|codex] [--dry-run] [--no-disable]
agent-translate-router install-mcp [all|claude|cursor|agy|codex] [--dry-run] [--no-disable]
agent-translate-router cache-stats
```

`providers` checks CLI availability and performs non-generating auth checks where the provider supports them. It never sends a translation request during discovery. Quota and transient failure state is learned from real provider failures and persisted with cooldowns in `~/.agent-translate-router/state.json`, so a broken provider is not retried for every segment.

## Hook contract

`hook-resolve` accepts neutral JSON with either a text field or a Markdown path:

```json
{"host":"claude","text":"Русский prompt"}
```

```json
{"host":"claude","tool_input":{"file_path":"/project/README.md"}}
```

It returns `decision: allow`, translated content/read path, provider/model metadata, and `failOpen`. The native adapters rewrite only a successful Markdown read to the shared English cache path. The generated native hook timeout is 360 seconds, leaving margin above the five-minute request deadline. Missing CLIs, quota errors, timeouts, invalid output, and incomplete documents remain fail-open: the host reads the original file.

Reports separate the translation executor (`by provider`) from the requesting host (`by host`). For example, a document read by Agy and translated by Codex appears as `codex` under providers and `agy` under hosts.

## Cross-provider MCP

`agent-translate-router-mcp` exposes the same two tools to every host:

- `translate` — RU↔EN through the configured provider policy;
- `resolve_doc` — resolve a Markdown file to a complete English shared-cache document.

The MCP server uses the same local CLI providers, timeouts, circuit breaker, sibling caches, and fail-open behavior as hooks. It does not call OpenAI, Anthropic, Google, or Cursor APIs directly. After `install-mcp all`, the old provider-specific translation MCPs are disabled while unrelated MCP servers stay enabled.

## Report

```bash
agent-translate-router report --days 7
agent-translate-router report --days 30 --json
```

The report combines the router's metrics with compatible historical `metrics.jsonl` files from Codex, Agy, Cursor, and Claude. It shows realized token savings, translation work, net estimate, ROI, break-even, and breakdowns by event source and provider. Subscription translation has no direct API invoice, so the report labels translation work as token effort rather than inventing a dollar charge.

## Cache compatibility

The reader understands the existing `cursor-translate` / `claude-translate` frontmatter and `.en.sections.json` sidecars. Full-document cache hits are preferred; if the source SHA changed, reusable section hashes are merged from every configured sibling home. Newly completed documents are written in the compatible frontmatter/sidecar format under the router's own cache.

## Safety and recursion

Provider subprocesses receive `AGENT_TRANSLATE_ROUTER_ACTIVE=1` and `AGENT_TRANSLATE_ROUTER_HOP=1`. Integrations should bypass their own translation hook when those markers are present, especially when Claude is the last fallback in a Claude hook.

## License

MIT.
