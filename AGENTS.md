# AGENTS.md — CCH Monorepo Guide

This file is the entry point for AI coding agents working in the `self_host_happy` repository. It describes the project as it actually exists today, the boundaries between workspaces, the commands you need, and the conventions that are enforced in each part of the codebase.

If you are working inside a single workspace, also read that workspace's local agent doc:

- `cli/AGENTS.md` and `cli/ARCHITECTURE.md` for the Rust CLI
- `server/CLAUDE.md` for the Node.js server
- `app/CLAUDE.md` for the Expo/Tauri app

---

## 1. Project Overview

CCH ("Claude Code with Happy") is a self-hosted aggregation system for Claude Code sessions. The goal is to run a single server (for example on Alibaba Cloud) that collects sessions from many machines, then let a user watch progress from a phone or browser.

High-level architecture:

```
┌─────────────────────────────────────────────────────────────────────┐
│ cch (Rust CLI) ──HTTP/Socket.IO──→ cch-server (Node.js + PGlite)   │
│     exec claude                       ↑                              │
│                                       │ browser / mobile             │
│                    GitHub Actions ────┘                              │
└─────────────────────────────────────────────────────────────────────┘
```

- **`cli/`** — `cch` and `ccd` binaries written in Rust. `cch` is a TUI launcher for `claude`/`codex`/`kimi` with named profiles, plus Happy-server connection commands. `ccd` is the daemon that reports local sessions to the server.
- **`server/`** — `cch-server` (also historically called `happy-server`). Fastify + TypeScript. Serves the web dashboard (`/admin`, `/`) and the API, stores encrypted session data, and synchronizes devices over Socket.IO.
- **`app/`** — React Native mobile app built with Expo SDK ~55, plus a Tauri-based macOS desktop wrapper. It is the Happy client that connects to the same server.
- **`packages/wire/`** — shared TypeScript/Zod wire protocol consumed by the server, the CLI, and the app. The package name in this repo is `@cch/wire`.

The repository is a **pnpm workspace** (`pnpm-workspace.yaml` lists `server` and `packages/wire`). The CLI and app are not pnpm workspaces but live as separate subprojects under the same repository root.

> Note: the codebases for `server/` and `app/` originate from the "Happy" project, while `cli/` is a Rust TUI launcher originally called `cct` that has been adapted for CCH. You will see both naming conventions in files, env vars, and URLs. Treat `cch`/`happy`/`handy` as the same lineage unless the local doc says otherwise.

---

## 2. Technology Stack

| Area | Technology |
|------|------------|
| Package manager | pnpm 10.11.0 (monorepo + app + server) |
| CLI | Rust 2021 edition, Cargo, `clap`, `ratatui`, `crossterm`, `tokio`, `reqwest`, `rust_socketio` |
| Server runtime | Node.js 20, TypeScript 5.9.3, `tsx` |
| Server framework | Fastify 5 with `fastify-type-provider-zod` |
| Server DB | Prisma 6.19.2 + PostgreSQL; standalone mode uses PGlite 0.3.15 |
| Server cache/pub-sub | Redis (`ioredis`) in production; in-memory event bus in standalone |
| Server real-time | Socket.IO 4 |
| App | Expo SDK ~55, React Native 0.83.1, React 19.2.0, TypeScript strict, `react-native-unistyles` |
| App desktop wrapper | Tauri 2 (`app/src-tauri/`) |
| Shared schemas | Zod 4 in `@cch/wire` |
| Tests | Vitest (TypeScript), `cargo test` (Rust), BATS (shell) |
| Deployment | Docker, Docker Compose, GitHub Actions → GHCR → Alibaba Cloud ECS |

---

## 3. Repository Layout

