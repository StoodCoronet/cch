# KIMI UI PROMPT — CCH Web Dashboard

You are a senior frontend engineer. Rebuild the web dashboard for **CCH (Claude Code with Happy)**, a self-hosted session-monitoring server. The output must be production-ready, static HTML/CSS/JS served by a Node.js backend. No build step, no framework.

---

## 1. Context

CCH collects Claude Code sessions from multiple machines via a Rust CLI (`cch`) and daemon (`ccd`). Users open a browser to watch sessions, view messages, and manage connection tokens.

**Two pages:**
- `/` — user dashboard (sessions, machines, token management)
- `/admin` — admin panel (account management, stats)

**Reference style:** DeepSeek web UI — clean, modern, dark-first but default light, generous whitespace, subtle borders, smooth micro-interactions.

---

## 2. Design Tokens

Use CSS custom properties. **Default theme is light.** `data-theme="dark"` overrides.

```css
:root {
  --bg: #fafafa;
  --bg-elevated: #ffffff;
  --bg-hover: #f3f4f6;
  --bg-active: #e5e7eb;
  --bg-input: #ffffff;
  --fg: #171717;
  --fg-secondary: #525252;
  --fg-tertiary: #a3a3a3;
  --border: #e5e5e5;
  --border-strong: #d4d4d4;
  --accent: #4f46e5;
  --accent-hover: #4338ca;
  --accent-light: #6366f1;
  --green: #16a34a;
  --red: #dc2626;
  --shadow: 0 4px 24px rgba(0,0,0,.08);
}
[data-theme="dark"] {
  --bg: #0d0d0d;
  --bg-elevated: #171717;
  --bg-hover: #1f1f1f;
  --bg-active: #262626;
  --bg-input: #1e1e1e;
  --fg: #f5f5f5;
  --fg-secondary: #a3a3a3;
  --fg-tertiary: #737373;
  --border: #262626;
  --border-strong: #333333;
  --accent: #4f46e5;
  --accent-hover: #5b54e6;
  --accent-light: #818cf8;
  --green: #22c55e;
  --red: #ef4444;
  --shadow: 0 4px 24px rgba(0,0,0,.35);
}
```

Typography: `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif`. Code: `"SF Mono", "Fira Code", monospace`.

---

## 3. Page `/` — User Dashboard

### 3.1 Layout

```
┌─────────────────────────────────────────────────────────────┐
│ [☰] CCH          [+ Device] [🌙] [↻] [→]                    │ ← sidebar header
├──────────────┬──────────────────────────────────────────────┤
│ Search...    │                                              │
│              │                                              │
│ Sessions (N) │   ┌─ Chat Header ─────────────────────────┐  │
│ ● tag-name   │   │ Select a session                      │  │
│   12 msgs·3h │   └───────────────────────────────────────┘  │
│ ○ tag-name   │                                              │
│   45 msgs·1d │   ┌─ Messages ────────────────────────────┐  │
│              │   │                                       │  │
│ Machines (M) │   │  [user] fix the login bug             │  │
│ ● macbook    │   │  [assistant] I found the issue...     │  │
│   just now   │   │                                       │  │
│              │   └───────────────────────────────────────┘  │
│              │                                              │
│              │   ┌─ Input ────────────────────────────────┐ │
│              │   │ > Send a message...          [Send]   │ │
│              │   └───────────────────────────────────────┘ │
└──────────────┴──────────────────────────────────────────────┘
```

- **Sidebar:** fixed width (default 280px, draggable 220–500px via `.resizer`). Save width to `localStorage`.
- **Main area:** flex column. Header, message area (scrollable), input area.
- **Mobile (<768px):** sidebar slides in from left, main full-width.

### 3.2 Sidebar

**Header:** logo "CCH", `+ Device` button, theme toggle (🌙/☀), refresh (↻), logout (→).

**Search:** text input filters sessions by title/metadata.

**Sessions list:**
- Each item: colored dot (green = active, gray = idle), title (from `metadata` or first 10 chars of id), meta line `{msgCount} msgs · {relativeTime}`.
- Relative time: `<1m` → "just now", `<1h` → "Xm", `<24h` → "Xh", else "Xd".
- Click → select, highlight, load messages, auto-scroll to bottom.

**Machines panel** (collapsible):
- Header with count and chevron.
- Each machine: name, last active time.

### 3.3 Main Area

**Placeholder** (no session selected): centered logo, "Welcome to CCH", "Select a session from the sidebar."

**Chat header:** session title, created date, machine name.

**Messages:**
- `user` messages: right-aligned bubble (`--bg-active`), avatar "Y".
- `assistant` messages: left-aligned, no bubble background, avatar "AI".
- Role label above content.
- Support code blocks: triple backticks → `<pre>` with copy button. Inline backticks → `<code>`.
- Auto-scroll to bottom on load and on send.

**Input area** (only for plaintext sessions):
- Textarea auto-resize (max 180px), Enter to send, Shift+Enter for newline.
- Send button disabled when empty.
- Below: hint "Press Enter to send, Shift+Enter for new line".

### 3.4 Connect / Login Screen

