# Windows x64 unsigned test package

This is a separate Windows test distribution. It does not replace or retag the
signed macOS v0.1.0 release. Windows signing and Microsoft Store submission are
not configured. Do not describe this package as a signed production release.

## Build

Use Windows x64 with PowerShell 7, Node.js 24, pnpm 10.32.1, Rust 1.95.0 and
Visual Studio C++ Build Tools / Windows SDK (Tauri MSVC prerequisites).

```powershell
pnpm release:windows:test
```

The script installs locked dependencies, builds `x86_64-pc-windows-msvc` using
NSIS, checks that the application is x64 with the Windows GUI subsystem, and
requires both application and installer to be unsigned. Output:

```text
dist/releases/windows-0.1.0-test/
  Nodal-Studio_0.1.0_windows-x64-unsigned-setup.exe
  Nodal-Studio_0.1.0_windows-x64-unsigned-setup.exe.sha256
  manifest.json
```

The manifest records the source commit, dirty-state flag and binary hashes.
The installer runs for the current user, supports English and Simplified Chinese,
and downloads WebView2 Evergreen if it is absent; first installation therefore
requires network access on machines without WebView2. The package is not an
offline WebView2 installer. Application updates remain disabled.

Verify the installer hash with `Get-FileHash -Algorithm SHA256 <installer>` and
compare it with the adjacent `.sha256` file. Unsigned software can trigger
SmartScreen or be blocked by device policy; no bypass or disabling of Windows
security is part of this workflow.

## Automated compatibility verification

`.github/workflows/windows-test.yml` runs on Windows Server 2022 x64. It performs
frontend type/lint/tests, Rust formatting/Clippy/workspace tests, and a native
Credential Manager write/read/delete test across separate processes. This guards
against accidentally using keyring's in-memory mock backend on Windows.

After building, `Scripts/test_windows_package.ps1` installs into a path containing
spaces and Chinese characters, checks the installed executable hash and signature
status, starts the actual application and connects to its loopback WebView2
debugger. It verifies rendered UI, native IPC, SQLite settings/source persistence
and Credential Manager persistence after closing/relaunching the application.
It then removes the disposable source/credential and verifies silent uninstall.
JSON receipts and screenshots are uploaded beside the package as a GitHub Actions
artifact, retained for 30 days. Always check that the workflow and
`evidence/lifecycle.json` passed: failed runs also upload diagnostic files.

The lifecycle script only runs on a fresh GitHub Actions runner and refuses to
use an existing Nodal Studio data directory. Test credentials are disposable;
the dummy connection is saved but never connected. No live database or model
service is contacted. Loopback debugging is enabled only in the test process
environment, not in distributed application configuration.

## Remaining acceptance

- Physical Windows 10/11 x64: install, launch, display scaling, input/shortcuts,
  dialogs and uninstall.
- Fresh machine without WebView2: runtime download and installation.
- Real PostgreSQL/MySQL: TLS, credential reuse, schema capture and read-only query.
- Diagram exports, portable model import/export and Git workspaces on user paths.
- SmartScreen first-download experience and managed enterprise policies.
- Signing, trusted public distribution and Windows in-app updates.

Passing Server 2022 automation is useful Windows compatibility evidence, not a
claim of complete Windows 10/11 desktop or production acceptance.

References: [Tauri Windows installers](https://v2.tauri.app/distribute/windows-installer/)
and [Microsoft signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).
