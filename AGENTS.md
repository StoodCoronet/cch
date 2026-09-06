# Repository Guidelines

## Project Overview

CCH ("Claude Code with Happy") — self-hosted aggregation of Claude Code sessions. One server (e.g. Alibaba Cloud) collects sessions from many machines; users watch progress live from a browser or phone (PWA / Android APK). Historical note: `cch` / `happy` / `handy` naming all refer to this codebase — it is a fork of `slopus/happy-server`.

## Architecture & Data Flow

Four components, **two distinct session paths**:

- `server/` — `cch-server`: Fastify 5 + Zod + Prisma 6 over PGlite (embedded Postgres) or external Postgres/Redis. Serves REST + Socket.IO plus embedded dashboards (`admin.html/js`, `user.html/js`, `register.html` with vendored assets in `server/vendor/`).
- `cli/node-ccd/` — **the active client**: `ccd` daemon (npm package `cch-ccd`, plain CommonJS JavaScript). Runs Claude Code sessions in `node-pty` and mirrors them to the server. `cli/` (Rust crate `cct`, bins also named `cch`/`ccd`) is **legacy/historical** — do not extend it for daemon features.
- `app/` — Expo SDK ~55 / React Native 0.83 app (also PWA/web) + Tauri 2 macOS wrapper in `app/src-tauri/`.
- `packages/wire/` — `@cch/wire`: shared Zod schemas + types, dual ESM/CJS built with pkgroll.

Data flow:

- **Plaintext path (ccd)**: daemon tails PTY/JSONL output → `POST /v1/sessions/:id/plaintext-messages` (or socket `ccd-message` event) → `PlaintextMessage` table → user dashboard renders interactive chat.
- **E2E-encrypted path (app/cch)**: client encrypts locally (libsodium/tweetnacl; blobs look like `{t:'encrypted', c:base64}`) → `POST /v3/sessions/:id/messages` (localId dedup + seq allocation) → `eventRouter.emitUpdate` fans seq-numbered `CoreUpdateContainer` over Socket.IO `/v1/updates`.
- **Device onboarding**: dashboard "Connect a Device" creates a `BootstrapToken` (only its SHA-256 hash is meaningful) → `ccd connect '<server>/connect?token=…'` exchanges it via `POST /v1/auth/bootstrap` → token cached in `~/.cch/token`.
- Server-side field encryption (`server/sources/modules/encrypt.ts`, keyed by `HANDY_MASTER_SECRET`) is **server-at-rest** encryption — distinct from the client E2E layer. Never confuse the two.

## Key Directories

| Path | Purpose |
|---|---|
| `server/sources/app/api/routes/` | All HTTP route groups, one file per feature (`authRoutes`, `sessionRoutes`, `v3SessionRoutes`, `adminRoutes`, …) |
| `server/sources/app/api/socket.ts` | Socket.IO server `/v1/updates`: auth middleware + handlers (rpc, session/machine/artifact updates, `ccd-message`) |
| `server/sources/app/events/eventRouter.ts` | Central pub/sub: client registry, `emitUpdate`/`emitEphemeral` with recipient filters |
| `server/sources/storage/` | `db.ts` (Prisma + PGlite/Postgres switch), files, redis, `inTx`, seq allocation |
| `server/sources/app/auth/` | Token auth (`auth.ts` singleton), `bootstrapToken.ts`, password, email codes |
| `server/sources/modules/encrypt.ts` | Server-at-rest KeyTree encryption from `HANDY_MASTER_SECRET` |
| `server/prisma/` | `schema.prisma` (24 models) + SQL migrations (humans-only) |
| `cli/node-ccd/` | Active daemon: `bin/ccd.js`, `daemon.js`, `session.js` (PTY), `attach.js`, `tui.js` (blessed) |
| `cli/` | Legacy Rust `cct` TUI launcher (`src/main.rs` = `cch` bin, `src/daemon.rs` = `ccd` bin) |
| `app/sources/app/` | expo-router page tree (root is `sources/app`, not `app/`) |
| `app/sources/sync/` | Sync engine: `sync.ts` socket.io loop, per-domain `api*.ts`, `reducer/`, `serverConfig.ts` |
| `app/sources/sync/encryption/` | E2E layer: master-secret key derivation, per-session/machine/artifact encryptors |
| `app/sources/text/` | `t()` i18n: `_default.ts` (en base) + `translations/` (10 languages) |
| `app/src-tauri/` | Tauri v2 wrapper hosting `expo export --platform web` output |
| `packages/wire/src/` | `messages.ts` (socket updates), `sessionProtocol.ts` (session envelopes — **frozen, under review**) |
| `patches/`, `scripts/` | pnpm patches (pglite/prisma, preact, livekit) + root `postinstall.cjs`, `release.cjs` |
| `android/` | Gradle project producing the released `app-debug.apk` |
| `docs/` | UI/API specs (`UI_SPEC.md`) + LLM prompt docs |