Full-screen overlay. Card (max-width 420px) with:
- Logo + "Connect to your self-hosted server"
- Tabs: **Token** / **Password**
- Token tab: paste connection string or raw token. Auto-parse `?token=xxx` from URL.
- Password tab: username + password fields.
- Error message below button.
- On success: store token/accountId in `localStorage`, hide overlay, load dashboard.

### 3.5 Device Connect Modal

Triggered by `+ Device` button. Modal (max-width 560px) with:

**Generate New Token section:**
- Label input (placeholder: "Label, e.g. macbook-pro")
- "Generate Token" button
- After generation: show connection URL in a box, plus three copy buttons:
  - "Copy for cch" → `./target/release/cch connect 'URL'`
  - "Copy for ccd" → `./target/release/ccd connect 'URL'`
  - "Copy raw URL" → URL only

**Active Tokens section:**
- List items: label (click to edit inline), created time, action buttons.
- Actions: Edit (inline rename), Copy link, cch, ccd, Revoke (red hover).
- Revoke asks for confirmation.

**Copy behavior:** always copy raw string without shell-escaping. Only add quotes when composing the `cch`/`ccd` command strings shown to the user.

---

## 4. Page `/admin` — Admin Panel

### 4.1 Layout

Centered container (max-width 900px).

**Login screen:** card (max-width 380px) with admin password input, Login button, error display.

**Main screen:**
- Header: "CCH Admin" logo, server URL, theme toggle.
- Stats grid (3 cards): Accounts, Active Sessions, Total Sessions.
- Accounts section:
  - Create row: username input, password input (optional), "Create Account" button.
  - Table: User, Sessions, Share (bar), Created, Delete button.

### 4.2 Interactions

- Admin password stored in `localStorage` as `happy_admin_password`.
- Stats auto-refresh every 30s.
- Delete account asks for confirmation.
- Theme persisted as `admin_theme`.

---

## 5. Global Requirements

1. **Theme toggle:** icon button in header. Persist choice. Default `light`.
2. **Auto-refresh:** user dashboard refreshes sessions/machines/tokens every 30s. When a session is selected, refresh messages every 2s.
3. **Resizable sidebar:** drag handle (6px) on right edge. Min 220px, max 500px. Save to `localStorage`.
4. **No shell-escaping surprises:** when copying connection strings, copy the raw URL. Only wrap in single quotes when composing the full `cch connect` or `ccd connect` command.
5. **Mobile responsive:** sidebar hidden by default, hamburger menu to open. Main content full-width.
6. **Accessibility:** all interactive elements have hover states, focus rings, and `cursor: pointer`.

---

## 6. API Endpoints

All requests use `Authorization: Bearer <token>` except where noted.

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/auth/bootstrap` | `{token, hostname}` → `{token, accountId, encryption}` |
| `POST` | `/v1/auth/password` | `{username, password}` → `{token, accountId}` |
| `GET` | `/v1/sessions` | List sessions (max 150) |
| `GET` | `/v1/machines` | List machines |
| `GET` | `/v1/sessions/:id/plaintext-messages` | Get session messages |
| `POST` | `/v1/sessions/:id/plaintext-messages` | Send message `{role, content}` |
| `GET` | `/v1/bootstrap-tokens` | List user's tokens |
| `POST` | `/v1/bootstrap-tokens` | Create token `{label?}` → `{token, record: {connectionUrl, ...}}` |
| `PATCH` | `/v1/bootstrap-tokens/:id` | Update label `{label}` |
| `POST` | `/v1/bootstrap-tokens/:id/revoke` | Revoke token |
| `GET` | `/v1/admin/stats` | Admin stats (auth via `Bearer ADMIN_PASSWORD`) |
| `GET` | `/v1/admin/accounts` | List accounts |
| `POST` | `/v1/admin/accounts` | Create account `{username, password?}` |
| `DELETE` | `/v1/admin/accounts/:id` | Delete account |

---

## 7. Files

| File | Purpose |
|---|---|
| `server/user.html` | User dashboard HTML + CSS |
| `server/user.js` | User dashboard logic |
| `server/admin.html` | Admin panel HTML + CSS |
| `server/admin.js` | Admin panel logic |

Constraints:
- Plain HTML/CSS/JS. No frameworks, no bundlers, no external CSS/JS CDNs.
- Keep all CSS in `<style>` tags, all JS in `<script src="...">` or inline `<script>`.
- Use `var`, not `const`/`let` in global scope for consistency with existing code.
- All API calls use the `api()` helper pattern already established.

---

## 8. Acceptance Criteria

- [ ] Default theme is light; toggle persists to `localStorage`.
- [ ] Sidebar width is draggable and persisted.
- [ ] Sessions show relative time that updates on refresh.
- [ ] Login screen supports both Token and Password tabs.
- [ ] Token modal generates connection URLs and offers cch/ccd/raw copy buttons.
- [ ] Token list allows inline label editing and revoke.
- [ ] Messages render with role-based styling and code blocks with copy buttons.
- [ ] Input area only appears for plaintext sessions.
- [ ] Admin panel allows creating accounts with optional password.
- [ ] Admin panel allows deleting accounts with confirmation.
- [ ] Mobile view (<768px) works with hamburger menu.
- [ ] No external dependencies beyond what is already in the repo.