```
self_host_happy/
├── cli/                     # Rust CLI (cch + ccd)
│   ├── Cargo.toml           # package name is still "cct" for historical reasons
│   ├── src/                 # main.rs (cch), daemon.rs (ccd), lib.rs, modules
│   ├── tests/               # integration.rs, live.rs, install.bats
│   ├── AGENTS.md            # detailed CLI agent guide
│   └── ARCHITECTURE.md      # full architecture doc
├── server/                  # cch-server / happy-server
│   ├── package.json         # workspace package "cch-server"
│   ├── sources/             # all TypeScript source
│   │   ├── standalone.ts    # PGlite bootstrap + migrate/serve CLI
│   │   ├── main.ts          # external-DB entry point
│   │   ├── index.ts         # library entry point
│   │   ├── app/api/         # Fastify routes, socket handlers, auth
│   │   ├── storage/         # db, files, pgliteLoader, upload helpers
│   │   ├── modules/         # encrypt, github
│   │   └── utils/           # log, shutdown, backoff, lock, etc.
│   ├── prisma/schema.prisma # single source of truth for DB schema
│   ├── user.html / user.js  # user dashboard (being rewritten per spec.md)
│   ├── admin.html / admin.js# admin dashboard
│   ├── Dockerfile           # standalone single-container build
│   ├── deploy/handy.yaml    # Kubernetes manifest (production cluster)
│   └── CLAUDE.md            # detailed server agent guide
├── app/                     # Expo React Native + Tauri desktop app
│   ├── package.json         # package name "happy-app"
│   ├── app.config.js        # Expo config with dev/preview/production variants
│   ├── sources/             # app code, components, sync, encryption, text
│   ├── src-tauri/           # Tauri Rust project
│   └── CLAUDE.md            # detailed app agent guide
├── packages/wire/           # shared wire protocol
│   ├── package.json         # package name "@cch/wire"
│   └── src/                 # messages.ts, sessionProtocol.ts, etc.
├── .github/workflows/       # build-image.yml, deploy.yml (root repo)
├── docker-compose.yml       # production self-host Compose
├── pnpm-workspace.yaml      # server + packages/wire
├── package.json             # root scripts only
└── .npmrc                   # shamefully-hoist=true, node-linker=hoisted
```

---

## 4. Build & Test Commands

Run all commands from the relevant workspace directory unless otherwise noted.

### Root

```bash
pnpm install                 # install all workspace dependencies
pnpm server:dev              # pnpm --filter cch-server standalone:dev
pnpm server:build            # pnpm --filter cch-server build
pnpm wire:build              # pnpm --filter @cch/wire build
```

### Server

```bash
cd server
pnpm install
pnpm standalone:dev          # recommended local dev: PGlite + .env.dev on port 3005
pnpm standalone              # run with PGlite, env vars supplied by you
pnpm dev                     # external Postgres + Redis mode (needs Docker services)
pnpm build                   # TypeScript type-check only (runtime uses tsx)
pnpm test                    # vitest run
pnpm generate                # regenerate Prisma client
pnpm migrate                 # run Prisma migrations against external Postgres
```

### CLI

```bash
cd cli
cargo build                  # debug build
cargo build --release        # release build
cargo test                   # unit + integration tests
cargo test --test integration# mock E2E (no real claude binary)
CCT_LIVE_TESTS=1 cargo test --test live   # live E2E (needs real claude binary)
cargo clippy                 # lint
cargo run                    # run the TUI
cargo run --release -- run   # run a profile directly
bats tests/install.bats      # shell installer tests (requires bats-core)
```

### App

```bash
cd app
pnpm install
pnpm start                   # Expo development server
pnpm ios                     # iOS simulator
pnpm android                 # Android emulator
pnpm web                     # web target
pnpm typecheck               # run tsc --noEmit after changes
pnpm test                    # vitest (watch mode)

# macOS Tauri desktop
pnpm tauri:dev               # dev with hot reload
pnpm tauri:build:production  # production build
```

### Wire package

```bash
cd packages/wire
pnpm install
pnpm build                   # pkgroll build (requires dist before dependents typecheck)
pnpm test                    # build + vitest run
```

---

## 5. Development Workflow

1. **Install dependencies.** The root `pnpm install` covers the pnpm workspaces (`server`, `packages/wire`). The `app/` and `cli/` directories have their own dependency trees and must be installed separately:
   ```bash
   pnpm install                 # root workspaces
   cd app && pnpm install       # Expo/React Native app
   cd cli && cargo fetch        # Rust CLI
   ```
2. **Build `@cch/wire` before typechecking the server:**
   ```bash
   pnpm wire:build
   ```
   The server imports `@cch/wire` through its `dist/` exports, so a clean checkout will fail `pnpm server:build` until wire is built.
3. **Start the server locally:**
   ```bash
   cd server
   pnpm standalone:dev
   ```
   This loads `.env.dev`, applies PGlite migrations, seeds the admin user via `sources/init.ts`, and serves on `http://localhost:3005`. Admin is at `/admin` (default password `admin123` from local dev setup).
