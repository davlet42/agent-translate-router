# Policy design

The router has two independent limits:

1. `segment_timeout_ms` is the default limit for one provider call for one segment.
2. `total_deadline_ms` is the wall-clock limit for the whole request, including all segments and fallback attempts.

All providers use the same segment default. A provider-specific `timeout_ms` is an explicit exception, not an implicit performance preference.

The default `max_chunk_chars` is 4000. Smaller chunks keep technical Cyrillic documents below the latency cliff of long model generations while the five-minute request deadline still allows multiple segments.

For large documents, the router first looks for an exact full-document cache. If the source hash changed, it looks up SHA-256 Markdown-heading section entries in every configured cache home, translates only missing sections, and assembles the document. A section above `max_chunk_chars` is split into bounded fragments. With `allow_partial: false`, any missing section that cannot be translated causes the entire original source to be returned and no mixed result is stored as a complete cache.

Failure classes are deliberately different from content decisions:

- `missing`: command is not installed;
- `auth`: local CLI authentication is unavailable;
- `quota` / `rate_limit`: the subscription/provider limit rejected the call;
- `timeout`: the provider exceeded its segment budget;
- `unavailable`: transient CLI/network/service failure;
- `invalid_output`: empty, malformed, or incomplete provider output.

The `on` list on a policy step controls which classes advance to the next provider. A user cancellation or a policy exclusion stops the cascade.

## Suggested policies

```yaml
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

  subscription-only:
    total_deadline_ms: 300000
    segment_timeout_ms: 45000
    max_chunk_chars: 4000
    allow_partial: false
    providers:
      - provider: codex
      - provider: agy
      - provider: cursor

  codex-only:
    total_deadline_ms: 180000
    segment_timeout_ms: 45000
    max_chunk_chars: 4000
    allow_partial: false
    providers:
      - provider: codex
```
