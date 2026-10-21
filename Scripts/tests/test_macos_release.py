import hashlib
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
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["RELEASE_TEST_LOG"], "a") as out:
    out.write(name + " " + " ".join(args) + "\n")
if name == "node":
    if args[0] == "-p":
        print("24")
    else:
        os.execv(os.environ["RELEASE_TEST_NODE"], ["node", *args])
elif name == "security" and args == ["find-identity", "-v", "-p", "codesigning"]:
    if os.environ["RELEASE_TEST_IDENTITY"] == "1":
        print('  1) ABCDEF "Developer ID Application: Release Fixture (TESTTEAM01)"')
    else:
        print("     0 valid identities found")
elif name == "git" and args == ["status", "--porcelain"]:
    pass
elif name == "pnpm":
    assert args[:4] == ["--filter", "@nodalstudio/desktop", "tauri", "build"]
    bundles = args[args.index("--bundles") + 1].split(",")
    bundle = pathlib.Path.cwd() / "target/release/bundle"
    # Tauri removes the intermediate app when only the DMG is requested.
    if "app" in bundles:
        (bundle / "macos/Nodal Studio.app").mkdir(parents=True)
    (bundle / "dmg").mkdir(parents=True)
    (bundle / "dmg/Nodal Studio_0.1.0_test.dmg").write_bytes(b"fixture disk image")
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
    def run_release(self, *, has_identity=True, check_only=True, notary="Accepted"):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "release fixture"
            commands = root / "bin"
            commands.mkdir(parents=True)
            scripts = root / "Scripts"
            scripts.mkdir()
            script = scripts / SCRIPT.name
            shutil.copyfile(SCRIPT, script)
            log = root / "commands.log"
            stub = commands / "stub"
            stub.write_text(STUB)
            stub.chmod(0o755)
            for command in (
                "cargo", "codesign", "git", "node", "pnpm", "rustup",
                "security", "spctl", "uuidgen", "xcrun",
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
            env = {
                **os.environ,
                "PATH": str(commands) + os.pathsep + os.environ["PATH"],
                "RELEASE_TEST_LOG": str(log),
                "RELEASE_TEST_IDENTITY": "1" if has_identity else "0",
                "RELEASE_TEST_NODE": shutil.which("node"),
                "RELEASE_TEST_NOTARY": notary,
            }
            result = subprocess.run(
                ["bash", str(script), "--config", str(config), *(["--check"] if check_only else [])],
                env=env, capture_output=True, text=True, timeout=15,
            )
            checksums = list(root.glob("target/release/bundle/dmg/*.sha256"))
            checksum = checksums[0].read_text() if checksums else None
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


if __name__ == "__main__":
    unittest.main()
