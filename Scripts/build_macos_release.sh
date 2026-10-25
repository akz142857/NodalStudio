#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_CONFIG="$REPOSITORY_ROOT/config/macos-release.env"
CONFIG_FILE="${NODAL_MACOS_RELEASE_CONFIG:-$DEFAULT_CONFIG}"
CHECK_ONLY=false
TEMP_KEYCHAIN=""
TEMP_KEYCHAIN_PASSWORD=""
ORIGINAL_KEYCHAINS=()
UPDATER_CONFIG_DIR=""

usage() {
  cat <<'EOF'
Build, sign, notarize, staple, and verify the Nodal Studio macOS release.

Usage:
  ./Scripts/build_macos_release.sh [--config PATH] [--check]

Options:
  --config PATH  Use a different release configuration file.
  --check        Validate configuration and signing prerequisites without building.
  -h, --help     Show this help.

The default private configuration is config/macos-release.env.
EOF
}

fail() {
  echo "error: $*" >&2
  exit 1
}

info() {
  echo "==> $*"
}

trim() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

load_config() {
  [[ -f "$CONFIG_FILE" ]] || fail "Missing config: $CONFIG_FILE. Copy config/macos-release.env.example first."

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(trim "$line")"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || fail "Invalid config line: $line"

    local key value
    key="$(trim "${line%%=*}")"
    value="$(trim "${line#*=}")"
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi

    case "$key" in
      APPLE_SIGNING_IDENTITY | APPLE_API_ISSUER | APPLE_API_KEY | APPLE_API_KEY_PATH | \
        APPLE_CERTIFICATE_PATH | APPLE_CERTIFICATE_PASSWORD | BUILD_TARGET | BUNDLE_FORMAT | \
        REQUIRE_CLEAN_GIT | INSTALL_DEPENDENCIES | UPDATER_PUBLIC_KEY_PATH | UPDATER_NOTES_PATH | \
        UPDATER_PRIVATE_KEY_PATH | UPDATER_KEYCHAIN_SERVICE | UPDATER_KEYCHAIN_ACCOUNT)
        printf -v "$key" '%s' "$value"
        export "$key"
        ;;
      *)
        fail "Unsupported config key: $key"
        ;;
    esac
  done <"$CONFIG_FILE"

  chmod 600 "$CONFIG_FILE"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "Set $name in $CONFIG_FILE"
}

validate_boolean() {
  local name="$1"
  case "${!name}" in
    true | false) ;;
    *) fail "$name must be true or false" ;;
  esac
}

