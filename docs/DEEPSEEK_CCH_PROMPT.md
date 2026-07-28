# DEEPSEEK CCH PROMPT — Server API Changes for cch TUI

You are a senior Rust engineer working on the `cch` TUI launcher in `cli/`. The CCH server has recently added new API capabilities. Update `cch` to use them without breaking existing behavior.

---

## 1. Project Context

- `cch` — TUI launcher for `claude`/`codex`/`kimi` (Rust binary in `cli/`)
- `ccd` — background daemon that reports local sessions to the CCH server
- `server/` — Node.js + Fastify + Prisma + PGlite backend

`cch` creates interactive sessions and streams messages to the server in real time. The server now supports richer metadata and activity tracking.

---

## 2. Server API Changes

### 2.1 `GET /v1/sessions` — Now returns `tag`

The server now includes `tag` in the sessions list response.

```json
{
  "sessions": [
    {
      "id": "cms1...",
      "tag": "cli-1785051925",
      "msgCount": 12,
      "isPlaintext": true,
      "activeAt": 1785051925192
    }
  ]
}
```

**What cch must do:**
- When creating a session via `POST /v1/sessions`, always send a **unique tag per invocation**.
- Format: `{profile-name}-{timestamp}` (e.g. `default-1785051925`).
- Do NOT reuse tags across restarts. Each `cch run` must create a new session, even with the same profile.

### 2.2 `POST /v1/sessions/:id/plaintext-messages` — Now accepts `metadata`

The endpoint now accepts an optional `metadata` object:

```json
{
  "role": "assistant",
  "content": "Here are the search results...",
  "metadata": {
    "thinkingMs": 1200,
    "bakedMs": 800,
    "toolCalls": [
      {
        "name": "Web Search",
        "args": { "query": "DeepSeek AI 2026" },
        "result": "Did 1 search in 23s",
        "durationMs": 23000
      }
    ],
    "tokens": {
      "input": 1500,
      "output": 800,
      "cost": 0.0012
    }
  }
}
```

**Metadata fields (all optional):**

| Field | Type | Description |
|-------|------|-------------|
| `thinkingMs` | number | Time spent thinking before responding |
| `bakedMs` | number | Time spent generating the response |
| `toolCalls` | array | Tool invocations made during this turn |
| `toolCalls[].name` | string | Tool name (e.g. "Web Search", "Read", "Bash") |
| `toolCalls[].args` | object | Tool arguments |
| `toolCalls[].result` | string | Short result summary |
| `toolCalls[].durationMs` | number | Tool execution time |
| `tokens.input` | number | Input tokens consumed |
| `tokens.output` | number | Output tokens generated |
| `tokens.cost` | number | Estimated cost in USD |

**What cch must do:**
- When streaming messages from `claude`/`codex`/`kimi` to the server, extract available metadata and include it in the POST body.
- If the underlying CLI does not expose metadata, omit the field entirely (do not send `null`).
- Keep sending `role` and `content` exactly as before. `metadata` is purely additive.

### 2.3 `POST /v1/sessions/:id/activity` — New endpoint

The server added an activity ping endpoint to update `lastActiveAt`:

```
POST /v1/sessions/:id/activity
Authorization: Bearer <token>
```

Response: `{"ok": true}`

**What cch must do:**
- Call this endpoint every time a new message is sent or received for the active session.
- Also call it periodically (e.g. every 30s) while the TUI is running and the session is active.
- This prevents the web dashboard from showing stale relative times.

---

## 3. Constraints

1. **Backward compatibility:** If the server is old (does not return `tag` or accept `metadata`), `cch` must still work. Use feature detection or graceful fallback.
2. **No breaking changes to existing API calls:** Keep `role`, `content`, `tag` fields exactly as before.
3. **Error handling:** If a metadata field is unavailable from the underlying CLI, omit it. Do not crash.
4. **Tag uniqueness:** Use timestamps or UUIDs to guarantee unique tags per `cch` invocation.
5. **TUI display:** Show the session tag in the TUI status bar so users can identify which session is active.

---

## 4. Files to Modify

| File | Purpose |
|------|---------|
| `cli/src/main.rs` | Entry point, session creation |
| `cli/src/session.rs` | Session management, tag generation |
| `cli/src/api.rs` | HTTP client for server API |
| `cli/src/ui.rs` | TUI status bar, tag display |

---

## 5. Acceptance Criteria

- [ ] `cch run` generates unique session tags per invocation (`{profile}-{timestamp}`)
- [ ] `cch` displays the active session tag in the TUI status bar
- [ ] `cch` calls `POST /v1/sessions/:id/activity` on every message and periodically
- [ ] `cch` includes `metadata` in plaintext message POSTs when available
- [ ] `cch` still works against servers without the new endpoints (graceful fallback)
- [ ] `cargo test` passes
- [ ] `cargo clippy` passes
