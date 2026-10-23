import base64
import gzip
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "github_update.py"
spec = importlib.util.spec_from_file_location("github_update", SCRIPT)
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


def encoded_file(raw):
    return base64.b64encode(("untrusted comment: fixture\n" + base64.b64encode(raw).decode() + "\n").encode()).decode()


class GithubUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.key = self.root / "key.pub"
        self.key.write_text(encoded_file(b"Ed" + b"12345678" + b"k" * 32))
        self.archive = self.root / "Nodal-Studio_0.2.0_universal.app.tar.gz"
        self.signature = self.root / "update.sig"
        self.signature.write_text(encoded_file(b"ED" + b"12345678" + b"s" * 64))
        self.package()

    def package(self, *, version="0.2.0", identifier=updater.IDENTIFIER, universal=True, symlink=False):
        metadata = plistlib.dumps({"CFBundleIdentifier": identifier, "CFBundleShortVersionString": version,
                                  "CFBundleExecutable": "nodalstudio-desktop"})
        header = b"\xca\xfe\xba\xbe" + (2).to_bytes(4, "big")
        header += (0x01000007).to_bytes(4, "big") + bytes(16)
        header += (0x0100000C).to_bytes(4, "big") + bytes(16)
        if not universal:
            header = b"\xcf\xfa\xed\xfe" + (0x0100000C).to_bytes(4, "little")
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, data, mode in [("Contents/Info.plist", metadata, 0o644),
                                     ("Contents/MacOS/nodalstudio-desktop", header, 0o755)]:
                entry = tarfile.TarInfo("Nodal Studio.app/" + name)
                entry.size, entry.mode = len(data), mode
                archive.addfile(entry, io.BytesIO(data))
            if symlink:
                entry = tarfile.TarInfo("Nodal Studio.app/link")
                entry.type, entry.linkname = tarfile.SYMTYPE, "/etc/passwd"
                archive.addfile(entry)

    def manifest(self, target="universal", version="0.2.0"):
        return updater.manifest(self.archive, self.signature, self.key, version, target, "Release notes")

    def test_config_embeds_only_public_key_and_official_https_feed(self):
        config = updater.configure(self.key)
        self.assertTrue(config["bundle"]["createUpdaterArtifacts"])
        self.assertEqual(config["plugins"]["updater"]["endpoints"], [updater.ENDPOINT])
        self.key.write_text(encoded_file(b"Ed" + bytes(100)))
        with self.assertRaises(ValueError):
            updater.configure(self.key)

    @patch.object(updater.subprocess, "run")
    def test_universal_manifest_uses_immutable_urls_and_signature_contents(self, verify):
        result = self.manifest()
        self.assertEqual(set(result["platforms"]), {"darwin-aarch64", "darwin-x86_64"})
        for platform in result["platforms"].values():
            self.assertIn("/releases/download/v0.2.0/", platform["url"])
            self.assertEqual(platform["signature"], self.signature.read_text())
        self.assertEqual(verify.call_args.args[0][0:2], ["minisign", "-Vm"])
        self.assertTrue(verify.call_args.kwargs["check"])

    def test_wrong_signing_key_is_rejected_before_verifying(self):
        self.signature.write_text(encoded_file(b"ED" + b"87654321" + b"s" * 64))
        with self.assertRaisesRegex(ValueError, "public key"):
            self.manifest()

    @patch.object(updater.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "minisign"))
    def test_invalid_signature_cannot_generate_manifest(self, _verify):
        with self.assertRaises(subprocess.CalledProcessError):
            self.manifest()

    @patch.object(updater.subprocess, "run")
    def test_identity_version_links_and_architecture_mismatches_fail(self, _verify):
        for kwargs in [{"version": "0.1.0"}, {"identifier": "another.app"}, {"symlink": True}, {"universal": False}]:
            self.package(**kwargs)
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.manifest()
        self.package(universal=False)
        self.assertEqual(set(self.manifest("aarch64")["platforms"]), {"darwin-aarch64"})
        for version in ["0.2.0-beta.1", "v0.2.0", "01.2.0", "../../other"]:
            with self.subTest(version=version), self.assertRaises(ValueError):
                self.manifest(version=version)

    def test_cli_never_overwrites_existing_configuration(self):
        output = self.root / "config.json"
        command = ["python3", str(SCRIPT), "configure", "--public-key", str(self.key), "--output", str(output)]
        first = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertEqual(first.returncode, 0, first.stderr)
        before = json.loads(output.read_text())
        second = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertNotEqual(second.returncode, 0)
        self.assertEqual(json.loads(output.read_text()), before)

    @patch.object(updater.subprocess, "run")
    def test_damaged_gzip_trailer_cannot_generate_manifest(self, _verify):
        original = self.archive.read_bytes()
        for damaged in [original[:-8], original[:-8] + bytes(8)]:
            with self.subTest(truncated=len(damaged) < len(original)):
                self.archive.write_bytes(damaged)
                with self.assertRaisesRegex(ValueError, "compressed update archive is damaged"):
                    self.manifest()

    @patch.object(updater.subprocess, "run")
    def test_expansion_limit_includes_data_after_tar_end_marker(self, _verify):
        payload = gzip.decompress(self.archive.read_bytes()) + bytes(32 * 1024)
        self.archive.write_bytes(gzip.compress(payload))
        with patch.object(updater, "MAX_BYTES", 20 * 1024):
            with self.assertRaisesRegex(ValueError, "Expanded update"):
                self.manifest()


if __name__ == "__main__":
    unittest.main()