## Development Commands

```bash
# Root (pnpm workspace = server + packages/wire only)
pnpm install
pnpm wire:build        # REQUIRED before server typecheck/tests on a clean checkout
pnpm server:dev        # server standalone dev on :3005
pnpm server:build      # server typecheck

# Server (cd server)
pnpm standalone:dev    # PGlite + .env.dev, applies migrations, seeds admin; http://localhost:3005/admin (admin123)
pnpm test              # vitest run
pnpm typecheck         # tsc --noEmit  ("build" is the same thing — runtime is tsx, no emit)
pnpm generate          # prisma generate after schema edits (never write migrations yourself)

# Active daemon (cd cli/node-ccd) — npm, NOT pnpm
npm install
npm link               # or run directly: ./bin/ccd.js
node test-e2e.js       # end-to-end check against a running server

# App (cd app) — separate dependency tree, install separately
pnpm install
pnpm start             # Expo dev server (also: ios / android / web)
pnpm typecheck         # run after EVERY change
pnpm test              # vitest — watch mode in a TTY; use `pnpm exec vitest run` for one-shot
pnpm tauri:dev         # macOS desktop wrapper

# Legacy Rust CLI (cd cli)
cargo build && cargo test && cargo clippy -- -D warnings

# Deploy
docker compose up -d   # ghcr.io/stoodcoronet/cch-server + Caddy; data in cch-data:/data
```

## Code Conventions & Common Patterns

TypeScript (all TS workspaces):

- 4-space indent, strict mode, `pnpm` (never npm, except `cli/node-ccd`).
- Absolute imports via `@/*` → `./sources/*` (server and app) / `@/` in app code.
- Prefer interfaces over types; **no enums** — use string-literal maps or const objects.
- Functional/declarative style; avoid classes (singletons like `export const auth = new AuthModule()` are the accepted exception).

Server:

- Routes: `export function xRoutes(app: FastifyInstance)` registered in `api.ts`; validate with Zod schemas via the `fastify-type-provider-zod` type provider; guard with `preHandler: app.authenticate` (admin routes use the `adminAuth` helper instead).
- Action/business files: entity-prefixed camelCase verb — `friendAdd.ts`, `feedGet.ts`; utility filename == function name; folders lowercase-dashed.
- Transactions: wrap DB work in `inTx`; never do non-transactional side effects (uploads, external calls) inside a transaction.
- Logging: `log({ module, level }, msg)` from `@/utils/log`; don't add logging unless asked.
- Base64: use `privacyKit.encodeBase64`/`decodeBase64` instead of Buffer.
- Config is env-var driven at use site (no config framework); background loops are started services with `onShutdown` hooks.
- Write the test (`.spec.ts`) for shared utilities **before** the implementation.

App:

- Every user-visible string through `t()` from `@/text`; add the key to **all** languages in `sources/text/translations/` (dev-only screens exempt).
- Never use React Native `Alert` — use `@/modal` (`Modal.alert`, `Modal.confirm`).
- Wrap pages in `memo`; use expo-router APIs, never raw react-navigation.
- Styling: `StyleSheet.create((theme) => ({…}))` from react-native-unistyles at the bottom of the file; never use unistyles to size/tint `expo-image` (inline styles there).
- Async operations via `useHappyAction` (returns `[loading, doAction]`, auto error handling); core UX principle: "never show a loading error, always just retry".

Legacy Rust (`cli/`): `anyhow::Result` with `.context(...)`; edit TOML configs surgically with `toml_edit` (preserve user comments); mask any env key containing `TOKEN`/`KEY`/`SECRET` on every display path; `cargo clippy -- -D warnings` is enforced.