cleanup() {
  if [[ -n "$UPDATER_CONFIG_DIR" ]]; then
    rm -rf "$UPDATER_CONFIG_DIR"
  fi
  if [[ -n "$TEMP_KEYCHAIN" ]]; then
    if [[ ${#ORIGINAL_KEYCHAINS[@]} -gt 0 ]]; then
      security list-keychains -d user -s "${ORIGINAL_KEYCHAINS[@]}" >/dev/null
    fi
    security delete-keychain "$TEMP_KEYCHAIN" >/dev/null 2>&1 || true
  fi
}

setup_temporary_keychain() {
  [[ -n "${APPLE_CERTIFICATE_PATH:-}" ]] || return 0
  [[ -f "$APPLE_CERTIFICATE_PATH" ]] || fail "Certificate file not found: $APPLE_CERTIFICATE_PATH"
  [[ "$APPLE_CERTIFICATE_PATH" == *.p12 ]] || fail "APPLE_CERTIFICATE_PATH must point to a .p12 containing the certificate and private key"
  require_value APPLE_CERTIFICATE_PASSWORD

  while IFS= read -r keychain; do
    keychain="$(trim "${keychain//\"/}")"
    [[ -n "$keychain" ]] && ORIGINAL_KEYCHAINS+=("$keychain")
  done < <(security list-keychains -d user)

  TEMP_KEYCHAIN="${TMPDIR:-/tmp}/nodalstudio-release-$$.keychain-db"
  TEMP_KEYCHAIN_PASSWORD="$(uuidgen)"
  security create-keychain -p "$TEMP_KEYCHAIN_PASSWORD" "$TEMP_KEYCHAIN"
  security set-keychain-settings -lut 21600 "$TEMP_KEYCHAIN"
  security unlock-keychain -p "$TEMP_KEYCHAIN_PASSWORD" "$TEMP_KEYCHAIN"
  security import "$APPLE_CERTIFICATE_PATH" \
    -k "$TEMP_KEYCHAIN" \
    -P "$APPLE_CERTIFICATE_PASSWORD" \
    -T /usr/bin/codesign \
    -T /usr/bin/security
  security set-key-partition-list \
    -S apple-tool:,apple:,codesign: \
    -s \
    -k "$TEMP_KEYCHAIN_PASSWORD" \
    "$TEMP_KEYCHAIN" >/dev/null
  security list-keychains -d user -s "$TEMP_KEYCHAIN" "${ORIGINAL_KEYCHAINS[@]}"
}

validate_signing_identity() {
  local identities identity
  identities="$(security find-identity -v -p codesigning)"
  if [[ "$APPLE_SIGNING_IDENTITY" == "auto" ]]; then
    local matches=() match_count=0
    while IFS= read -r identity; do
      [[ -n "$identity" ]] || continue
      local duplicate=false existing
      if [[ "$match_count" -gt 0 ]]; then
        for existing in "${matches[@]}"; do
          if [[ "$existing" == "$identity" ]]; then
            duplicate=true
            break
          fi
        done
      fi
      if [[ "$duplicate" != "true" ]]; then
        matches[$match_count]="$identity"
        match_count=$((match_count + 1))
      fi
    done < <(
      printf '%s\n' "$identities" |
        sed -n 's/^[^"]*"\(Developer ID Application:[^"]*\)".*/\1/p'
    )
    case "$match_count" in
      0)
        fail "No Developer ID Application identity is available in Keychain. Install it or configure APPLE_CERTIFICATE_PATH with a .p12."
        ;;
      1)
        APPLE_SIGNING_IDENTITY="${matches[0]}"
        export APPLE_SIGNING_IDENTITY
        ;;
      *)
        printf '%s\n' "${matches[@]}" >&2
        fail "Multiple Developer ID Application identities are available. Set APPLE_SIGNING_IDENTITY explicitly."
        ;;
    esac
  fi
  printf '%s\n' "$identities" | grep -F "$APPLE_SIGNING_IDENTITY" >/dev/null ||
    fail "Signing identity is unavailable: $APPLE_SIGNING_IDENTITY"
}

bundle_root() {
  if [[ "$BUILD_TARGET" == "host" ]]; then
    printf '%s/target/release/bundle' "$REPOSITORY_ROOT"
  else
    printf '%s/target/%s/release/bundle' "$REPOSITORY_ROOT" "$BUILD_TARGET"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      [[ $# -ge 2 ]] || fail "--config requires a path"
      CONFIG_FILE="$2"
      shift 2
      ;;
    --check)
      CHECK_ONLY=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

trap cleanup EXIT
cd "$REPOSITORY_ROOT"

load_config

BUILD_TARGET="${BUILD_TARGET:-universal-apple-darwin}"
BUNDLE_FORMAT="${BUNDLE_FORMAT:-dmg}"
REQUIRE_CLEAN_GIT="${REQUIRE_CLEAN_GIT:-true}"
INSTALL_DEPENDENCIES="${INSTALL_DEPENDENCIES:-false}"

require_value APPLE_SIGNING_IDENTITY
require_value APPLE_API_ISSUER
require_value APPLE_API_KEY_PATH
[[ -f "$APPLE_API_KEY_PATH" ]] || fail "App Store Connect private key not found: $APPLE_API_KEY_PATH"
if [[ -z "${APPLE_API_KEY:-}" ]]; then
  API_KEY_FILENAME="$(basename "$APPLE_API_KEY_PATH")"
  if [[ "$API_KEY_FILENAME" == AuthKey_*.p8 ]]; then
    APPLE_API_KEY="${API_KEY_FILENAME#AuthKey_}"
    APPLE_API_KEY="${APPLE_API_KEY%.p8}"
    export APPLE_API_KEY
  else
    fail "Set APPLE_API_KEY or name the private key AuthKey_KEYID.p8"
  fi
fi
[[ "$BUNDLE_FORMAT" == "dmg" ]] || fail "Formal macOS releases must use BUNDLE_FORMAT=dmg"
validate_boolean REQUIRE_CLEAN_GIT
validate_boolean INSTALL_DEPENDENCIES

for command in cargo codesign git node pnpm rustup security shasum spctl uuidgen xcrun; do
  require_command "$command"
done
RELEASE_VERSION="$(node -p 'require("./apps/desktop/src-tauri/tauri.conf.json").version')"

if [[ -n "${UPDATER_PUBLIC_KEY_PATH:-}" ]]; then
  require_command python3
  require_command minisign
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -n "${UPDATER_PRIVATE_KEY_PATH:-}" ]]; then
    [[ -f "$UPDATER_PRIVATE_KEY_PATH" ]] || fail "Updater private key file is unavailable."
    export TAURI_SIGNING_PRIVATE_KEY="$UPDATER_PRIVATE_KEY_PATH"
  fi
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x}" && -n "${UPDATER_KEYCHAIN_SERVICE:-}" ]]; then
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -s "$UPDATER_KEYCHAIN_SERVICE" -a "${UPDATER_KEYCHAIN_ACCOUNT:-production}" -w)" || fail "Unable to read the updater password from Keychain."
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  fi
  [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]] || fail "Export TAURI_SIGNING_PRIVATE_KEY for updater-enabled releases."
  python3 "$SCRIPT_DIR/github_update.py" configure --public-key "$UPDATER_PUBLIC_KEY_PATH"
  case "$BUILD_TARGET" in
    universal-apple-darwin) UPDATER_TARGET=universal ;;
    aarch64-apple-darwin) UPDATER_TARGET=aarch64 ;;
    x86_64-apple-darwin) UPDATER_TARGET=x86_64 ;;
    host)
      case "$(uname -m)" in
        arm64) UPDATER_TARGET=aarch64 ;;
        x86_64) UPDATER_TARGET=x86_64 ;;
        *) fail "Unsupported updater host architecture" ;;
      esac ;;
    *) fail "Unsupported macOS updater target: $BUILD_TARGET" ;;
  esac
  UPDATER_OUTPUT="$REPOSITORY_ROOT/dist/releases/macos-$RELEASE_VERSION-updater"
  [[ ! -e "$UPDATER_OUTPUT" ]] || fail "Updater output already exists: $UPDATER_OUTPUT. Preserve it and use a new release version."
