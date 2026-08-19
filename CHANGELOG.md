# Changelog

## 0.1.6 — 2026-08-19

- Fixed legacy `.gemini/translate-proxy` metrics to be reported under the `agy` provider name.

## 0.1.5 — 2026-08-19

- Fixed installed Agy plugin and MCP server metadata to derive their version from the package instead of a stale hardcoded value.

## 0.1.4 — 2026-08-19

- Added `report [--days N] [--json]` with cross-provider token savings and ROI aggregation.
- Added router metrics for prompt translations, document translation costs, cache-served documents, and fail-open events.
- Reads compatible historical metrics from Codex, Agy, Cursor, and Claude sibling homes.

## 0.1.3 — 2026-08-19

- Added the cross-provider `agent-translate-router-mcp` server with `translate` and `resolve_doc` tools.
- Added native RU↔EN direction handling for MCP translation requests.
- Added Agy plugin installation with router hook/MCP registration and old translation plugin disablement.
- Added MCP installers for Codex, Cursor, Claude, and Agy that preserve unrelated servers.

## 0.1.2 — 2026-08-19

- Added native Claude, Cursor, and Agy pre-tool hook adapters.
- Added `install-hooks` with dry-run mode, configuration backups, and preservation of unrelated hooks.
- Added tests for native hook contracts and safe hook replacement.

## 0.1.1 — 2026-08-19

- Added provider circuit-breaker state and stdin EPIPE handling.

## 0.1.0

- Initial standalone cross-provider router.
- Ordered provider policies with a shared request deadline.
- Stable Markdown segmentation and fail-open complete-document behavior.
- Discovery for Codex, Agy, Cursor Agent, and Claude Code CLIs.
- Compatible reads for existing cursor/claude/gemini/codex translation caches.