4. **Build and run the CLI:**
   ```bash
   cd cli
   cargo build --release
   ./target/release/cch connect "http://localhost:3005/connect?token=xxx"
   ./target/release/cch run --profile default "hello"
   ```
5. **Run tests before committing.** Server tests use Vitest with `tsconfigPaths`; CLI tests use Cargo.

---

## 6. Code Style & Conventions

### TypeScript (server, app, wire)

- **Indentation: 4 spaces.** This is enforced in server and app docs; do not use 2 spaces.
- **Strict TypeScript** is enabled everywhere.
- **Absolute imports** with the `@/` alias mapping to `./sources/*`.
- Prefer **interfaces over types**.
- **Avoid enums**; use string-literal maps or const objects instead.
- Prefer **functional/declarative** patterns; classes are rare.
- Use descriptive boolean names (`isLoading`, `hasError`).
- Test files use `.spec.ts` or `.test.ts` suffixes.
- Server action files should be named with an entity prefix then action, e.g. `friendAdd.ts`.

### Rust (cli)

- Standard `cargo fmt` formatting (`rustfmt`).
- `cargo clippy -- -D warnings` is enforced in CI.
- No shared mutable global state; modules are flat and focused.
- Use `anyhow` for error handling.
- Use `toml_edit` for surgical config edits so user comments are preserved.

### App-specific conventions

- All user-visible strings must go through the `t(...)` translation function; add keys to all languages in `sources/text/translations/`.
- Use `react-native-unistyles` `StyleSheet.create` for styling; keep styles at the bottom of component files.
- Wrap pages in `memo`.
- Use `expo-router` APIs, not raw `react-navigation` APIs.
- Use `useHappyAction` for async operations instead of manual error handling.
- Do **not** use the React Native `Alert` module; use `@/modal` instead.
- Do **not** use Unistyles for `expo-image` sizing/tint; use inline styles for those.

---

## 7. Testing Strategy

| Component | Framework | Notes |
|-----------|-----------|-------|
| Server | Vitest | `pnpm test` discovers `**/*.test.ts` and `**/*.spec.ts` with `vite-tsconfig-paths`. |
| Wire | Vitest | `pnpm test` builds first, then runs tests. |
| App | Vitest | `pnpm test` runs watch mode; many unit tests exist under `sources/`. |
| CLI | Cargo + BATS | Unit tests inline in source; integration tests in `tests/`; live tests gated by `CCT_LIVE_TESTS=1`. |

When adding utilities, the server convention is to **write the test before the implementation**. Do not add tests only as an afterthought for shared utilities.

### Important CLI test env vars

- `CCT_CONFIG` — override the TOML config path for tests.
- `CCT_KIMI_CONFIG` — override `~/.kimi-code/config.toml` path for tests.
- `CCT_CLAUDE_BIN` — substitute a fake binary for `check_claude_installed`.
- `CCT_LIVE_TESTS=1` — enable the live E2E suite.

---

## 8. Database & Migrations

- The single schema file is `server/prisma/schema.prisma`.
- In standalone/self-host mode the server uses **PGlite** (embedded Postgres) and applies SQL migrations from `server/prisma/migrations/` via `sources/standalone.ts`.
- In production it uses external PostgreSQL via `DATABASE_URL` and Prisma Migrate.
- **Do not create migrations yourself.** The server `CLAUDE.md` explicitly states migrations are created only by humans. Run `pnpm generate` when you need new Prisma types.
- Use `inTx` to wrap DB operations in transactions.
- Do not run non-transactional side effects (file uploads, external API calls) inside transactions.

---

## 9. Deployment Processes

### Self-hosted Docker / Docker Compose

```bash
docker compose up -d
# or pull the published image first:
docker compose pull && docker compose up -d
```

`docker-compose.yml` uses `ghcr.io/stoodcoronet/cch-server:latest` and expects:

- `HANDY_MASTER_SECRET`
- `ADMIN_PASSWORD`
- `PORT=3005`

Data is persisted in the `cch-data` volume.

### CI/CD

