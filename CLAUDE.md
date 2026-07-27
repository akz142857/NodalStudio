# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Nodal Studio is a local-first "living blueprint" for software systems: it introspects PostgreSQL/MySQL schemas (read-only, metadata only), renders an ER model, tracks structural change history, layers user-authored semantics (domains, annotations, logical relationships) on top of the physical model, links database objects to application code, and offers AI-assisted explanations — all without ever reading table row data. It ships as a Tauri desktop app, with an optional cloud sync/read-only-share stack (Axum API + Postgres + a separately deployed web viewer).

The full product/engineering scope is [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md); implementation evidence is tracked in [docs/IMPLEMENTATION_STATUS.md](./docs/IMPLEMENTATION_STATUS.md); the Git-collaboration file format is [docs/GIT_WORKSPACE.md](./docs/GIT_WORKSPACE.md).

## Repository layout

This is a combined pnpm + Cargo workspace:

- `apps/frontend` — React 19 + Vite + TypeScript UI (works standalone in a browser, or embedded in Tauri).
- `apps/desktop/src-tauri` — Tauri 2 shell. `src/lib.rs` (~6.7k lines) is the entire Tauri command surface: it imports every domain crate and exposes ~100 `#[tauri::command]` functions via a single `generate_handler!` call at the bottom of the file.
- `apps/cloud-api` — Axum service for metadata-only schema sync and read-only share links (Postgres-backed, sqlx migrations in `apps/cloud-api/migrations`).
- `crates/*` — pure-Rust domain crates shared between the desktop app and the cloud API (see Architecture below).
- `infrastructure/` — docker-compose files for the cloud stack, the MySQL fixture, and the Postgres integration-test fixture.
- `fixtures/` — Postgres/MySQL fixture SQL used by adapter integration tests.
- `Scripts/` — macOS release/signing/notarization scripts (Developer ID DMG and Mac App Store `.pkg`).
- `config/` — example env files for the two macOS release pipelines (never commit the filled-in `.env`).

## Common commands

Node/frontend (run from repo root; `pnpm` filters into `apps/frontend` or `apps/desktop`):

```bash
pnpm install
pnpm dev                 # vite dev server for the web frontend alone
pnpm dev:desktop         # tauri dev — full desktop app
pnpm typecheck           # tsc -b --pretty false
pnpm lint                # eslint . --max-warnings 0
pnpm test                # vitest run
pnpm build:web           # tsc -b && vite build
```

Run a single frontend test file or pattern directly with vitest (from `apps/frontend`):

```bash
pnpm --filter @nodalstudio/frontend exec vitest run src/components/ConnectionPanel.test.tsx
pnpm --filter @nodalstudio/frontend exec vitest run -t "name fragment"
```

Rust:

```bash
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace                       # all unit tests across every crate
cargo test -p schema-diff                     # single crate
cargo test -p schema-diff some_test_name      # single test
```

Rust integration tests require live fixtures and are excluded from a plain `cargo test --workspace` run in CI unless the DB env var is set:

```bash
# Postgres introspection (needs infrastructure/docker-compose.test.yml or .mysql.yml up)
docker compose -f infrastructure/docker-compose.test.yml up -d --wait
TEST_DATABASE_URL=postgres://nodalstudio:nodalstudio@127.0.0.1:55432/nodalstudio_test \
  cargo test -p postgres-adapter --test introspection
docker compose -f infrastructure/docker-compose.test.yml down

# MySQL introspection
docker compose -f infrastructure/docker-compose.mysql.yml up -d --wait
TEST_MYSQL_DATABASE_URL=mysql://nodalstudio:nodalstudio@127.0.0.1:53306/nodalstudio_test \
  cargo test -p mysql-adapter --test introspection
docker compose -f infrastructure/docker-compose.mysql.yml down

# Cloud API concurrency/sharing workflows (needs a Postgres instance)
TEST_CLOUD_DATABASE_URL=postgres://nodalstudio:nodalstudio@127.0.0.1:55433/nodalstudio_cloud_test \
  cargo test -p nodalstudio-cloud-api --test cloud_workflows
```

Desktop bundle:

```bash
pnpm --filter @nodalstudio/desktop tauri build --bundles app
```

Cloud stack locally:

```bash
docker compose -f infrastructure/docker-compose.cloud.yml up --build
# open http://localhost:8088/?share=<viewer-token>
```

macOS signed release / App Store package — see README.md; entry points are `pnpm release:macos`, `pnpm release:macos:appstore`, and `./Scripts/build_macos_release.sh --check` / `./Scripts/build_macos_appstore.sh --check` for dry-run validation. Requires `config/macos-release.env` / `config/macos-appstore.env` copied from the checked-in `.example` files and filled in locally — never commit those filled-in files.

CI (`.github/workflows/ci.yml`) runs `frontend`, `rust`, `postgres-integration`, `mysql-integration`, `cloud-integration`, and `desktop-build` as separate jobs; the Rust job runs on `macos-latest` and requires Rust 1.95.0 exactly.

## Architecture

### Rust domain crates (`crates/*`)

