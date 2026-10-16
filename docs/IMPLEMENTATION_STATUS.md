# Nodal Studio Implementation Status

This file tracks implementation evidence against [DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md).

## Latest verification evidence

- Schema tree: independent case-insensitive table/view-name search (including qualified names), automatic expansion of matches, clear/Escape and source-aware reset. Search preserves normal disclosure choices and remains accessible when the object list scrolls. Right-click/Shift+F10 opens app actions with keyboard navigation, zoom-aware viewport bounds, name-copy feedback/retry and optional read-only query entry. View definitions are read-only previews; views are not fabricated as table nodes. Table clicks use scoped, repeatable Diagram navigation requests that clear Diagram filters, leave isolated views, wait for layout and measurement, and then center/select the actual node without editing table positions. Tests cover delayed layout and measurement, semantics/layout load settlement (including storage failure), repeated clicks, cross-source cancellation, search, menu and clipboard behavior. Verification: 407 frontend tests across 70 files, TypeScript, ESLint and desktop bundle build; packaged UI checked with 125 tables for name filtering, app context menu, repeatable centering/selection and a real view definition preview.

- The application header uses a single flat surface: navigation segments, search, sidebar controls and action icons share 32px visible geometry and 8px corners; icon hit regions remain 44px. The standalone capsule, gradient, shadow and passive runtime icon have been removed; runtime context remains in the product-title tooltip and accessible text. Hover/focus hints, press/selected/disabled states, 400ms hover delay, notification counts, operation receipts/retries and narrow-width layout are retained. Header styling supports explicit light/dark and system appearance. These are WebView controls, not a native NSToolbar or SF Symbols implementation. References: [Apple HIG Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars), [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons). Verification: 395 frontend tests across 67 files, TypeScript, ESLint, desktop bundle build, and packaged-window inspection of the complete header with a 125-table model.

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
- [x] Diagram toolbar refinement (2026-10-15): removed the large floating selection/layout panel. Working commands live in a compact row above the canvas; alignment/distribution and domain membership open on demand, with prerequisite and persistence explanations in tooltips. Feedback is dismissible and in the toolbar flow. Existing geometry/domain saving and read-only boundaries are unchanged; diagram keyboard undo also works from the new toolbar. Adds 5 interaction/regression tests, updates existing tests to use the disclosures, and passes all 389 frontend tests, TypeScript, ESLint and desktop build. Verified the toolbar against a loaded local snapshot in the native desktop app.

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

- Large Diagram performance: viewport culling from the initial frame at 100+ tables; field/index detail at overview zoom is restored on selection/zoom/export without changing geometry. Whole-canvas viewport subscriptions and unrelated node data churn removed; inferred target lookup indexed, unchanged edge identities retained. SVG/PNG use a bounded export surface while the interactive canvas retains viewport culling. Regression coverage includes 125/1,000-table graphs, original inference-rule equivalence, real React Flow culling/update isolation/full export, and overview anchors/change markers. Bounded large-component layout and provisional geometry reduce initial measurement/ELK costs; full export retains its existing cost and limits. No hardware frame-rate claim.

- Thousand-table runtime follow-up: production benchmark entry and isolated native WebKit benchmark cover real workers, initial load, automatic layout and verified 90-step DOM drags. Provisional offscreen geometry, per-store measurement batches, stable selected-node projection, linear component grouping, bounded large-component placement, staged SVG mounts and dense-drag relationship subscription culling implemented. Stage samples and explicit limits are in `docs/DIAGRAM_PERFORMANCE.md`; final Chromium 1,000/2,000-table runs and native WebKit 2,000-table module load/layout/drag are recorded after unlock. Native 2,000-table dense connected rendering now uses one shared painted SVG while retaining the full React Flow model, ports and interaction. Repeated actual WebKit load/layout/90-step drag runs pass without the previous IPC crash; historical failures remain in the report. Added dense real-model, path/marker/label/comparison, keyboard selection/focus and export uniqueness tests. Full 2,000-table / 40,000-column / 3,997-edge SVG export uses an isolated, measurable batch surface (16 cards / 64 relationships) sharing production cards, path components, settings and current cached ports. The interactive canvas never leaves viewport culling or mutates its model for export; completion/failure removes only the last batch. The earlier 85-second Range-boundary slowdown remains documented. SVG byte preparation now reuses the serializer's exact UTF-8 size and encodes directly into the final IPC buffer in bounded 128 Ki-character chunks with an 8 ms cooperative budget; the whole-SVG Blob/arrayBuffer round trip is removed. Large-canvas busy state preserves the accessibility tree, node context and interaction subscriptions, using input capture guards while retaining Tab navigation and feedback controls; small in-place capture and PNG behavior remain. Four native 2,000-table exports take 3.984 / 4.356 / 4.146 / 3.799 seconds including disk saves. Byte-stage maximum frame intervals are 22–40 ms; overview restoration totals 21–37 ms with maximum intervals 42–48 ms (previous overview 228 ms / 166 ms). Complete export still has 63–130 ms capture-batch long frames; it is not universally faster. All four disk files pass independent XML, identity, visible text, marker reference and finite-path checks; all three overview files are byte-identical. Post-export 90-step dragging and real Worker layout pass, with no new WebKit report observed. Overview-window sampled WebContent RSS reaches about 0.89 GiB; this is not an exact peak or leak proof. 446 frontend tests across 85 files, typecheck, lint and standard/isolated desktop builds pass; passive wheel/touch behavior has an additional four-test check. After unlock, the final compatibility build also passes an additional native overview export in 4.168 seconds: byte preparation/restoration maximum frame intervals 25/45 ms, complete file byte-identical to the earlier overview files, followed by six successful 90-step-total drag gestures and a 452 ms Worker-backed layout; no new WebKit crash report observed. Raw measurements, historical failures and screenshots are in the performance report.