fi

if [[ "$CHECK_ONLY" != "true" && "$REQUIRE_CLEAN_GIT" == "true" && -n "$(git status --porcelain)" ]]; then
  fail "Git working tree is not clean. Commit or stash changes, or set REQUIRE_CLEAN_GIT=false."
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" != "24" ]]; then
  echo "warning: Node.js 24 is recommended; current version is $(node --version)" >&2
fi

setup_temporary_keychain
validate_signing_identity

info "Signing and notarization configuration is valid"
if [[ "$CHECK_ONLY" == "true" ]]; then
  exit 0
fi

if [[ "$INSTALL_DEPENDENCIES" == "true" ]]; then
  info "Installing locked frontend dependencies"
  pnpm install --frozen-lockfile
fi

if [[ "$BUILD_TARGET" == "universal-apple-darwin" ]]; then
  info "Ensuring Apple Silicon and Intel Rust targets are installed"
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
elif [[ "$BUILD_TARGET" != "host" ]]; then
  rustup target add "$BUILD_TARGET"
fi

info "Building, signing, notarizing, and stapling Nodal Studio"
# Keep the app bundle for signature, ticket, and Gatekeeper verification below.
BUILD_ARGS=(--bundles "app,$BUNDLE_FORMAT" --config src-tauri/tauri.release.conf.json)
if [[ "$BUILD_TARGET" != "host" ]]; then
  BUILD_ARGS+=(--target "$BUILD_TARGET")
fi
if [[ -n "${UPDATER_PUBLIC_KEY_PATH:-}" ]]; then
  UPDATER_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nodal-updater-config.XXXXXX")"
  python3 "$SCRIPT_DIR/github_update.py" configure --public-key "$UPDATER_PUBLIC_KEY_PATH" --output "$UPDATER_CONFIG_DIR/tauri.json"
  BUILD_ARGS+=(--config "$UPDATER_CONFIG_DIR/tauri.json")
fi
pnpm --filter @nodalstudio/desktop tauri build "${BUILD_ARGS[@]}" -- --locked

