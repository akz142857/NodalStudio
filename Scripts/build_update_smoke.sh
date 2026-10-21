#!/usr/bin/env bash
# Builds two isolated, signed local upgrade versions. Never distribute these builds.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/target/updater-smoke}"
[[ ! -e "$OUT" ]] || { echo "Choose a new output directory; refusing to overwrite test keys or apps." >&2; exit 1; }
mkdir -p "$OUT/serve" "$OUT/installed"
OUT="$(cd "$OUT" && pwd)"
cd "$ROOT"
pnpm --filter @nodalstudio/desktop tauri signer generate --ci -p '' -w "$OUT/signing.key" >"$OUT/key-generation.log" 2>&1
export TAURI_SIGNING_PRIVATE_KEY="$OUT/signing.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''
export APPLE_SIGNING_IDENTITY=-
for VERSION in 0.1.1 0.1.2; do
  python3 - "$OUT" "$VERSION" <<'PY'
import json,sys
from pathlib import Path
out, version = Path(sys.argv[1]), sys.argv[2]
config = {"productName":"Nodal Studio Update Test", "version":version, "identifier":"com.claycosmos.nodalstudio.updater-smoke",
          "app":{"windows":[{"title":"Nodal Studio Update Test", "width":1100,"height":800,"minWidth":960,"minHeight":640}]},
          "bundle":{"createUpdaterArtifacts":True},
          "plugins":{"updater":{"pubkey":(out/'signing.key.pub').read_text().strip(),"endpoints":["http://127.0.0.1:18423/latest.json"],"dangerousInsecureTransportProtocol":True}}}
(out/f'{version}.json').write_text(json.dumps(config))
PY
  pnpm --filter @nodalstudio/desktop tauri build --bundles app --features updater-smoke-test --config "$OUT/$VERSION.json"
  BUNDLE="$ROOT/target/release/bundle/macos/Nodal Studio Update Test.app"
  codesign --verify --deep --strict "$BUNDLE"
  if [[ "$VERSION" == "0.1.1" ]]; then
    ditto "$BUNDLE" "$OUT/installed/Nodal Studio Update Test.app"
  else
    cp "$BUNDLE.tar.gz" "$OUT/serve/update.app.tar.gz"
    cp "$BUNDLE.tar.gz.sig" "$OUT/serve/update.app.tar.gz.sig"
  fi
done
python3 - "$OUT" <<'PY'
import json,sys,hashlib
from pathlib import Path
out=Path(sys.argv[1]); serve=out/'serve'
manifest={"version":"0.1.2","notes":"Local acceptance build: signed update, safe restart and local data preservation.","platforms":{"darwin-aarch64":{"url":"http://127.0.0.1:18423/update.app.tar.gz","signature":(serve/'update.app.tar.gz.sig').read_text().strip()}}}
for filename in ['latest.json','valid.json']:
    (serve/filename).write_text(json.dumps(manifest))
manifest['platforms']['darwin-aarch64']['signature']='invalid-signature'
(serve/'bad-signature.json').write_text(json.dumps(manifest))
(out/'build-info.txt').write_text('Isolated local acceptance builds: 0.1.1 -> 0.1.2\nLoopback server: 127.0.0.1:18423\nIdentifier: com.claycosmos.nodalstudio.updater-smoke\nNever distribute these artifacts or signing keys.\nSHA256(update.app.tar.gz): '+hashlib.sha256((serve/'update.app.tar.gz').read_bytes()).hexdigest()+'\n')
PY
printf 'Local acceptance builds ready: %s\n' "$OUT"
printf 'Serve: python3 -m http.server 18423 --bind 127.0.0.1 --directory "%s/serve"\n' "$OUT"
printf 'Launch: open "%s/installed/Nodal Studio Update Test.app"\n' "$OUT"