- `.github/workflows/build-image.yml` — builds the server Docker image and pushes to GHCR on every push to `master` that touches server/wire/build files.
- `.github/workflows/deploy.yml` — waits 120 seconds for the image build, then SSHs into the Alibaba Cloud ECS host, pulls the image, and restarts Docker Compose.
- `cli/.github/workflows/ci.yml` — runs `cargo fmt --check`, `cargo clippy`, and `cargo test` on push/PR to `master`.
- `cli/.github/workflows/release.yml` — builds cross-platform release tarballs (`cct-<target>.tar.gz`) on version tags `v*`.

### Kubernetes

`server/deploy/handy.yaml` contains the production Kubernetes manifest for a 3-replica `handy-server` Deployment, Redis StatefulSet, ExternalSecret integration with Vault, Prometheus scrape annotations, and liveness/readiness probes on `/health`.

---

## 10. Security Considerations

- **End-to-end encryption:** session messages and machine metadata are encrypted on the client before reaching the server. The server stores only opaque encrypted blobs.
- **Cryptographic auth:** the auth model uses public-key signatures, not passwords stored on the server.
- **Bootstrap tokens:** self-hosted server provisioning uses `BootstrapToken` records with hashed tokens; tokens are generated in the admin dashboard and consumed by `cch connect <url>`.
- **Secrets masking:** in the CLI, env keys containing `TOKEN`, `KEY`, or `SECRET` are redacted in the TUI and confirmation screens.
- **Required secrets:**
  - `HANDY_MASTER_SECRET` — master secret for server auth/encryption.
  - `ADMIN_PASSWORD` — initial admin password for `/admin`.
- **ATS / network policy:** the iOS app allows local-network access and, in dev/preview, arbitrary HTTP loads so developers can test against a local server without TLS.
- **Attachment storage:** blobs are client-encrypted. When S3 is used, enable lifecycle expiration and SSE for defense-in-depth.

---

## 11. Environment Variables Quick Reference

### Server

| Variable | Required? | Default | Purpose |
|----------|-----------|---------|---------|
| `HANDY_MASTER_SECRET` | yes | — | Master secret for auth/encryption |
| `PORT` | no | 3005 | HTTP port |
| `HOST` | no | 0.0.0.0 | Bind host |
| `DATA_DIR` | no | `./data` | Base data directory |
| `PGLITE_DIR` | no | `DATA_DIR/pglite` | PGlite database directory |
| `DATABASE_URL` | no | — | External Postgres URL (bypasses PGlite) |
| `REDIS_URL` | no | — | Redis URL (optional for standalone) |
| `S3_HOST` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` | no | — | S3/MinIO file storage |
| `PUBLIC_URL` | no | `http://localhost:3005` | Public base URL for file URLs |
| `HAPPY_STATIC_DIR` | no | auto | Static webapp directory |
| `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` | no | — | Enables remote log collection to `.logs/` |

### CLI

| Variable | Purpose |
|----------|---------|
| `CCT_CONFIG` | Override `profiles.toml` path |
| `CCT_KIMI_CONFIG` | Override `~/.kimi-code/config.toml` path |
| `CCT_CLAUDE_BIN` | Substitute binary name for install checks |
| `CCT_LIVE_TESTS` | Enable live E2E tests |
| `EDITOR` | Editor opened by `cch edit` (fallback `vi`) |

---

## 12. Cross-Cutting Conventions

- **Do not create files unless absolutely necessary.** Prefer editing existing files. This rule is repeated strongly in `server/CLAUDE.md` and `app/CLAUDE.md`.
- **Do not proactively create documentation files** (`*.md`, READMEs) unless explicitly requested.
- **Never create Prisma migrations yourself.**
- **Always run `pnpm typecheck` after TypeScript changes** in `app/` or `server/`.
- **Always run `cargo clippy` and `cargo test` after Rust changes** in `cli/`.
- **Build `@cch/wire` before typechecking dependents** on a clean checkout.
- Keep PRs minimal and scoped; avoid opportunistic refactors.
- If you change a cross-workspace wire schema, bump the wire package version and update all consumers.

---

## 13. Useful Links

- `README.md` — Chinese-language quick start and architecture diagram
- `spec.md` / `docs/UI_SPEC.md` — Web UI redesign spec (Chinese)
- `cli/ARCHITECTURE.md` — full CLI architecture
- `cli/AGENTS.md` — CLI agent guide
- `server/CLAUDE.md` — server agent guide
- `app/CLAUDE.md` — app agent guide
- `packages/wire/README.md` — wire protocol specification