BUNDLE_ROOT="$(bundle_root)"
APP_PATH="$BUNDLE_ROOT/macos/Nodal Studio.app"
[[ -d "$APP_PATH" ]] || fail "App bundle was not generated: $APP_PATH"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_PATH/Contents/Info.plist")" == \
    "com.claycosmos.nodalstudio" ]] || fail "Release bundle has the wrong application identifier"

# Tauri retains older release artifacts in this directory. Never publish the
# first arbitrary DMG under a new version's name.
shopt -s nullglob
DMG_CANDIDATES=("$BUNDLE_ROOT/dmg/Nodal Studio_${RELEASE_VERSION}_"*.dmg)
shopt -u nullglob
[[ ${#DMG_CANDIDATES[@]} -eq 1 ]] || fail "Expected exactly one DMG for version $RELEASE_VERSION below $BUNDLE_ROOT/dmg"
DMG_PATH="${DMG_CANDIDATES[0]}"
[[ -f "$DMG_PATH" ]] || fail "DMG was not generated: $DMG_PATH"

info "Verifying code signature"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign --verify --verbose=2 "$DMG_PATH"

# Tauri notarizes and staples the app, but only signs the outer DMG.
info "Notarizing the distribution DMG"
NOTARIZATION_PATH="$DMG_PATH.notarization.json"
xcrun notarytool submit "$DMG_PATH" \
  --key "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER" \
  --wait \
  --timeout 30m \
  --output-format json >"$NOTARIZATION_PATH"
node -e '
  const fs = require("node:fs");
  const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (result.status !== "Accepted") {
    console.error(`DMG notarization was not accepted: ${result.status} (${result.id})`);
    process.exit(1);
  }
  console.log(`DMG notarization accepted: ${result.id}`);
' "$NOTARIZATION_PATH"
xcrun stapler staple "$DMG_PATH"

info "Verifying Apple notarization ticket"
xcrun stapler validate "$APP_PATH"
xcrun stapler validate "$DMG_PATH"

info "Running Gatekeeper assessment"
spctl --assess --type execute --verbose=4 "$APP_PATH"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG_PATH"

CHECKSUM_PATH="$DMG_PATH.sha256"
shasum -a 256 "$DMG_PATH" >"$CHECKSUM_PATH"

if [[ -n "${UPDATER_PUBLIC_KEY_PATH:-}" ]]; then
  info "Preparing verified GitHub update artifacts"
  [[ -f "$APP_PATH.tar.gz" && -f "$APP_PATH.tar.gz.sig" ]] || fail "Tauri did not generate the signed updater archive"
  mkdir -p "$UPDATER_OUTPUT"
  UPDATE_ARCHIVE="$UPDATER_OUTPUT/Nodal-Studio_${RELEASE_VERSION}_${UPDATER_TARGET}.app.tar.gz"
  cp "$APP_PATH.tar.gz" "$UPDATE_ARCHIVE"
  cp "$APP_PATH.tar.gz.sig" "$UPDATE_ARCHIVE.sig"
  MANIFEST_ARGS=(manifest --archive "$UPDATE_ARCHIVE" --signature "$UPDATE_ARCHIVE.sig"
    --public-key "$UPDATER_PUBLIC_KEY_PATH" --version "$RELEASE_VERSION"
    --target "$UPDATER_TARGET" --output "$UPDATER_OUTPUT/latest.json")
  if [[ -n "${UPDATER_NOTES_PATH:-}" ]]; then
    MANIFEST_ARGS+=(--notes-file "$UPDATER_NOTES_PATH")
  fi
  python3 "$SCRIPT_DIR/github_update.py" "${MANIFEST_ARGS[@]}"
  cp "$DMG_PATH" "$UPDATER_OUTPUT/Nodal-Studio_${RELEASE_VERSION}_${UPDATER_TARGET}.dmg"
  (cd "$UPDATER_OUTPUT" && shasum -a 256 ./*.app.tar.gz ./*.dmg >SHA256SUMS)
  echo "GitHub release artifacts: $UPDATER_OUTPUT"
  echo "Review and upload all files to draft v$RELEASE_VERSION before publishing. No files have been uploaded."
fi

info "Release completed"
echo "App:      $APP_PATH"
echo "DMG:      $DMG_PATH"
echo "SHA-256:  $CHECKSUM_PATH"
echo "Notary:   $NOTARIZATION_PATH"