Each crate is (almost always) a single `src/lib.rs` with a one-line `//!` doc comment describing its purpose — read that line first when orienting in an unfamiliar crate. Dependency flow is roughly bottom-up:

- **`schema-model`** — the foundational, database-independent schema types (tables, columns, FKs, indexes, enums, snapshots) and their canonical fingerprinting. Nearly everything else depends on this.
- **`postgres-adapter`** / **`mysql-adapter`** — read-only introspection over `information_schema`/system catalogs, producing a `DatabaseSnapshot`. Never issue DDL, never read row data, never persist passwords.
- **`schema-diff`** — structural diffing between two canonical snapshots into a `SchemaChangeSet`.
- **`semantic-model`** — user-authored meaning (domain groups, annotations, saved views) layered on top of immutable physical snapshots; never mutates the physical model.
- **`extension-model`** — database-independent provenance, drift comparison, and code-lineage types, built on `schema-diff`/`schema-model`.
- **`project-model`** — local-project/scan/system-graph/model-routing domain types (the "code + AI" side, as opposed to the "database" side).
- **`project-scanner`** — safe, non-executing local project discovery and incremental file fingerprinting (never executes scanned code).
- **`code-analysis`** — deterministic, evidence-producing static analysis (TypeScript, Prisma, polyglot) that links code to schema objects; submodules `typescript.rs`, `prisma.rs`, `polyglot.rs`.
- **`project-graph`** — deterministic aggregation of `ProjectNode`/`ProjectEdge` into a graph plus reverse code-impact traversal.
- **`ai-provider`** — provider-neutral AI connection/capability abstraction (includes a deterministic `OfflineProvider` and an `OpenAiCompatibleProvider`); routes by `ModelRole`.
- **`ai-context`** — privacy-bounded context selection (what schema context is safe to send to an AI provider) and provider-independent explanation generation.
- **`query-engine`** — safe, bounded, read-only query execution; `guard.rs` validates queries are actually read-only before `postgres.rs` runs them. Enforces `DEFAULT_ROW_LIMIT`/`MAX_ROW_LIMIT`.
- **`settings-model`** — versioned (`SETTINGS_SCHEMA_VERSION`), non-sensitive settings shared by desktop persistence and policy evaluation.
- **`snapshot-store`** — local SQLite persistence for immutable snapshots and change sets; the largest crate (~3.3k lines) since it owns most of the desktop's local database schema/migrations logic.
- **`git-workspace`** — reads/writes/previews/renders the deterministic split-file `.nodalstudio/` Git format (see `docs/GIT_WORKSPACE.md`) and its field-aware three-way JSON merge driver.

When changing a shared type, check all downstream crates in this list (via `pnpm`/`cargo` dependency graph, i.e. `Cargo.toml` `[dependencies]`) rather than assuming a change is local.

### Two runtimes share the domain crates

- `apps/desktop/src-tauri` wires every crate above into Tauri commands (all in the one `lib.rs`). This is where privacy-boundary enforcement (e.g. "never send credentials to AI context", "recursively reject row data before cloud publish") is glued together at the call-site level.
- `apps/cloud-api` is a much smaller Axum service that only handles metadata sync and share-link serving; it depends on a subset of the crates (`schema-model`, `schema-diff`, `project-model`) and has its own Postgres migrations.

### Frontend (`apps/frontend/src`)

- **`platform/`** — the key abstraction: `NodalStudioPlatform` (`types.ts`) is implemented by both `tauri-platform.ts` (invokes Tauri commands) and `web-platform.ts` (talks to the cloud API / runs in a plain browser). `getPlatform()` in `index.ts` picks the implementation at runtime via `isTauri()`. **New features that need backend data must extend this interface and both implementations**, not just call `invoke()` directly from a component.
- **`components/`** — one file per panel/feature (e.g. `SchemaCanvas.tsx`, `ChangeImpactPanel.tsx`, `GitWorkspacePanel.tsx`, `AiAssistant.tsx`, `ConnectionPanel.tsx`, `SettingsPage.tsx`); most have a co-located `*.test.tsx`.
- **`graph/`** — ER/system-map graph construction and layout logic decoupled from React, including `elk-layout.ts` (ELK.js layout) run inside `layout.worker.ts` (a Web Worker, since layout is CPU-heavy), plus `schema-search.ts`, `change-impact.ts`, `relationship-interaction.ts`.
- State: Zustand; graph rendering: `@xyflow/react`; SQL editing: CodeMirror 6 (`@codemirror/*`).

## Privacy/architecture invariants worth preserving

These are load-bearing product guarantees, not incidental behavior — respect them when touching adjacent code:

- Introspection is metadata-only: no application table rows are ever read, and no DDL is executed against a connected database.
- Database credentials are never stored in SQLite; they go through the OS keychain (`keyring` crate).
- Cloud publishing is opt-in and recursively strips credential/row-data fields before anything leaves the desktop app.
- The `.nodalstudio/` Git export excludes snapshot bodies, canvas layouts, credentials, cloud tokens, local IDs, and row data — it is reviewable team knowledge, not an alternative source of truth for the schema.
- `query-engine` must reject anything that isn't a read-only query (`guard.rs`) before executing it.
