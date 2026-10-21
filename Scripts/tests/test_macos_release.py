import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "build_macos_release.sh"


class MacOSReleaseCheckTests(unittest.TestCase):
    def run_check(self, has_identity):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands = root / "bin"
            commands.mkdir()
            log = root / "commands.log"
            stub = commands / "stub"
            stub.write_text(
                "#!/usr/bin/env python3\n"
                "import os, pathlib, sys\n"
                "name = pathlib.Path(sys.argv[0]).name\n"
                "with open(os.environ['RELEASE_TEST_LOG'], 'a') as out:\n"
                "    out.write(name + ' ' + ' '.join(sys.argv[1:]) + '\\n')\n"
                "if name == 'node' and sys.argv[1] == '-p':\n"
                "    print('24')\n"
                "elif name == 'security' and sys.argv[1:] == ['find-identity', '-v', '-p', 'codesigning']:\n"
                "    if os.environ['RELEASE_TEST_IDENTITY'] == '1':\n"
                "        print('  1) ABCDEF \\\"Developer ID Application: Release Fixture (TESTTEAM01)\\\"')\n"
                "    else:\n"
                "        print('     0 valid identities found')\n"
                "else:\n"
                "    sys.exit('Unexpected build or Keychain mutation: ' + name)\n"
            )
            stub.chmod(0o755)
            for command in (
                "cargo", "codesign", "git", "node", "pnpm", "rustup",
                "security", "shasum", "spctl", "uuidgen", "xcrun",
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
            )
            env = {
                **os.environ,
                "PATH": str(commands) + os.pathsep + os.environ["PATH"],
                "RELEASE_TEST_LOG": str(log),
                "RELEASE_TEST_IDENTITY": "1" if has_identity else "0",
            }
            result = subprocess.run(
                ["bash", str(SCRIPT), "--config", str(config), "--check"],
                env=env, capture_output=True, text=True, timeout=10,
            )
            return result, log.read_text() if log.exists() else ""

    def test_check_accepts_installed_identity_without_importing_a_certificate(self):
        result, commands = self.run_check(has_identity=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Signing and notarization configuration is valid", result.stdout)
        self.assertIn("security find-identity -v -p codesigning", commands)
        self.assertNotIn("pnpm ", commands)

    def test_check_reports_missing_installed_identity(self):
        result, _ = self.run_check(has_identity=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No Developer ID Application identity", result.stderr)


if __name__ == "__main__":
    unittest.main()
