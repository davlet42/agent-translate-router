# Runtime guide

`agent-translate-router` is the policy layer. It does not replace provider CLIs and does not require the provider-specific translation packages.

Install and initialize:

```bash
npm install -g agent-translate-router
agent-translate-router init
agent-translate-router providers
```

Provider CLI authentication remains the responsibility of the provider. Discovery uses version/help and non-generating auth status commands where available. It never spends quota just to inspect the machine.

To connect the native `Read` hooks:

```bash
agent-translate-router install-hooks --dry-run all
agent-translate-router install-hooks all
```

Claude receives `agent-translate-router hook claude-pretool`, and Cursor receives `agent-translate-router hook cursor-pretool`. Existing configuration is backed up before writing. The Agy adapter is available as `agent-translate-router hook agy-pretool`, but Agy installations do not share one reliable global hook file, so wire it into the project/plugin `view-file` or `PreToolUse` hook. Codex currently has no generic pre-tool hook in this package; keep its MCP integration and use `hook-resolve` where a neutral hook runner is available.

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
