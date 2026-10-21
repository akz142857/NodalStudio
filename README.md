# Nodal Studio

Nodal Studio is a local-first workspace for understanding and documenting
database schemas. It helps developers explore structure, relationships, semantic
context, and schema history without reading application data.

The desktop application connects to PostgreSQL or MySQL with read-only metadata
queries, renders an ER model, records structural changes without reading table
data, and lets teams add model-only logical relationships that never create
database constraints. Its unified Settings control center manages persistence,
visualization, Git, AI, Cloud, privacy, credentials, policies, and Web Viewer
capability boundaries.

The product and engineering scope is defined in
[DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md). Current implementation evidence is
tracked in [docs/IMPLEMENTATION_STATUS.md](./docs/IMPLEMENTATION_STATUS.md).

The desktop AI single-table understanding flow now includes an exact request
preview, controlled metadata scope, evidence navigation, and cancellation/expiry
handling. See the [stage-one delivery and review record](./docs/AI_DATABASE_UNDERSTANDING_STAGE_ONE.md)
for implementation boundaries and validation. Stage two adds business-language
table discovery, scope-limited candidate ranking, verified relationship paths and
a temporary local graph. See the [stage-two implementation record](./docs/AI_DATABASE_UNDERSTANDING_STAGE_TWO.md)
for workflow, send-scope rules, regression coverage and its synthetic UI preview.
Stage three adds editable per-interpretation drafts, explicit local confirmation,
evidence validity and conservative re-review for imported descriptions. Only current
confirmed team statements are reused. See the [stage-three implementation record](./docs/AI_DATABASE_UNDERSTANDING_STAGE_THREE.md)
for workflows, isolated A/B receiver tests and remaining real-environment acceptance.
The [delivery summary](./docs/AI_DATABASE_UNDERSTANDING_DELIVERY.md) links the implementation,
review fixes and acceptance evidence. Independent user evaluation, physical two-device
round trips and production-environment acceptance remain pending.

## Prerequisites

- Rust 1.95 (pinned by `rust-toolchain.toml`)
- Node.js 24 LTS
- pnpm 10 or newer
- Tauri 2 system prerequisites for the target platform

## Development

```bash
pnpm install
pnpm dev
```

Run the desktop application:

```bash
pnpm dev:desktop
```

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build:web

cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
```

Build the desktop application bundle:

```bash
pnpm --filter @nodalstudio/desktop tauri build --bundles app
```

## Signed macOS release

The [v0.1.0 release notes](docs/releases/v0.1.0.md) and
[verification record](docs/releases/v0.1.0-readiness.md) document the signed release.

The release script builds a Universal app for Apple Silicon and Intel, signs it
with a Developer ID Application certificate, submits it to Apple for
notarization, staples the ticket, creates a DMG, verifies it with Gatekeeper,
and writes a SHA-256 checksum.

Create the private local configuration:

```bash
cp config/macos-release.env.example config/macos-release.env
chmod 600 config/macos-release.env
```

Fill in the signing identity and App Store Connect API key values. If the
Developer ID certificate is already installed in the login keychain, leave
`APPLE_CERTIFICATE_PATH` and `APPLE_CERTIFICATE_PASSWORD` empty. Otherwise,
provide a `.p12` containing the certificate and private key; the script imports
it into a temporary keychain and removes that keychain after the build.

Creating a certificate in the Apple Developer website is not sufficient by
itself: the signing Mac must also have its matching private key. If the
Developer ID certificate was created from a CSR on another Mac, export it
together with its private key as a password-protected `.p12` on that Mac.

Validate the configuration without building:

```bash
./Scripts/build_macos_release.sh --check
```

Build the formal DMG:

```bash
pnpm release:macos
```

The private `config/macos-release.env`, `.p12`, `.p8`, and password values must
never be committed to Git.

### Mac App Store package

The App Store build is separate from the notarized Developer ID DMG. It enables
App Sandbox, embeds the Mac App Store provisioning profile, signs the `.app`
with the distribution identity contained in that profile, and signs the final
`.pkg` with a Mac Installer Distribution identity.

Create the private configuration:

```bash
cp config/macos-appstore.env.example config/macos-appstore.env
chmod 600 config/macos-appstore.env
```

Set the provisioning profile path, Team ID, Bundle ID, and monotonically
increasing `APP_BUILD_NUMBER`. Installed Keychain identities are selected
automatically. Optional `.p12` paths can instead be configured for temporary
import during the build.

Validate all local prerequisites without building:

```bash
./Scripts/build_macos_appstore.sh --check
```

Build a signed `.pkg` for manual upload with Transporter:

```bash
pnpm release:macos:appstore
```

When App Store Connect API credentials are configured, build and upload in one
command:

```bash
./Scripts/build_macos_appstore.sh --upload
```

The checked-in export-compliance declaration assumes the app uses only exempt,
standard encryption such as TLS. Change `Info.appstore.plist` and answer App
Store Connect's export-compliance questions accordingly if non-exempt encryption
is introduced.

The Sandbox grants outgoing network access and read/write access to files and
folders explicitly selected by the user. Persistent access after relaunch must
be tested separately because macOS may require security-scoped bookmarks.

## Application updates

For macOS application updates, the local acceptance builds and later HTTPS feed
configuration are documented in [docs/UPDATES.txt](./docs/UPDATES.txt). The default
build leaves the production update endpoint and signing public key unconfigured.

## Cloud API and read-only Web viewer

The optional cloud stack stores schema metadata only. Start PostgreSQL, the
Axum API, and the independently deployed Web viewer with:

```bash
docker compose -f infrastructure/docker-compose.cloud.yml up --build
```

Open `http://localhost:8088/?share=<viewer-token>`. Account bootstrap is disabled
unless the operator configures a `BOOTSTRAP_SECRET` of at least 24 characters;
the local Compose stack uses the explicitly documented development value in its
configuration. Enter that secret in desktop Settings to create the first account
and team. Share links default to seven days and can be listed, rotated, or revoked
from Settings. Production deployments must replace the development secret and
terminate HTTPS in front of the stack.

## Privacy boundary

The MVP introspector reads PostgreSQL system metadata only. It does not query
application tables, store database passwords in SQLite, execute DDL, or upload
business rows. Cloud publishing is disabled by default, recursively rejects
credential/row-data fields, and stores its access token in the OS Keychain.

## Extension verification

The workspace also contains a read-only MySQL adapter with a MySQL 8.4 fixture,
environment drift comparison, Git/migration provenance, code/ORM lineage,
administrator-reviewed event-trigger script generation, and self-host/air-gap
policy models. Run the real MySQL fixture test with:

```bash
docker compose -f infrastructure/docker-compose.mysql.yml up -d --wait
TEST_MYSQL_DATABASE_URL=mysql://nodalstudio:nodalstudio@127.0.0.1:53306/nodalstudio_test \
  cargo test -p mysql-adapter --test introspection
docker compose -f infrastructure/docker-compose.mysql.yml down
```

## Git collaboration without monolithic model conflicts

The desktop app can export and re-import a deterministic, split-file
`.nodalstudio/` workspace in an existing repository. It includes confirmed
semantics, domains, logical relationships, relationship views, migration provenance, and code lineage
while excluding snapshots, layouts, credentials, local IDs, and row data. A
field-aware three-way merge driver is included for semantic JSON files, and
imports warn when the Git workspace fingerprint differs from the latest local
snapshot.

See [docs/GIT_WORKSPACE.md](./docs/GIT_WORKSPACE.md) for the format, privacy
boundary, merge behavior, and Git configuration.
