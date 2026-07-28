# DEEPSEEK CCD PROMPT — Server API Changes for ccd Daemon

You are a senior Rust engineer working on the `ccd` daemon in `cli/`. The CCH server has recently added new API capabilities. Update `ccd` to use them without breaking existing behavior.

---

## 1. Project Context

- `cch` — TUI launcher for `claude`/`codex`/`kimi` (Rust binary in `cli/`)
- `ccd` — background daemon that reports local sessions to the CCH server (Rust binary in `cli/`)
- `server/` — Node.js + Fastify + Prisma + PGlite backend

`ccd` currently creates sessions and reports plaintext messages to the server. The server now supports richer metadata.

---

## 2. Server API Changes

### 2.1 `GET /v1/sessions` — Now returns `tag`

The server now includes `tag` in the sessions list response. Use this for display.

```json
{
  "sessions": [
    {
      "id": "cms1...",
      "tag": "fix-login-bug",
      "msgCount": 12,
      "isPlaintext": true,
      "activeAt": 1785051925192
    }
  ]
}
```

**What ccd must do:**
- When creating a session via `POST /v1/sessions`, always send a **unique tag per ccd invocation**.
- Format: `{directory-basename}-{timestamp}` (e.g. `cli-1785051925`).
- Do NOT reuse tags across restarts. Each `ccd` startup must create a new session, even in the same directory.

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

**What ccd must do:**
- When forwarding messages from `claude`/`codex`/`kimi` to the server, extract available metadata and include it in the POST body.
- If the underlying CLI does not expose metadata, omit the field entirely (do not send `null`).
- Keep sending `role` and `content` exactly as before. `metadata` is purely additive.

### 2.3 `POST /v1/sessions/:id/activity` — New endpoint

The server added an activity ping endpoint to update `lastActiveAt`:

```
POST /v1/sessions/:id/activity
Authorization: Bearer <token>
```

Response: `{"ok": true}`

**What ccd must do:**
- Call this endpoint every time new messages are synced for a session.
- Also call it periodically (e.g. every 30s) while a session is actively being used.
- This prevents the sidebar from showing stale relative times like "1d" for active sessions.

---

## 3. Constraints

1. **Backward compatibility:** If the server is old (does not return `tag` or accept `metadata`), `ccd` must still work. Use feature detection or graceful fallback.
2. **No breaking changes to existing API calls:** Keep `role`, `content`, `tag`, `metadata` fields exactly as before.
3. **Error handling:** If a metadata field is unavailable from the underlying CLI, omit it. Do not crash.
4. **Tag uniqueness:** Use timestamps or UUIDs to guarantee unique tags per ccd invocation.

---

## 4. Files to Modify

| File | Purpose |
|------|---------|
| `cli/src/daemon.rs` | Main daemon loop, session creation, message sync |
| `cli/src/session.rs` | Session management, tag generation |
| `cli/src/api.rs` | HTTP client for server API |

---

## 5. Acceptance Criteria

- [ ] `ccd` generates unique session tags per invocation (`{dir}-{timestamp}`)
- [ ] `ccd` calls `POST /v1/sessions/:id/activity` on every sync and periodically
- [ ] `ccd` includes `metadata` in plaintext message POSTs when available
- [ ] `ccd` still works against servers without the new endpoints (graceful fallback)
- [ ] `cargo test` passes
- [ ] `cargo clippy` passes
