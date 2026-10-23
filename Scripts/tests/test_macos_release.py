import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "build_macos_release.sh"
STUB = textwrap.dedent(r'''
#!/usr/bin/env python3
import base64, io, json, os, pathlib, plistlib, sys, tarfile
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["RELEASE_TEST_LOG"], "a") as out:
    out.write(name + " " + " ".join(args) + "\n")
if name == "node":
    if args[0] == "-p":
        print("0.1.0" if "tauri.conf.json" in args[1] else "24")
    else:
        os.execv(os.environ["RELEASE_TEST_NODE"], ["node", *args])
elif name == "security" and args == ["find-identity", "-v", "-p", "codesigning"]:
    if os.environ["RELEASE_TEST_IDENTITY"] == "1":
        print('  1) ABCDEF "Developer ID Application: Release Fixture (TESTTEAM01)"')
    else:
        print("     0 valid identities found")
elif name == "security" and args[:1] == ["find-generic-password"]:
    assert args == ["find-generic-password", "-s", "fixture-updater", "-a", "production", "-w"]
    if os.environ.get("RELEASE_TEST_KEYCHAIN_FAILURE") == "1":
        sys.exit(44)
    print("fixture-password-not-for-logs")
elif name == "git" and args == ["status", "--porcelain"]:
    pass
elif name == "pnpm":
    assert args[:4] == ["--filter", "@nodalstudio/desktop", "tauri", "build"]
    bundles = args[args.index("--bundles") + 1].split(",")
    bundle = pathlib.Path.cwd() / "target/release/bundle"
    # Tauri removes the intermediate app when only the DMG is requested.
    if "app" in bundles:
        (bundle / "macos/Nodal Studio.app").mkdir(parents=True)
    (bundle / "dmg").mkdir(parents=True, exist_ok=True)
    if os.environ.get("RELEASE_TEST_MISSING_DMG") != "1":
        (bundle / "dmg/Nodal Studio_0.1.0_test.dmg").write_bytes(b"fixture disk image")
    if os.environ.get("RELEASE_TEST_UPDATER") == "1":
        assert "--config" in args
        config = json.loads(pathlib.Path(args[args.index("--config") + 1]).read_text())
        assert config["bundle"]["createUpdaterArtifacts"] is True
        assert config["plugins"]["updater"]["endpoints"][0].endswith("/latest/download/latest.json")
        archive = bundle / "macos/Nodal Studio.app.tar.gz"
        cpu = 0x0100000C if os.uname().machine == "arm64" else 0x01000007
        metadata = plistlib.dumps({"CFBundleIdentifier":"com.claycosmos.nodalstudio", "CFBundleShortVersionString":"0.1.0", "CFBundleExecutable":"nodalstudio-desktop"})
        with tarfile.open(archive, "w:gz") as out:
            for name, data, mode in [("Contents/Info.plist", metadata, 0o644), ("Contents/MacOS/nodalstudio-desktop", bytes.fromhex("cffaedfe") + cpu.to_bytes(4,"little"), 0o755)]:
                entry = tarfile.TarInfo("Nodal Studio.app/" + name)
                entry.size, entry.mode = len(data), mode
                out.addfile(entry, io.BytesIO(data))
        signature = "untrusted comment: fixture\n" + base64.b64encode(b"ED12345678" + b"s" * 64).decode() + "\n"
        pathlib.Path(str(archive) + ".sig").write_text(base64.b64encode(signature.encode()).decode())
elif name == "minisign":
    assert args[0] == "-Vm" and pathlib.Path(args[1]).exists()
elif name == "codesign":
    assert pathlib.Path(args[-1]).exists()
elif name == "xcrun":
    if args[:2] == ["notarytool", "submit"]:
        assert pathlib.Path(args[2]).is_file()
        print(json.dumps({"status": os.environ["RELEASE_TEST_NOTARY"], "id": "fixture-id"}))
    elif args[:2] == ["stapler", "staple"]:
        pathlib.Path(args[2] + ".ticket").touch()
    elif args[:2] == ["stapler", "validate"]:
        artifact = pathlib.Path(args[2])
        assert artifact.exists()
        if artifact.suffix == ".dmg":
            assert pathlib.Path(str(artifact) + ".ticket").exists()
    else:
        sys.exit("Unexpected xcrun command")
elif name == "spctl":
    assert pathlib.Path(args[-1]).exists()
else:
    sys.exit("Unexpected build or Keychain mutation: " + name)
''').lstrip()


