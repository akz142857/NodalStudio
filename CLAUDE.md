# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Nodal Studio is a local-first "living blueprint" for database schemas: it introspects PostgreSQL/MySQL (read-only, metadata only), renders an ER model, tracks structural change history, layers user-authored semantics (domains, annotations, logical relationships) on top of the physical model, runs bounded read-only queries, and offers AI-assisted explanations — all without ever reading application row data. It ships as a Tauri 2 desktop app, with an optional cloud sync / read-only-share stack (Axum API + Postgres + a web viewer served from the same frontend bundle).

The product/engineering scope is [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md); implementation evidence is tracked in [docs/IMPLEMENTATION_STATUS.md](./docs/IMPLEMENTATION_STATUS.md); the Git-collaboration file format is [docs/GIT_WORKSPACE.md](./docs/GIT_WORKSPACE.md).

## Repository layout

Combined pnpm + Cargo workspace:

- `apps/frontend` — React 19 + Vite + TypeScript UI (runs standalone in a browser as the cloud web viewer, or embedded in Tauri).
- `apps/desktop/src-tauri` — Tauri shell. `src/lib.rs` (~5k lines) is the entire Tauri command surface: it imports every domain crate and exposes ~79 `#[tauri::command]` functions via a single `generate_handler!` call near the bottom (~line 4739). Its unit tests live in the `mod tests` block at the end of the same file.
- `apps/cloud-api` — Axum service for metadata-only schema sync and read-only share links (Postgres, sqlx migrations in `apps/cloud-api/migrations`).
- `crates/*` — pure-Rust domain crates shared by the desktop app and the cloud API.
- `infrastructure/` — docker-compose for the cloud stack, the MySQL fixture, and the Postgres integration-test fixture.
- `fixtures/` — Postgres/MySQL fixture SQL used by adapter integration tests.
- `Scripts/`, `config/` — macOS release/signing/notarization (Developer ID DMG and Mac App Store `.pkg`) and their example env files. Never commit the filled-in `config/*.env`.

## Common commands

Node/frontend (from repo root; root scripts just `pnpm --filter` into `apps/frontend` or `apps/desktop`):

```bash
pnpm install
pnpm dev                 # vite dev server (port 1420) for the web frontend alone
pnpm dev:desktop         # tauri dev — full desktop app
pnpm typecheck           # tsc -b --pretty false
pnpm lint                # eslint . --max-warnings 0
pnpm test                # vitest run
pnpm build:web           # tsc -b && vite build
```

Single frontend test file or pattern:

```bash
pnpm --filter @nodalstudio/frontend exec vitest run src/components/ConnectionPanel.test.tsx
pnpm --filter @nodalstudio/frontend exec vitest run -t "name fragment"
```

Rust (toolchain pinned to 1.95 by `rust-toolchain.toml`; CI requires exactly 1.95.0):

```bash
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace                    # unit tests across every crate
cargo test -p schema-diff                 # single crate
cargo test -p schema-diff some_test_name  # single test
```

The workspace sets `unsafe_code = "forbid"` and enables clippy `pedantic` — new code must pass `-D warnings` under pedantic, not just default lints.

Integration tests need live fixtures and are skipped by a plain `cargo test --workspace` unless the DB env var is set (CI runs them as separate jobs):

