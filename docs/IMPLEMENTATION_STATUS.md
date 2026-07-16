# Nodal Studio Implementation Status

This file tracks implementation evidence against [DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md).

## Latest verification evidence

- `cargo fmt --check`: passed.
- `cargo clippy --workspace --all-targets --all-features -- -D warnings`: passed.
- `cargo test --workspace --all-features`: 44 tests passed across the complete workspace.
- PostgreSQL 17 Docker fixture: real introspection integration test passed.
- Frontend TypeScript, ESLint, Vitest, and Vite production build: passed.
- Tauri macOS release and `.app` bundle: built successfully.
- Packaged desktop UI: launched and inspected through an accessibility/UI smoke test.
- Frontend: 25 component/domain tests passed across 15 test files, including Settings search/deep links, managed policy locking, shortcut conflict detection, field-to-field FK ports, composite FK mapping, in-node indexes, Git workspace previews, and collapsible/resizable sidebar controls.
- MySQL 8.4 Docker fixture: real table/column/PK/FK/index/view introspection passed.
- Final Tauri release executable: built successfully after all phases.

## Phase 0 — Engineering foundation

- [x] Define Cargo and pnpm workspaces.
- [x] Pin Rust toolchain and Node compatibility.
- [x] Create the React, Vite, and Tauri applications.
- [x] Create the initial Rust domain crates.
- [x] Connect React to a sample Tauri command through the platform abstraction.
- [x] Add formatting, linting, unit tests, and CI.
- [x] Prove independent Web build and desktop build.

## Phase 1 — PostgreSQL introspection

- [x] Connection profiles and keychain-backed credentials.
- [x] PostgreSQL connection test.
- [x] Schema introspection for MVP object types.
- [x] Canonical schema model and deterministic fingerprint.
- [x] PostgreSQL fixture and golden integration tests.

## Phase 2 — ER Explorer

- [x] Schema tree and table nodes.
- [x] Foreign-key edges.
- [x] Search, filter, zoom, selection, and relationship navigation.
- [x] ELK automatic layout in a Web Worker.
- [x] Detail panel and persisted layouts.
- [x] Independently collapsible and resizable left/right sidebars with persisted preferences and keyboard controls.

## Phase 3 — Snapshot and history

- [x] Local SQLite snapshot store.
- [x] Manual refresh and background change detection.
- [x] Structured schema diff and risk classification.
- [x] Changes mode, History mode, and timeline.

## Phase 4 — Semantic model

- [x] Domain groups, tags, annotations, and core-table markers.
- [x] Saved views and N-hop relationship views.
- [x] Reattach semantic metadata after physical model updates.

## Phase 5 — AI explanation

- [x] Provider abstraction with a deterministic offline provider.
- [x] Table, domain, and change-set explanations.
- [x] Graph-neighborhood context selection.
- [x] User confirmation for AI-generated annotations.
- [x] Fully offline and AI-disabled modes.

## Phase 6 — Cloud sync and Web viewer

- [x] Axum cloud API and metadata PostgreSQL.
- [x] Accounts, teams, projects, and viewer permissions.
- [x] Snapshot, change-set, layout, and annotation sync.
- [x] Web platform implementation and independent deployment.
- [x] Offline queue, conflict handling, and audit records.

## Phase 7 — Extensions

- [x] Git and migration association.
- [x] Environment drift comparison.
- [x] MySQL adapter with a real MySQL 8.4 integration fixture.
- [x] ORM and code lineage model and local persistence.
- [x] Deterministic split-file Git workspace with an explicit privacy allowlist.
- [x] Field-aware three-way semantic merge driver with structured conflict reports.
- [x] Desktop export/import flow with local Snapshot fingerprint verification.
- [x] Optional PostgreSQL event-trigger review-script enhancement (never auto-executed).
- [x] Enterprise self-hosting stack and air-gap policy validation.

## Phase 8 — Unified Settings control center

- [x] Versioned app, data-source, project, and organization settings with deterministic legacy migration.
- [x] Effective priority: organization policy > project policy > source settings > personal settings > defaults.
- [x] Full-height searchable Settings UI, hash deep links, command palette entries, and `Cmd/Ctrl+,`.
- [x] General, appearance, ER canvas, connection defaults, refresh, history, retention, and storage controls.
- [x] PostgreSQL/MySQL connection tests with version, SSL, and server read-only status.
- [x] Keychain-only database, AI, Cloud access, and Cloud refresh credentials.
- [x] Git repository/fingerprint/Merge Driver checks, export/import previews, and conflict-report review.
- [x] Offline and OpenAI-compatible AI with bounded request previews, retries, concurrency limits, and human confirmation.
- [x] Optional Cloud account/team/project management, scope allowlist, queue diagnostics, conflict strategies, audit log, project rules, and cached organization policy.
- [x] Privacy capability inventory with recent access times, local security audit, and exact-confirmation credential/data removal.
- [x] Notifications, quiet hours, editable conflict-safe shortcuts, update checks, diagnostics summary, experiments, and bundled extension controls.
- [x] Desktop/Web capability separation; unsupported Web Viewer actions render explicit read-only states.
- [x] Settings page visually verified at 960×640 and 125% UI scale with no horizontal overflow or browser console errors.
