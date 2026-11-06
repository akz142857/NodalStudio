# SQLite native acceptance

1. Run `python3 Scripts/fixtures/sqlite/writer.py` in a terminal. Keep it alive: the two committed rows are in an active WAL, not checkpointed into the main file.
2. Build `cargo build -p nodalstudio-desktop --example sqlite_sandbox --features mac-app-store,tauri/custom-protocol --offline`.
3. Put `target/debug/examples/sqlite_sandbox` in a test `.app/Contents/MacOS/` with matching `CFBundleExecutable` and `CFBundleIdentifier=com.claycosmos.sqliteprobe` in Info.plist. Sign with App Sandbox, network-client (required by WKWebView), user-selected read/write and app-scoped-bookmark entitlements. Do not add filesystem exceptions. The example is isolated from the product and has no purchase bypass in the shipping application.
4. Open the app, click **Choose fixture folder**, select the exact printed fixture directory, then **Run saved fixture**. Only directories containing `NODAL_SQLITE_FIXTURE` are accepted. The production picker/bookmark code, SQLite adapter and query engine are used.
5. Verify the two values, `writeDenied`, `engineCancelled`, `mainFilePreserved` and `walPresent`. Quit, reopen, and run without choosing again. The report is written as `sqlite-acceptance.json` in the fixture directory.
6. End the writer after the second run. An ad-hoc local signature verifies sandbox behavior, but is not App Store distribution-signature acceptance. Run the same check on the signed release candidate before release.

The harness writes only its marker-confirmed fixture report and its isolated app configuration. Never select a production database for this harness.
