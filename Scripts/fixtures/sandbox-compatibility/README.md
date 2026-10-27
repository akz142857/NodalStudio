# Native App Sandbox fixture

This target links the production file-access, SSH tunnel and Git workspace modules. It is not compiled into Nodal Studio, does not fake purchase state, and cannot prove App Store purchase acceptance.

Use only a disposable folder and localhost database. The fixture password is public test data. Do not put real credentials in this directory. Require macOS, Docker, the repository toolchain, and a local signing identity. The image uses the official postgres:17-alpine base and Alpine openssh package.

1. Create `target/mas-compatibility/fixture`, mark it with `NODAL_SANDBOX_FIXTURE`, and generate an unencrypted disposable Ed25519 key `client`/`client.pub` there. Add `unrelated.txt` and initialize this disposable folder with `git init`.
2. Build this directory's Dockerfile as `nodal-sandbox-compatibility-local`. Start a container with the same name, `-p 127.0.0.1:55482:22`, `-e POSTGRES_PASSWORD=nodal-sandbox-fixture-only`, and the fixture directory mounted read-only at `/fixture`. Do not replace existing containers with other purposes.
3. After initialization, read `/etc/ssh/ssh_host_ed25519_key.pub` directly with `docker exec`. Write `[127.0.0.1]:55482 <type> <public key>` to `known_hosts`. Generate a different disposable host key for `wrong_known_hosts`. Do not use blind host-key acceptance.
4. Build: `cargo build -p nodalstudio-desktop --example sandbox_compatibility --features mac-app-store,tauri/custom-protocol`.
5. Package `target/debug/examples/sandbox_compatibility` under a test `.app/Contents/MacOS/`, with matching executable and `CFBundleIdentifier=com.claycosmos.nodaltest` in Info.plist. Use production App Sandbox, network-client, user-selected read/write and app-scoped-bookmark entitlements. Do not add broad filesystem exceptions or network-server permissions. Sign the test app using a configured Developer ID identity and `--options runtime --timestamp=none`; verify with `codesign --verify --strict` and inspect its entitlements.
6. Open the native application. Choose only the fixture folder, then Run saved fixture. Quit the entire process, reopen, and run again without selecting the folder. The report is written to the fixture as `compatibility-result.json`.

Expected: Git marker detected; model file write/read succeeds; unrelated file preserved; private-key and password SSH each return SELECT 42; wrong host key rejected; agent explicitly rejected by MAS policy. The diagnostic `gitCli` may fail with `xcrun: cannot be used within an App Sandbox`; the shipping MAS readiness path uses filesystem inspection and never this diagnostic process.

Stop only this container when finished. Generated keys, binaries and screenshots remain under ignored `target/`. A long bundle ID/home path may exceed macOS's 103-byte Unix socket pathname limit; production now validates both tunnel and askpass socket paths before spawning. A short test ID avoids conflating test-only bundle name length with production compatibility.

The final App Store-distributed bundle still requires its own signed/profiled integration acceptance. Purchase, offline entitlement reuse, restore, revocation and cross-Mac copy checks are separate.
