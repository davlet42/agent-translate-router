# Changelog

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