class MacOSReleaseCheckTests(unittest.TestCase):
    def run_release(self, *, has_identity=True, check_only=True, notary="Accepted", updater=False, keychain=False, keychain_failure=False, existing_dmgs=(), missing_dmg=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "release fixture"
            commands = root / "bin"
            commands.mkdir(parents=True)
            scripts = root / "Scripts"
            scripts.mkdir()
            script = scripts / SCRIPT.name
            shutil.copyfile(SCRIPT, script)
            shutil.copyfile(SCRIPT.parent / "github_update.py", scripts / "github_update.py")
            log = root / "commands.log"
            stub = commands / "stub"
            stub.write_text(STUB)
            stub.chmod(0o755)
            for command in (
                "cargo", "codesign", "git", "node", "pnpm", "rustup",
                "security", "spctl", "uuidgen", "xcrun", "minisign",
            ):
                (commands / command).symlink_to(stub)
            key = root / "AuthKey_TESTKEY001.p8"
            key.touch()
            config = root / "release.env"
            config.write_text(
                "APPLE_SIGNING_IDENTITY=auto\n"
                "APPLE_API_ISSUER=fixture-issuer\n"
                "APPLE_API_KEY=TESTKEY001\n"
                f"APPLE_API_KEY_PATH={key}\n"
                "APPLE_CERTIFICATE_PATH=\n"
                "APPLE_CERTIFICATE_PASSWORD=\n"
                "BUILD_TARGET=host\n"
                "REQUIRE_CLEAN_GIT=true\n"
            )
            public_key = root / "updater.key.pub"
            public_key.write_text(base64.b64encode(("untrusted comment: fixture\n" + base64.b64encode(b"Ed12345678" + b"k" * 32).decode() + "\n").encode()).decode())
            for name in existing_dmgs:
                old_dmg = root / "target/release/bundle/dmg" / name
                old_dmg.parent.mkdir(parents=True, exist_ok=True)
                old_dmg.write_bytes(b"stale disk image")
            env = {
                **os.environ,
                "PATH": str(commands) + os.pathsep + os.environ["PATH"],
                "RELEASE_TEST_LOG": str(log),
                "RELEASE_TEST_IDENTITY": "1" if has_identity else "0",
                "RELEASE_TEST_NODE": shutil.which("node"),
                "RELEASE_TEST_NOTARY": notary,
                "RELEASE_TEST_UPDATER": "1" if updater else "0",
                "RELEASE_TEST_MISSING_DMG": "1" if missing_dmg else "0",
                "UPDATER_PUBLIC_KEY_PATH": str(public_key) if updater else "",
                "UPDATER_NOTES_PATH": "",
                "TAURI_SIGNING_PRIVATE_KEY": "fixture-only" if updater else "",
            }
            env.pop("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", None)
            env.pop("UPDATER_KEYCHAIN_SERVICE", None)
            if keychain:
                private_key = root / "updater.key"
                private_key.write_text("encrypted fixture")
                with config.open("a") as output:
                    output.write(f"UPDATER_PRIVATE_KEY_PATH={private_key}\nUPDATER_KEYCHAIN_SERVICE=fixture-updater\nUPDATER_KEYCHAIN_ACCOUNT=production\n")
                env["TAURI_SIGNING_PRIVATE_KEY"] = ""
                env["RELEASE_TEST_KEYCHAIN_FAILURE"] = "1" if keychain_failure else "0"
            result = subprocess.run(
                ["bash", str(script), "--config", str(config), *(["--check"] if check_only else [])],
                env=env, capture_output=True, text=True, timeout=15,
            )
            checksums = list(root.glob("target/release/bundle/dmg/*.sha256"))
            checksum = checksums[0].read_text() if checksums else None
            manifests = list(root.glob("dist/releases/*/latest.json"))
            result.update_manifest = json.loads(manifests[0].read_text()) if manifests else None
            return result, log.read_text() if log.exists() else "", checksum

    def test_check_accepts_installed_identity_without_importing_a_certificate(self):
        result, commands, _ = self.run_release()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Signing and notarization configuration is valid", result.stdout)
        self.assertIn("security find-identity -v -p codesigning", commands)
        self.assertNotIn("pnpm ", commands)

    def test_check_reports_missing_installed_identity(self):
        result, _, _ = self.run_release(has_identity=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No Developer ID Application identity", result.stderr)

    def test_release_verifies_retained_app_and_stapled_dmg_before_checksum(self):
        result, commands, checksum = self.run_release(check_only=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Release completed", result.stdout)
        self.assertIn("xcrun notarytool submit", commands)
        self.assertIn("xcrun stapler staple", commands)
        self.assertIn("context:primary-signature", commands)
        self.assertTrue(checksum.startswith(hashlib.sha256(b"fixture disk image").hexdigest()))

    def test_rejected_dmg_is_not_stapled_or_given_a_release_checksum(self):
        result, commands, checksum = self.run_release(check_only=False, notary="Invalid")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("DMG notarization was not accepted: Invalid", result.stderr)
        self.assertNotIn("xcrun stapler staple", commands)
        self.assertIsNone(checksum)

    def test_release_ignores_dmg_from_previous_version(self):
        old_name = "Nodal Studio_0.0.9_test.dmg"
        result, commands, checksum = self.run_release(check_only=False, existing_dmgs=(old_name,))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn(old_name, commands)
        self.assertTrue(checksum.startswith(hashlib.sha256(b"fixture disk image").hexdigest()))

    def test_release_rejects_missing_or_ambiguous_current_version_dmg(self):
        for name, missing in [("Nodal Studio_0.0.9_test.dmg", True), ("Nodal Studio_0.1.0_other.dmg", False)]:
            with self.subTest(name=name):
                result, commands, checksum = self.run_release(check_only=False, existing_dmgs=(name,), missing_dmg=missing)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Expected exactly one DMG for version 0.1.0", result.stderr)
                self.assertNotIn("xcrun notarytool submit", commands)
                self.assertIsNone(checksum)

    def test_updater_release_prepares_verified_manifest_without_publishing(self):
        result, commands, _ = self.run_release(check_only=False, updater=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("minisign -Vm", commands)
        self.assertIn("No files have been uploaded", result.stdout)
        self.assertEqual(result.update_manifest["version"], "0.1.0")
        self.assertEqual(len(result.update_manifest["platforms"]), 1)
        self.assertNotIn("gh ", commands)

    def test_encrypted_updater_key_reads_keychain_without_logging_password(self):
        result, commands, _ = self.run_release(updater=True, keychain=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("security find-generic-password", commands)
        self.assertNotIn("fixture-password-not-for-logs", result.stdout + result.stderr + commands)

    def test_unavailable_keychain_password_stops_before_build(self):
        result, commands, _ = self.run_release(updater=True, keychain=True, keychain_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unable to read the updater password", result.stderr)
        self.assertNotIn("pnpm ", commands)


if __name__ == "__main__":
    unittest.main()