- SVG capture batch follow-up: fixed DOM slots, per-batch controlled index expansion and fresh labeled-edge measurement; adaptive bounded capture uses an 8 ms cooperative work budget instead of a mandatory frame per batch. XML token sizing avoids temporary encoding arrays and final assembly reuses fragment byte counts. Native observer audit found concurrent AX queries contribute to the earlier 119 ms gaps: old-method exports without mid-export observation take 3.708/3.690 seconds with maximum intervals 42/45 ms. The intermediate candidate repeat at 264 ms is retained. Four final native 2,000-table exports take 2.715/2.729/2.621/2.694 seconds including disk save; relationship/table batch maximum intervals 17–19/20–30 ms, overall 24–38 ms, with no intervals over 50 ms in those samples. All complete files pass independent XML/identity/text/marker/path checks; overview files are byte-identical to the old method. Post-export drag/layout pass; no new Nodal/WebKit crash report observed. First load/drag still have long frames, and no new RSS claim is made. 451 tests across 86 files, typecheck, lint and standard/isolated desktop builds pass. Details and observer limitations are in `docs/DIAGRAM_PERFORMANCE.md`.

- Initial-load / drag follow-up: dense minimaps now aggregate normal/selected table paths, coalesce updates per frame and cache unchanged geometry groups while retaining the XYMinimap pan/zoom controller. Overview uses measurable lightweight ports and restores interactive Handles on detail/selection/connecting. Node measurement resolves current DOM in one per-store RAF; dense edge projection retains unchanged identities, mount batches are capped at 128, and bulk shared-paint commits preserve the SVG root/order/focus. Missing-port prototypes and slower retained-subscription / gradual-retirement approaches were rejected and recorded. Four final native 2,000-table runs retain complete geometry: new-process load maximum gaps 53–54 ms; drag P95 32–35 ms, maximum 60–83 ms, all 24 gestures effective. Same-process reload still has 204–208 ms gaps (old hot baseline 179 ms), and total drag recovery is not faster. Actual full SVG save takes 2.670 seconds / maximum 28 ms and passes independent 2,000-table / 40,000-column / 3,997-edge/arrow XML verification; post-export dragging passes. 457 tests across 89 files, typecheck, lint and standard/isolated builds pass. No new Nodal/WebKit crash report observed. Remaining long frames, all raw samples and screenshot are documented in `docs/DIAGRAM_PERFORMANCE.md`; no universal FPS or new memory claim.

- Dense reload / drag follow-up: the shared SVG now clips painting to the current world-coordinate viewport while preserving path DOM and full model/export scope. Each React Flow canvas uses its own marker and accessibility-description namespace. Multi-root paint buckets, inline arrows, accessibility hiding, Worker reuse and 32-card measurement staging were rejected after native measurement or contract checks; original markers, keyboard access, measurement batching and Worker lifecycle remain. Native repeats and same-harness original-runtime controls are recorded in `docs/DIAGRAM_PERFORMANCE.md`; reload spikes are not claimed eliminated or consistently faster. Adds viewport/DOM-identity and cross-canvas/remount resource-isolation regressions; 459 frontend tests across 89 files, typecheck, lint and standard/isolated native builds pass.

- Stage attribution follow-up: opt-in profiling benchmark records React render/layout/passive callbacks, application measurement spans, RAF/ResizeObserver work and installed React Flow store actions; clocks align with two isolated native Time Profiler captures. Unknown frame wall time is kept unassigned, never inferred as GPU/paint. Confirmed hotspots lead to hiding only empty proxy SVG render trees and leaving an idle RAF between dense post-drag recovery batches, with initial-load pacing/model/export scope unchanged. Four unprofiled native 2,000-table runs show drag P95 21–22 ms / maximum 35–57 ms, at an additional 0.37–0.45 s complete recovery cost; reload maxima 91–95 ms, but new-process load and total load are not consistently faster. Automatic-layout maxima 174/243/36/177 ms remain unresolved. Final complete SVG saves in 2.534 s / maximum 27 ms, independently verifies every table/column/relationship/arrow, and post-export dragging/zoom/relocation pass. 469 tests across 92 files, typecheck, lint and standard/isolated native builds pass; no new Nodal/WebKit crash observed. Full attribution, all slow samples and limits are recorded in `docs/DIAGRAM_PERFORMANCE.md` and its accompanying JSON; no lower-total-paint-CPU, GPU-duration, universal FPS or memory claim.
