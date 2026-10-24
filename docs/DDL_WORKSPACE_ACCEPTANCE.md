# DDL import panel and temporary workspace acceptance

Date: 2026-10-24 (Asia/Singapore).

## Delivered behavior

- Import DDL opens a modal panel over the existing workspace. File selection, explicit clipboard reading, dialect selection, advanced default-schema options, SQL input, feedback, and footer actions use the shared design system.
- Successful parsing opens a temporary read-only workspace below the main navigation, with the shared object tree, relationship canvas, and table inspector. Structure and diagram views share selection; changing views keeps the canvas mounted.
- Returning to the database keeps both workspaces mounted. Reopening Import DDL resumes the temporary input, model, selection, tree expansion, and canvas. Closing a nonempty session requires discard confirmation; reload/application exit still loses temporary content.
- Diagnostics open source locations in the input panel. Table and column source navigation, identity/default metadata, foreign-key actions, and index details are retained. Technical identity/hash information is collapsed.
- New interface messages are translated into English and Simplified Chinese. Chinese diagnostics show a translated category summary with expandable original parser details; SQL and database identifiers remain unchanged.
- Empty/colliding diagram results select the structure view rather than leaving an unavailable diagram tab selected. No supported tables results provide an edit action and expanded diagnostics.

## Automated verification

- Full frontend suite: **138 files / 891 tests passed**.
- After final source-navigation and empty-view refinements: **14 targeted tests passed** across DDL panel, App isolation, and table inspector.
- TypeScript, ESLint, production frontend build, and `git diff --check` passed. Vite retains its existing large-chunk advisory.
- Tests cover bounded UTF-8 input, clipboard denial/retry, cancellation and late responses, dialect changes, source selection, temporary canvas/selection retention, discard confirmation, locale changes, empty results, and preservation of the original App canvas DOM without capture/query/layout calls from DDL navigation.

## Real macOS desktop acceptance

Used `/tmp/Nodal Locale Acceptance.app`, the existing isolated Tauri development wrapper loading the current frontend at `http://127.0.0.1:1420/`. Its older backend reports `0.2.2-beta.1`; this verifies the changed frontend in native WKWebView, **not a newly built release installer**. The installed production application was not replaced.

Passed with **110% UI scale**, Simplified Chinese/light and English/dark:

1. Opened the modal over the saved PostgreSQL acceptance workspace, selected `app.orders`, and changed the original canvas zoom before importing.
2. Pasted synthetic PostgreSQL CREATE TABLE/INDEX plus unsupported ALTER text. The real Worker produced two tables, the declared relationship, and three diagnostics; the canvas and inspector rendered in native WKWebView.
3. Opened a diagnostic and verified the native selected-text report exactly matched `ALTER TABLE orders ADD note text;`.
4. Returned to the database and confirmed the `orders` inspector and zoomed canvas scene were retained. Before/after screenshots are saved locally.
5. Switched to English/dark via real application settings and confirmed the scale remained 110%. Used the macOS file chooser to load synthetic `mysql-schema.sql`, selected MySQL, parsed two tables with an index and declared foreign key, and selected `imported.orders` through the tree.
6. Returned/reopened the temporary model; the file name, expanded tree, selected table, and zoomed canvas were retained. Changed language/theme back to Chinese/light and reopened the same model successfully.
7. Verified the column-source action selected exactly `customer_id INT`. Escape returned from the editor to the model.
8. Verified closing displayed the localized discard dialog; Keep editing retained the model. Discard and close restored the original database. Reopening then started with empty input.
9. Parsed an ALTER-only input: zero-table guidance and expanded diagnostics appeared; diagram was disabled and structure correctly selected.

During native review, corrected the navigation overlap after a settings round trip, repeated separators, an untranslated clipboard source label, and the empty-result selected-tab state. The Mac locked during acceptance; remaining native checks resumed after the user unlocked it.

## Evidence and boundaries

Local screenshots and logs: `target/ddl-workspace-acceptance/` (ignored).

- `import-zh-light.png`, `import-en-dark.png`
- `workspace-en-dark-final.png`, `workspace-zh-light-final.png`
- `database-before.png`, `database-after.png`
- `workspace-en-dark-before.png`, `workspace-en-dark-after.png` document the initial retention check before the navigation-overlap correction; final screenshots supersede their layout.
- `empty-zh-light.png`

Only synthetic DDL was imported; no SQL was executed or persisted as a database source. Parser scope and resource limits are unchanged. Native clipboard permission denial, Windows execution, and extreme window-size combinations were not exercised in this round; clipboard failure/cancellation and bounds are covered by automated tests.

### Advanced options layout follow-up

- Replaced the bottom-aligned dialect/advanced flex row with a vertical grid. Advanced options now occupy a separate disclosure row; dialect and namespace controls share a bounded responsive width and left edge.
- Verified expanded and collapsed states in the native acceptance app at Chinese/light/110%. No overlapping labels or horizontally displaced controls. Screenshot: `target/ddl-workspace-acceptance/advanced-options-expanded.png`.

### Final disclosure simplification

The advanced-options heading and disclosure were subsequently removed at user request. The default namespace is always visible below the dialect control, with the same width and left alignment. Native AX verification confirmed the namespace input is visible without expanding anything; all 9 DDL component tests passed. Earlier screenshots above document the intermediate disclosure layout.
