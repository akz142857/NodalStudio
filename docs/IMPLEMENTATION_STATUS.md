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
- [x] Complete, searchable change list with explicit Before → After direction and snapshot property details.
- [x] Comparison diagram with added/modified/deleted markers and Before definitions for deleted tables, fields, and physical relationships. Replaced foreign keys retain both versions; historical objects stay separate from current semantic editing and persisted model layouts. Full history requires both snapshots (desktop); one-snapshot web shares show a coverage notice.
- [x] Export the complete current diagram view to standalone SVG or PNG, preserving layout, theme, relationship kinds and comparison markers. Desktop saves uniquely named files in Downloads; web initiates a local download. SVG uses native shapes/text; PNG normally renders at 2× and caps raster allocation for large views.
- [x] Export a single loaded snapshot to a self-contained, offline HTML data dictionary, independent of Diagram filters. Includes all available tables/columns, PK/FK/index/constraint details, views/enums, attached annotations, domains and saved logical relationships with explicit statuses. Escapes all source text, excludes orphaned annotations and unconfirmed candidates, and never serializes connection/workspace fields. Desktop saves unique files in Downloads; web downloads locally. Directory links, print styles and browser Find support reading large reports; semantics are explicitly current, not historical versions.
- [x] Diagram table selection is independent of inspector focus: Shift/Meta/Control additive clicks and Shift box selection, explicit selected count/clear, and batch addition to an existing business domain on desktop. Preserves existing members and domain metadata, deduplicates qualified table keys, reports save errors/retry, retains visible selection through semantic updates, and clears selection on source/snapshot changes. Comparison and Web diagrams remain read only; deleted ghosts never become current members. Multi-table movement saves all final positions; physical nodes cannot be deleted through canvas shortcuts.
- [x] Diagram multi-table alignment (six bounds/center actions) and horizontal/vertical equal-gap distribution, preserving outer endpoints, dimensions, selection and unselected tables. Full desktop diagrams automatically save complete positions/sizes with ordered writes and failure retry; search/focus/domain/saved-view/comparison/Web arrangements remain temporary and cannot replace full layouts. Source-isolated caches, full-layout restoration after leaving temporary views, and stale auto-layout protection are covered by tests. See [layout rules](DIAGRAM_LAYOUT.md).
- [x] Diagram layout undo/redo for alignment, distribution, single/multi-table drag, resize, arrow-key movement and user-triggered Auto layout. Session history retains 50 actions, coalesces gestures, stores only changed geometry properties, preserves current selection/semantics and clears on scope/node-set changes. Full-diagram undo/redo saves through the existing ordered write/retry path; temporary diagrams never write model layouts. Canvas-scoped shortcuts preserve text/dialog/editor undo, and stale dragging flags are cleared at gesture end. Algorithm, real React Flow component/gesture tests and browser verification cover restoration, history branches, dimensions and saving failures.
- [x] Diagram table position pinning and selected-only Auto layout. Fixed cards retain position/size through drag, resize, keyboard movement and all arrangements; selected layout uses only movable targets and their visible internal relations, avoiding stationary cards along the configured layout direction. Backward-compatible `pinned` flags persist with full layouts, temporary views inherit but never overwrite full pins, and incomplete layouts retain valid fixed positions. Both operations support undo/redo, stale-result protection and save retry. Frontend algorithm/real React Flow tests, Rust serialization/SQLite tests and real ELK browser verification cover the behavior.
- [x] Explainable, dialect-aware structure preflight for the entire loaded snapshot on Desktop and Web. Metadata-only rules cover missing PK design hints, PK/FK reference consistency, bounded PostgreSQL/MySQL FK type observations and opt-in whitespace naming hints. Findings include evidence, recommendations and table navigation; coverage distinguishes checked/partial/skipped rules and missing catalog information. Local ignore reasons are source/fingerprint/evidence-isolated with restore and failed-save retry. No queries, schema edits or validity guarantees. Includes 50 new rule/storage/component/App tests; see [scope and rules](SCHEMA_PREFLIGHT.md).
- [x] Shared operation feedback for diagram/report exports, batch domains, layout saves/arrangements, preflight/review notes, snapshot refresh and comparison history loads. Explicit running/completed/failed/information states, result summaries, accessible error details and operation-specific retry controls; scope isolation and duplicate-submission guards protect asynchronous actions. Existing ordered layout saves remain intact; layout calculation failures gain retry. Adds 18 tests (296 total frontend tests), with simulated browser verification of export failure/retry/success. See [feedback rules](OPERATION_FEEDBACK.md).
- [x] Capability matrix for 22 features across Desktop/PostgreSQL, Desktop/MySQL, Web/PostgreSQL and Web/MySQL. Settings and command-palette access, search/status filters, current-context highlighting and per-combination scope explanations distinguish supported/partial/unavailable behavior without probing connections. Query entry points and execution guards reuse the declaration: MySQL capture does not imply query support, Web has no database execution, and unsupported sources cannot expose old query history. Adds 27 tests (323 total frontend tests); see [matrix and implementation evidence](CAPABILITIES.md).
- [x] Temporary read-only PostgreSQL/MySQL DDL preview from UTF-8 files or clipboard/editor text on Desktop and Web, available without a database connection. Bounded Worker parsing covers ordinary CREATE TABLE, declared columns/PK/FK and simple indexes; reports partial coverage with source navigation, distinct session identity, text SHA-256 and versioned model fingerprint. Structure list and declared-FK Diagram are isolated from live snapshots, history, semantic/layout writes, query, export, cloud and AI. Cancelling/closing discards the session. Adds 43 tests plus real Worker/file/ELK browser verification; see [coverage, identity and limits](DDL_IMPORT_PREVIEW.md).
- [x] Interactive self-contained offline HTML Viewer for one entire loaded snapshot and current saved semantics, independent of Diagram filters. Metadata search, schema/domain filters, complete table/object details, relationship navigation, one-hop focus and accessible SVG pan/zoom; physical and active logical links remain distinct, unavailable endpoints and inactive links have explicit coverage. Display-only data allowlist, hash-authorized script/CSP, escaped metadata, static dictionary fallback, no network/database/writeback/state persistence. Bounded at 500 tables / 5,000 columns / 5,000 physical or active logical relationships / 32 MiB, rejecting excess without truncation. Desktop/Web reuse HTML saving; source-isolated feedback/retry. Adds 18 tests (384 total frontend tests) and production-generated HTML browser verification; direct file:// testing is blocked by the browser tool policy. See [scope and limits](OFFLINE_VIEWER.md).

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