```bash
# Postgres introspection
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

Desktop bundle and local cloud stack:

```bash
pnpm --filter @nodalstudio/desktop tauri build --bundles app
docker compose -f infrastructure/docker-compose.cloud.yml up --build
# open http://localhost:8088/?share=<viewer-token>
```

macOS signed release / App Store package — see README.md; entry points are `pnpm release:macos`, `pnpm release:macos:appstore`, and `./Scripts/build_macos_release.sh --check` / `./Scripts/build_macos_appstore.sh --check` for dry-run validation.

## Architecture

### Rust domain crates (`crates/*`)

Each crate is a single `src/lib.rs` (except `query-engine` and `git-workspace`) opening with a one-line `//!` doc comment stating its purpose — read that line first when orienting. `Cargo.toml` `[workspace] members` is the authoritative crate list. Dependency flow is roughly bottom-up:

- **`schema-model`** — foundational database-independent schema types (tables, columns, FKs, indexes, enums, snapshots) and their canonical fingerprinting. Nearly everything depends on this.
- **`postgres-adapter`** / **`mysql-adapter`** — read-only introspection over `information_schema`/system catalogs producing a `DatabaseSnapshot`. Never issue DDL, never read row data, never persist passwords.
- **`schema-diff`** — structural diffing between two canonical snapshots into a `SchemaChangeSet`.
- **`semantic-model`** — user-authored meaning (domain groups, annotations, saved views) layered over immutable physical snapshots; never mutates the physical model.
- **`extension-model`** — database-independent provenance, drift comparison, and code-lineage types, built on `schema-diff`/`schema-model`.
- **`ai-context`** — privacy-bounded context selection (`ContextPolicy` decides what schema context is safe to send) plus provider-independent `Explanation` generation, including a deterministic `OfflineSchemaProvider`.
- **`query-engine`** — safe, bounded, read-only query execution. `guard.rs` validates a query is genuinely read-only before `postgres.rs` runs it; `DEFAULT_ROW_LIMIT` (100) / `MAX_ROW_LIMIT` (5000) are enforced here.
- **`settings-model`** — versioned (`SETTINGS_SCHEMA_VERSION`) non-sensitive settings shared by desktop persistence and policy evaluation. Mirrored on the frontend by `platform/settings-types.ts` + `settings-migration.ts`; changing one side requires updating the other.
- **`snapshot-store`** — local SQLite persistence for immutable snapshots and change sets; the largest crate (~2.6k lines) and owner of the desktop's local schema/migrations. Bump `LOCAL_SCHEMA_VERSION` and add the migration step when its tables change.
- **`git-workspace`** — reads/writes/previews/renders the deterministic split-file `.nodalstudio/` Git format (see `docs/GIT_WORKSPACE.md`). Also ships the `src/bin/nodalstudio-semantic-merge.rs` binary — the field-aware three-way JSON merge driver Git invokes.

When changing a shared type, walk the downstream crates via `Cargo.toml` `[dependencies]` rather than assuming the change is local.

### Two runtimes share the domain crates

- `apps/desktop/src-tauri` wires every crate into Tauri commands in the one `lib.rs`. This is where privacy-boundary enforcement is glued together at the call site ("never send credentials to AI context", "recursively reject row data before cloud publish"), along with keychain access, connection pooling, and cancellation (`Semaphore` + `CancellationToken`).
- `apps/cloud-api` is a much smaller Axum service handling only metadata sync and share-link serving; it depends on a subset of the crates (`schema-model`, `schema-diff`, `semantic-model`, `settings-model`) and owns its own Postgres migrations.

### Frontend (`apps/frontend/src`)

- **`platform/`** — the key abstraction. `NodalStudioPlatform` (`types.ts`, ~500 lines in) is implemented by both `tauri-platform.ts` (invokes Tauri commands) and `web-platform.ts` (talks to the cloud API / plain browser). `getPlatform()` in `index.ts` picks at runtime via `isTauri()`. **New features needing backend data must extend the interface and both implementations** — do not call `invoke()` directly from a component.
- **`components/`** — one file per panel (`SchemaCanvas.tsx`, `HistoryPanel.tsx`, `ProvenancePanel.tsx`, `GitWorkspacePanel.tsx`, `CloudSyncPanel.tsx`, `AiAssistant.tsx`, `ConnectionPanel.tsx`, `SettingsPage.tsx`, …), with feature subfolders `query/` (CodeMirror SQL editor, result grid, history) and `relationships/`. Most files have a co-located `*.test.tsx`.
- **`graph/`** — ER/system-map graph construction and layout decoupled from React: `schema-graph.ts`, `schema-search.ts`, `relationship-interaction.ts`, `layout-components.ts`, and `elk-layout.ts` (ELK.js) run inside `layout.worker.ts` (a Web Worker, since layout is CPU-heavy).
- State: Zustand + TanStack Query; graph rendering: `@xyflow/react`; SQL editing: CodeMirror 6.

## Privacy/architecture invariants worth preserving

Load-bearing product guarantees, not incidental behavior:

- Introspection is metadata-only: no application table rows are ever read via introspection, and no DDL is executed against a connected database.
- Database credentials are never stored in SQLite; they go through the OS keychain (`keyring` crate).
- Cloud publishing is opt-in and recursively strips credential/row-data fields before anything leaves the desktop app.
- The `.nodalstudio/` Git export excludes snapshot bodies, canvas layouts, credentials, cloud tokens, local IDs, and row data — it is reviewable team knowledge, not an alternative source of truth for the schema.
- `query-engine` must reject anything that isn't a read-only query (`guard.rs`) before executing it, and honor the row-limit ceiling.