## Important Files

- `server/sources/standalone.ts` — standalone entry: `migrate` + `serve` (PGlite, port 3005, throws without `HANDY_MASTER_SECRET`)
- `server/sources/main.ts` / `index.ts` — dev entry / library entry (`startServer(opts)`)
- `server/sources/app/api/api.ts` — Fastify assembly: plugins, Zod provider, all route registrations, static/SPA dashboard serving
- `server/sources/storage/db.ts` — Prisma client; `DB_PROVIDER=pglite` vs external `DATABASE_URL`
- `server/prisma/schema.prisma` — single source of truth for the 24 models; migrations are created by humans only
- `server/.env.dev` — local dev env (`ADMIN_PASSWORD=admin123`, `PORT=3005`; `DEV_SEED_ACCOUNTS=true` seeds dev1–3@ccc.local)
- `cli/node-ccd/bin/ccd.js` + `daemon.js` + `session.js` — active daemon entry, lifecycle, PTY session runner
- `app/sources/app/(app)/` — real app screens; `_layout.tsx` files own headers/params
- `app/sources/sync/sync.ts` — ~2800-line sync loop (socket.io, push, artifacts, friends)
- `app/app.config.js` — `APP_ENV` variants (development/preview/production): bundle IDs, ATS rules (dev/preview allow arbitrary HTTP loads)
- `packages/wire/src/messages.ts` / `sessionProtocol.ts` — socket update schemas / frozen session envelopes
- `.github/workflows/build-image.yml`, `deploy.yml` — build GHCR image on master → SSH-deploy to ECS via compose
- `docker-compose.yml` — `cch-server` + Caddy; required env: `HANDY_MASTER_SECRET`, `ADMIN_PASSWORD`, `PORT=3005`

## Runtime/Tooling Preferences

- **pnpm 10.11.0** (`packageManager` pinned). Workspace contains **only** `server` + `packages/wire`; `app/` and `cli/node-ccd/` are separate trees with their own installs (`app/` uses pnpm + patch-package; `node-ccd` uses npm and ships as `cch-ccd`).
- **Node 20**; server runtime is **tsx** — `pnpm build` is typecheck-only, do not add an emit/compile step.
- `@cch/wire` resolves **only** through `dist/` (pkgroll dual ESM/CJS): run `pnpm wire:build` after touching `packages/wire/src` or nothing that imports it will typecheck.
- `.npmrc` uses `shamefully-hoist=true` / `node-linker=hoisted` — undeclared deps may accidentally resolve; still declare what you import.
- Binary patches live in `patches/` (applied by root `scripts/postinstall.cjs`) plus `patch-package` in the app.
- Keep PRs minimal and scoped; no opportunistic refactors; don't create files/docs unless necessary.

## Testing & QA

| Workspace | Framework | Command | Notes |
|---|---|---|---|
| `server` | Vitest | `pnpm test` (`vitest run`) | `globals: true`, `vite-tsconfig-paths`; mixed `*.spec.ts`/`*.test.ts` |
| `app` | Vitest | `pnpm test` (watch in TTY) or `pnpm exec vitest run` | `globals: false` (import from 'vitest'); manual `'@'` alias — colocated under `sources/` |
| `packages/wire` | Vitest | `pnpm test` | **Builds dist first**; `*.test.ts` in `src/` |
| `cli/node-ccd` | script | `node test-e2e.js` | Needs a running server; no unit test setup |
| `cli` (legacy) | cargo + BATS | `cargo test`, `bats tests/install.bats` | Live E2E gated by `CCT_LIVE_TESTS=1`; test isolation via `CCT_CONFIG`, `CCT_KIMI_CONFIG`, `CCT_CLAUDE_BIN` |

- There is **no root test script** — run tests per workspace.
- Don't assume tsconfig paths work in tests: only the server uses `vite-tsconfig-paths`; the app wires the alias manually in `vitest.config.ts`.
- Coverage shape: app (sync/reducer/encryption/utils) and CLI config/args logic are well tested; the server has only ~9 test files — no auth, encryption, or socket tests — so verify server changes with `server/scripts/test-business.sh` or a live `standalone:dev` smoke run.
