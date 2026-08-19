# Runtime guide

`agent-translate-router` is the policy layer. It does not replace provider CLIs and does not require the provider-specific translation packages.

Install and initialize:

```bash
npm install -g agent-translate-router
agent-translate-router init
agent-translate-router providers
```

Provider CLI authentication remains the responsibility of the provider. Discovery uses version/help and non-generating auth status commands where available. It never spends quota just to inspect the machine.

To connect the native read hooks:

```bash
agent-translate-router install-hooks --dry-run all
agent-translate-router install-hooks all
agent-translate-router install-mcp --dry-run all
agent-translate-router install-mcp all
```

Claude receives `agent-translate-router hook claude-pretool`, Cursor receives `agent-translate-router hook cursor-pretool`, and Agy receives `agent-translate-router hook agy-pretool` through a registered local plugin. The Agy plugin registers only the `view_file` matcher and updates `import_manifest.json`; existing configuration is backed up before writing. Codex has no generic pre-tool hook, so its integration is MCP-based.

`install-mcp all` registers `agent-translate-router-mcp` with Codex, Cursor, Claude, and Agy. It disables only `codex-translate`, `cursor-translate`, `claude-translate`, and `agy-translate` MCP/plugin integrations; Figma, Atlassian, Playwright, Pencil, and other unrelated servers are preserved.

The unified economy report reads the router metrics and compatible historical sibling metrics:

```bash
agent-translate-router report --days 7
agent-translate-router report --days 30 --json
```

Hook integrations should pass the host in their JSON input:

```json
{"host":"claude","event":"prompt","text":"..."}
```

The host is used to select a policy, not to force the host's own model as the translator. Thus a Claude hook can select Codex first.

When the router starts a provider subprocess it sets `AGENT_TRANSLATE_ROUTER_ACTIVE=1` and `AGENT_TRANSLATE_ROUTER_HOP=1`. Hook adapters must immediately bypass translation when these variables are set to avoid a Claude→router→Claude loop.

The router writes its own cache under `~/.agent-translate-router/cache` and reads the existing cache homes by default. Disable sibling reads only when required by a project's privacy policy:

```yaml
cache:
  read_siblings: false
```
