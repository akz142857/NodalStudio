# UI design system

Settings, the inspector and relationship detail/edit/delete surfaces share an opt-in design system. The implementation follows macOS conventions for compact controls, restrained color, grouped preferences, readable hierarchy, keyboard focus, and adaptive layouts. It remains a React/WebView interface, not a native AppKit settings window.

References: [Apple Settings](https://developer.apple.com/design/human-interface-guidelines/settings), [Typography](https://developer.apple.com/design/human-interface-guidelines/typography), [Color](https://developer.apple.com/design/human-interface-guidelines/color), and [Layout](https://developer.apple.com/design/human-interface-guidelines/layout).

## Change the shared foundation

- `apps/frontend/src/design-system/tokens.css`: semantic colors, system font stacks, type scale, spacing, radii, density and motion. Light, dark and system themes are defined here. Prefer semantic names such as `--ds-secondary` and `--ds-danger` over raw colors in components.
- `apps/frontend/src/design-system/controls.css`: opt-in `.ds-surface` controls, keyboard focus, disabled/pressed/hover states, primary buttons and checkbox switches. Native input semantics and keyboard behavior remain intact.
- `apps/frontend/src/components/settings/SettingsControls.tsx`: reusable section, group, toggle, selection, range, number, text and secret-field compositions. Labels and descriptions are programmatically associated with controls.
- `apps/frontend/src/components/settings/settings.css`: Settings layout and component composition, including the capability matrix.
- `apps/frontend/src/components/inspector.css`: inspector composition, using the same shared tokens.

`styles.css` imports the shared foundation. Existing surfaces outside Settings and the inspector retain their current styles; migrate them deliberately by adding `.ds-surface` and replacing their local values with semantic tokens. Do not introduce new global tag overrides.

The type scale uses the existing root `--ui-font-size` preference: at the default 13px, body text is 13px, controls 12px, supporting text at least 11px, section headings 14px, and page titles 20px. Changing the preference scales these sizes. Density changes row height; long labels can still expand. Focus uses an explicit outline, and status colors always accompany text. Motion respects both the application preference and the operating system preference. Increased contrast strengthens separators and borders.

## Settings composition

All fourteen categories use the same shell and control primitives:

| Category | Content grouping |
| --- | --- |
| General | Display, startup, date and time |
| Appearance | Text and density, accessibility, workspace panels |
| Canvas & ER | Table contents, relationships, layout |
| Data Sources | Connection defaults, saved connections, refresh, connection behavior |
| History & Storage | Capture and retention, storage and backup |
| Git | Repository, readiness, shared description review and data boundary |
| AI | Provider, context, request limits and explicit configuration save |
| Cloud Sync | Connection, account and project, sync scope, sharing and policy |
| Privacy & Security | Network and diagnostics, external access, credentials and audit |
| Notifications | Events, delivery and quiet hours |
| Keyboard Shortcuts | Command filtering and conflict-aware bindings |
| Updates & About | Updates, diagnostics, paths and inline release/license documents |
| Capabilities | Context, filters, scrollable comparison and feature details |
| Advanced | Performance, experiments, extensions, settings transfer and recovery |

The sidebar has Workspace, Services and Application groups. Current category uses `aria-current`; Up/Down/Home/End move focus and Enter/Space activate the native button. Below 660px it becomes a native category selector. Below a content width of 500px, form rows stack while switches remain aligned with their labels. The capability comparison deliberately retains its own keyboard-accessible horizontal scroll region.

Category changes reset the content scroll. Search with no matches displays an empty state. Ordinary settings retain immediate saving; AI and Cloud configuration retain explicit Save/Cancel. Credential actions, managed policy restrictions and destructive-action confirmations are preserved. Informational release/license documents are inline regions rather than falsely marked modal dialogs.

`components/settings/UpdatePanel.tsx` composes the update flow with `SettingsGroup`, `ToggleRow`, `TextRow` and `.ds-surface` controls. `updates.css` uses the shared typography, spacing and semantic colors for status, progress and errors. Its native HTML installation dialog traps focus, defaults to Not now, restores focus on cancellation and prevents duplicate installation. Release notes are plain text; status is announced with a polite live region. Change shared tokens to restyle this flow together with the other Settings pages.

## Visual verification

Run `pnpm dev:desktop` or the frontend development server, then visit `/settings-preview.html`. This development-only fixture uses synthetic settings and does not persist preferences or send external requests. It is not an entry in the production build.

Fixture query parameters: `theme=light|dark|system`, `font=18`, `density=compact`, `source=none`, `runtime=web`, `managed=1`, and `bootstrap=1` (shows account creation fields). Use the page controls for normal navigation and theme/font interactions. `/inspector-preview.html` remains available to check the other consumer of the shared tokens.

Check all categories in light and dark themes, narrow and desktop windows, larger fonts, managed/disabled states, and both populated and empty source contexts. Confirm form labels, visible focus, keyboard navigation, local save feedback and explicit draft saving. Run the frontend tests, lint and production build after implementation changes.


### Model relationships

Canvas scrolling pans the viewport freely on both axes at the input's native speed, including trackpad gestures and horizontal mouse wheels. Pinch and Command/Control + wheel zoom; Space + drag continues to pan. Scrolling changes the viewport only and never saves table positions. React Flow normalizes pixel and line wheel input through its shared pan/zoom implementation.

`components/relationships/relationships.css` uses the same semantic tokens for relationship details, editing and deletion confirmation. `--ds-logical` identifies model-only dashed links. Endpoints show table identity separately from columns; cardinality and status use readable labels. The deletion confirmation is an HTML modal dialog, independent of `window.confirm` support in the desktop WebView. It defaults focus to Cancel, blocks duplicate submissions, retains errors for retry, and leaves database foreign keys unchanged. Details, manager and keyboard entry points share this confirmation. `/relationship-preview.html` exercises the real canvas with an in-memory model and a simulated failure option.

Entire visible field rows initiate and receive model connections. A 6 CSS-pixel drag threshold preserves clicks; table headers move tables, and Space retains canvas panning. `use-field-row-connection.ts` separates DOM row hit testing from edge anchors and feeds the existing React Flow connection preview. Sources use `--ds-logical`, compatible targets use `--ds-positive`, and type warnings use `--ds-warning`; the confirmation form remains authoritative for duplicate and type validation. Escape, window blur, scope changes, blank drops and self-field drops cancel without saving. Fixed table positions still allow relationships, while read-only/export/comparison surfaces do not. Row gestures avoid mounting extra ports on every column and retain the right-click target picker as an alternative.
