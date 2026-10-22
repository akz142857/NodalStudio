#!/usr/bin/env python3
"""Prepare a GitHub updater config/manifest. Never upload or publish a release."""
import argparse
import base64
import datetime
import json
from pathlib import Path, PurePosixPath
import plistlib
import re
import subprocess
import tarfile
import tempfile
from urllib.parse import quote

REPOSITORY = "akz142857/NodalStudio"
IDENTIFIER = "com.claycosmos.nodalstudio"
ENDPOINT = f"https://github.com/{REPOSITORY}/releases/latest/download/latest.json"
MAX_BYTES = 512 * 1024 * 1024
VERSION = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)")


def read_public_key(path):
    encoded = Path(path).read_text().strip()
    lines = base64.b64decode(encoded, validate=True).decode("utf-8").splitlines()
    raw = base64.b64decode(lines[1], validate=True)
    if len(raw) != 42 or raw[:2] != b"Ed" or not lines[0].startswith("untrusted comment:"):
        raise ValueError("Expected a Tauri updater PUBLIC key; private keys cannot be embedded.")
    return encoded, lines[1], raw[2:10]


def configure(public_key):
    encoded, _, _ = read_public_key(public_key)
    return {"bundle": {"createUpdaterArtifacts": True},
            "plugins": {"updater": {"pubkey": encoded, "endpoints": [ENDPOINT]}}}


def inspect_archive(archive_path, version, target):
    """Check identity and Mach-O architecture without extracting untrusted files."""
    roots, paths, total, metadata, executables = set(), set(), 0, None, {}
    with tarfile.open(archive_path, "r:gz") as archive:
        for entry in archive:
            path = PurePosixPath(entry.name)
            if path.is_absolute() or ".." in path.parts or not path.parts:
                raise ValueError("Unsafe archive path")
            if path in paths or not (entry.isfile() or entry.isdir()):
                raise ValueError("Duplicate paths, links and special files are not supported")
            paths.add(path)
            roots.add(path.parts[0])
            total += entry.size
            if total > MAX_BYTES:
                raise ValueError("Expanded update exceeds 512 MB")
            if path.parts[1:] == ("Contents", "Info.plist"):
                if entry.size > 1024 * 1024:
                    raise ValueError("Application metadata is too large")
                metadata = plistlib.loads(archive.extractfile(entry).read())
            if len(path.parts) == 4 and path.parts[1:3] == ("Contents", "MacOS") and entry.isfile():
                executables[path.name] = (entry, archive.extractfile(entry).read(4096))
    if len(roots) != 1 or not next(iter(roots)).endswith(".app") or metadata is None:
        raise ValueError("Expected exactly one application bundle")
    if metadata.get("CFBundleIdentifier") != IDENTIFIER or metadata.get("CFBundleShortVersionString") != version:
        raise ValueError("Archive identity/version does not match this release")
    name = metadata.get("CFBundleExecutable")
    if name not in executables:
        raise ValueError("Application executable is missing")
    entry, header = executables[name]
    if not entry.mode & 0o100 or not entry.size:
        raise ValueError("Application executable is empty or not executable")
    architectures = macho_architectures(header)
    expected = {"aarch64", "x86_64"} if target == "universal" else {target}
    if not expected.issubset(architectures):
        raise ValueError(f"Executable architectures {architectures} do not support {target}")


def macho_architectures(header):
    cpu_names = {0x01000007: "x86_64", 0x0100000C: "aarch64"}
    magic = header[:4]
    if magic in (b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf") and len(header) >= 8:
        order = "little" if magic == b"\xcf\xfa\xed\xfe" else "big"
        return {cpu_names.get(int.from_bytes(header[4:8], order), "unsupported")}
    if magic in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf") and len(header) >= 8:
        count = int.from_bytes(header[4:8], "big")
        stride = 20 if magic == b"\xca\xfe\xba\xbe" else 32
        if not 1 <= count <= 32 or len(header) < 8 + count * stride:
            raise ValueError("Invalid universal executable header")
        return {cpu_names.get(int.from_bytes(header[8 + n * stride:12 + n * stride], "big"), "unsupported") for n in range(count)}
    raise ValueError("Expected a macOS Mach-O executable")


def manifest(archive, signature, public_key, version, target, notes=""):
    # GitHub /latest is stable only. Beta feeds must be published separately.
    if not VERSION.fullmatch(version):
        raise ValueError("The official latest.json requires a stable MAJOR.MINOR.PATCH version")
    archive = Path(archive)
    if not archive.name.endswith(".app.tar.gz") or not 0 < archive.stat().st_size <= MAX_BYTES:
        raise ValueError("Expected a nonempty .app.tar.gz no larger than 512 MB")
    encoded_signature = Path(signature).read_text().strip()
    decoded = base64.b64decode(encoded_signature, validate=True).decode("utf-8")
    lines = decoded.splitlines()
    raw_signature = base64.b64decode(lines[1], validate=True)
    _, minisign_key, key_id = read_public_key(public_key)
    if len(raw_signature) != 74 or raw_signature[2:10] != key_id:
        raise ValueError("The update signature does not match the embedded public key")
    # Use the maintained verifier, never a hand-rolled cryptographic implementation.
    with tempfile.TemporaryDirectory(prefix="nodal-update-verify-") as directory:
        sig = Path(directory) / "archive.minisig"
        sig.write_text(decoded)
        subprocess.run(["minisign", "-Vm", str(archive.resolve()), "-P", minisign_key, "-x", str(sig)],
                       check=True, capture_output=True, text=True)
    inspect_archive(archive, version, target)
    url = f"https://github.com/{REPOSITORY}/releases/download/v{version}/{quote(archive.name, safe='')}"
    targets = ("aarch64", "x86_64") if target == "universal" else (target,)
    return {"version": version, "notes": notes,
            "pub_date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "platforms": {f"darwin-{arch}": {"url": url, "signature": encoded_signature} for arch in targets}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    config = commands.add_parser("configure")
    config.add_argument("--public-key", required=True)
    config.add_argument("--output")
    release = commands.add_parser("manifest")
    for flag in ("archive", "signature", "public-key", "version", "output"):
        release.add_argument(f"--{flag}", required=True)
    release.add_argument("--target", choices=("universal", "aarch64", "x86_64"), required=True)
    release.add_argument("--notes-file")
    args = parser.parse_args()
    try:
        if args.command == "configure":
            result = configure(args.public_key)
        else:
            notes = Path(args.notes_file).read_text() if args.notes_file else ""
            result = manifest(args.archive, args.signature, args.public_key, args.version, args.target, notes)
        if args.output:
            # Exclusive create prevents overwriting an already prepared release.
            with Path(args.output).open("x") as output:
                json.dump(result, output, indent=2)
                output.write("\n")
            print(f"Created {args.output}")
        else:
            print("Updater public key is valid")
    except (ValueError, IndexError, OSError, tarfile.TarError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Update preparation failed: {error}\n")


if __name__ == "__main__":
    main()
