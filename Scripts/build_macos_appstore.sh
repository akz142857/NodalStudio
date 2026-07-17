#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_CONFIG="$REPOSITORY_ROOT/config/macos-appstore.env"
CONFIG_FILE="${NODAL_MACOS_APPSTORE_CONFIG:-$DEFAULT_CONFIG}"
TAURI_DIRECTORY="$REPOSITORY_ROOT/apps/desktop/src-tauri"
TAURI_CONFIG="$TAURI_DIRECTORY/tauri.conf.json"
APPSTORE_CONFIG="src-tauri/tauri.appstore.conf.json"
ENTITLEMENTS_FILE="$TAURI_DIRECTORY/Entitlements.appstore.plist"
INFO_PLIST_FILE="$TAURI_DIRECTORY/Info.appstore.plist"
SOURCE_ICNS_FILE="$TAURI_DIRECTORY/icons/icon.icns"
STAGING_DIRECTORY="$TAURI_DIRECTORY/.appstore"
STAGED_PROFILE="$STAGING_DIRECTORY/embedded.provisionprofile"

CHECK_ONLY=false
UPLOAD=false
TEMP_KEYCHAIN=""
TEMP_KEYCHAIN_PASSWORD=""
PROFILE_PLIST=""
PROFILE_CERT_HASHES="|"
STAGED_API_KEY=""
TEMP_ICON_DIRECTORY=""
ORIGINAL_KEYCHAINS=()
ORIGINAL_KEYCHAIN_COUNT=0

usage() {
  cat <<'EOF'
Build, sign, verify, and optionally upload Nodal Studio for the Mac App Store.

Usage:
  ./Scripts/build_macos_appstore.sh [--config PATH] [--check] [--upload]

Options:
  --config PATH  Use a different private configuration file.
  --check        Validate certificates, profile, entitlements, and config only.
  --upload       Upload the generated .pkg with App Store Connect API credentials.
  -h, --help     Show this help.

Without --upload, the generated .pkg can be uploaded with Transporter.
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
  [[ -f "$CONFIG_FILE" ]] ||
    fail "Missing config: $CONFIG_FILE. Copy config/macos-appstore.env.example first."

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
      APP_BUNDLE_ID | APPLE_TEAM_ID | PROVISIONING_PROFILE | \
        APP_DISTRIBUTION_IDENTITY | INSTALLER_DISTRIBUTION_IDENTITY | \
        APP_DISTRIBUTION_CERTIFICATE_PATH | APP_DISTRIBUTION_CERTIFICATE_PASSWORD | \
        INSTALLER_DISTRIBUTION_CERTIFICATE_PATH | INSTALLER_DISTRIBUTION_CERTIFICATE_PASSWORD | \
        APP_BUILD_NUMBER | APPLE_API_ISSUER | APPLE_API_KEY | APPLE_API_KEY_ID | \
        APPLE_API_KEY_PATH | BUILD_TARGET | OUTPUT_DIRECTORY | REQUIRE_CLEAN_GIT | \
        INSTALL_DEPENDENCIES)
        printf -v "$key" '%s' "$value"
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
  [[ -n "$PROFILE_PLIST" ]] && rm -f "$PROFILE_PLIST"
  [[ -n "$STAGED_API_KEY" ]] && rm -f "$STAGED_API_KEY"
  [[ -n "$TEMP_ICON_DIRECTORY" ]] && rm -rf "$TEMP_ICON_DIRECTORY"
  rm -f "$STAGED_PROFILE"
  rmdir "$STAGING_DIRECTORY" >/dev/null 2>&1 || true
  rmdir "$REPOSITORY_ROOT/private_keys" >/dev/null 2>&1 || true

  if [[ -n "$TEMP_KEYCHAIN" ]]; then
    if [[ "$ORIGINAL_KEYCHAIN_COUNT" -gt 0 ]]; then
      security list-keychains -d user -s "${ORIGINAL_KEYCHAINS[@]}" >/dev/null
    fi
    security delete-keychain "$TEMP_KEYCHAIN" >/dev/null 2>&1 || true
  fi
}

validate_p12_pair() {
  local path_name="$1" password_name="$2"
  local path_value="${!path_name:-}" password_value="${!password_name:-}"
  if [[ -n "$path_value" || -n "$password_value" ]]; then
    [[ -n "$path_value" ]] || fail "Set $path_name when $password_name is configured"
    [[ -n "$password_value" ]] || fail "Set $password_name when $path_name is configured"
    [[ -f "$path_value" ]] || fail "Certificate file not found: $path_value"
    [[ "$path_value" == *.p12 ]] || fail "$path_name must point to a .p12 file"
  fi
}

setup_temporary_keychain() {
  validate_p12_pair APP_DISTRIBUTION_CERTIFICATE_PATH APP_DISTRIBUTION_CERTIFICATE_PASSWORD
  validate_p12_pair INSTALLER_DISTRIBUTION_CERTIFICATE_PATH INSTALLER_DISTRIBUTION_CERTIFICATE_PASSWORD

  if [[ -z "${APP_DISTRIBUTION_CERTIFICATE_PATH:-}" && \
        -z "${INSTALLER_DISTRIBUTION_CERTIFICATE_PATH:-}" ]]; then
    return
  fi

  local keychain
  while IFS= read -r keychain; do
    keychain="$(trim "${keychain//\"/}")"
    [[ -n "$keychain" ]] || continue
    ORIGINAL_KEYCHAINS[$ORIGINAL_KEYCHAIN_COUNT]="$keychain"
    ORIGINAL_KEYCHAIN_COUNT=$((ORIGINAL_KEYCHAIN_COUNT + 1))
  done < <(security list-keychains -d user)

  TEMP_KEYCHAIN="${TMPDIR:-/tmp}/nodalstudio-appstore-$$.keychain-db"
  TEMP_KEYCHAIN_PASSWORD="$(uuidgen)"
  security create-keychain -p "$TEMP_KEYCHAIN_PASSWORD" "$TEMP_KEYCHAIN"
  security set-keychain-settings -lut 21600 "$TEMP_KEYCHAIN"
  security unlock-keychain -p "$TEMP_KEYCHAIN_PASSWORD" "$TEMP_KEYCHAIN"

  if [[ -n "${APP_DISTRIBUTION_CERTIFICATE_PATH:-}" ]]; then
    security import "$APP_DISTRIBUTION_CERTIFICATE_PATH" \
      -k "$TEMP_KEYCHAIN" \
      -P "$APP_DISTRIBUTION_CERTIFICATE_PASSWORD" \
      -T /usr/bin/codesign \
      -T /usr/bin/productbuild \
      -T /usr/bin/security
  fi
  if [[ -n "${INSTALLER_DISTRIBUTION_CERTIFICATE_PATH:-}" && \
        "$INSTALLER_DISTRIBUTION_CERTIFICATE_PATH" != "${APP_DISTRIBUTION_CERTIFICATE_PATH:-}" ]]; then
    security import "$INSTALLER_DISTRIBUTION_CERTIFICATE_PATH" \
      -k "$TEMP_KEYCHAIN" \
      -P "$INSTALLER_DISTRIBUTION_CERTIFICATE_PASSWORD" \
      -T /usr/bin/codesign \
      -T /usr/bin/productbuild \
      -T /usr/bin/security
  fi

  security set-key-partition-list \
    -S apple-tool:,apple:,codesign: \
    -s \
    -k "$TEMP_KEYCHAIN_PASSWORD" \
    "$TEMP_KEYCHAIN" >/dev/null

  if [[ "$ORIGINAL_KEYCHAIN_COUNT" -gt 0 ]]; then
    security list-keychains -d user -s "$TEMP_KEYCHAIN" "${ORIGINAL_KEYCHAINS[@]}"
  else
    security list-keychains -d user -s "$TEMP_KEYCHAIN"
  fi
}

validate_profile() {
  [[ -f "$PROVISIONING_PROFILE" ]] ||
    fail "Provisioning profile not found: $PROVISIONING_PROFILE"

  PROFILE_PLIST="$(mktemp "${TMPDIR:-/tmp}/nodalstudio-profile.plist.XXXXXX")"
  security cms -D -i "$PROVISIONING_PROFILE" >"$PROFILE_PLIST" ||
    fail "Unable to decode provisioning profile: $PROVISIONING_PROFILE"

  local profile_team profile_app_id profile_expiration expiration_epoch now_epoch
  profile_team="$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$PROFILE_PLIST")"
  profile_app_id="$(/usr/libexec/PlistBuddy -c \
    'Print :Entitlements:com.apple.application-identifier' "$PROFILE_PLIST")"
  profile_expiration="$(plutil -extract ExpirationDate raw -o - "$PROFILE_PLIST")"

  [[ "$profile_team" == "$APPLE_TEAM_ID" ]] ||
    fail "Profile Team ID is $profile_team; expected $APPLE_TEAM_ID"
  [[ "$profile_app_id" == "$APPLE_TEAM_ID.$APP_BUNDLE_ID" ]] ||
    fail "Profile application identifier is $profile_app_id; expected $APPLE_TEAM_ID.$APP_BUNDLE_ID"

  expiration_epoch="$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$profile_expiration" '+%s')" ||
    fail "Unable to parse profile expiration: $profile_expiration"
  now_epoch="$(date '+%s')"
  [[ "$expiration_epoch" -gt "$now_epoch" ]] ||
    fail "Provisioning profile expired at $profile_expiration"

  local index=0 cert_data cert_file fingerprint
  while cert_data="$(plutil -extract "DeveloperCertificates.$index" raw -o - "$PROFILE_PLIST" 2>/dev/null)"; do
    cert_file="$(mktemp "${TMPDIR:-/tmp}/nodalstudio-profile-cert.der.XXXXXX")"
    printf '%s' "$cert_data" | openssl base64 -d -A -out "$cert_file"
    fingerprint="$(openssl x509 -inform DER -in "$cert_file" -noout -fingerprint -sha1 |
      sed 's/.*=//; s/://g' | tr '[:lower:]' '[:upper:]')"
    rm -f "$cert_file"
    PROFILE_CERT_HASHES="$PROFILE_CERT_HASHES$fingerprint|"
    index=$((index + 1))
  done
  [[ "$index" -gt 0 ]] || fail "Provisioning profile contains no distribution certificate"

  info "Provisioning profile is valid through $profile_expiration"
}

identity_is_in_profile() {
  [[ "$PROFILE_CERT_HASHES" == *"|$1|"* ]]
}

validate_icns_has_1024() {
  local icns_path="$1" label="$2"
  [[ -f "$icns_path" ]] || fail "$label ICNS file not found: $icns_path"

  TEMP_ICON_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/nodalstudio-icon.XXXXXX")"
  local iconset_path="$TEMP_ICON_DIRECTORY/AppIcon.iconset"
  iconutil -c iconset "$icns_path" -o "$iconset_path" ||
    fail "Unable to inspect $label ICNS file: $icns_path"

  local required_icon="$iconset_path/icon_512x512@2x.png"
  [[ -f "$required_icon" ]] ||
    fail "$label ICNS is missing the required 512pt @2x image"
  local width height
  width="$(sips -g pixelWidth "$required_icon" 2>/dev/null | awk '/pixelWidth/{print $2}')"
  height="$(sips -g pixelHeight "$required_icon" 2>/dev/null | awk '/pixelHeight/{print $2}')"
  [[ "$width" == "1024" && "$height" == "1024" ]] ||
    fail "$label ICNS 512pt @2x image is ${width}x${height}; expected 1024x1024"

  rm -rf "$TEMP_ICON_DIRECTORY"
  TEMP_ICON_DIRECTORY=""
}

resolve_identity() {
  local kind="$1" configured="$2"
  local identities line hash name
  local matches=() hashes=() match_count=0
  identities="$(security find-identity -v -p basic)"

  while IFS= read -r line; do
    [[ "$line" == *\"*\"* ]] || continue
    hash="$(printf '%s\n' "$line" | awk '{print $2}')"
    name="${line#*\"}"
    name="${name%%\"*}"

    case "$kind" in
      application)
        if [[ "$name" != 3rd\ Party\ Mac\ Developer\ Application:* && \
              "$name" != Apple\ Distribution:* ]]; then
          continue
        fi
        identity_is_in_profile "$hash" || continue
        ;;
      installer)
        [[ "$name" == 3rd\ Party\ Mac\ Developer\ Installer:* ]] || continue
        ;;
      *) fail "Unsupported identity kind: $kind" ;;
    esac

    if [[ "$configured" != "auto" && "$name" != "$configured" ]]; then
      continue
    fi

    local duplicate=false existing
    if [[ "$match_count" -gt 0 ]]; then
      for existing in "${matches[@]}"; do
        if [[ "$existing" == "$name" ]]; then
          duplicate=true
          break
        fi
      done
    fi
    if [[ "$duplicate" != "true" ]]; then
      matches[$match_count]="$name"
      hashes[$match_count]="$hash"
      match_count=$((match_count + 1))
    fi
  done <<<"$identities"

  if [[ "$match_count" -eq 0 ]]; then
    if [[ "$kind" == "application" ]]; then
      local expected_hashes="${PROFILE_CERT_HASHES#|}"
      expected_hashes="${expected_hashes%|}"
      fail "No installed Mac App Distribution identity matches the provisioning profile certificate SHA-1: $expected_hashes"
    fi
    fail "Mac Installer Distribution identity is unavailable: $configured"
  fi
  if [[ "$match_count" -gt 1 ]]; then
    printf '%s\n' "${matches[@]}" >&2
    fail "Multiple matching $kind identities are installed; configure the exact identity"
  fi

  RESOLVED_IDENTITY="${matches[0]}"
  RESOLVED_IDENTITY_HASH="${hashes[0]}"
}

validate_project_configuration() {
  [[ -f "$TAURI_CONFIG" ]] || fail "Missing Tauri config: $TAURI_CONFIG"
  [[ -f "$TAURI_DIRECTORY/tauri.appstore.conf.json" ]] ||
    fail "Missing App Store Tauri config"
  node -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const mac = config.bundle?.macOS;
    if (config.bundle?.category !== "DeveloperTool" ||
        mac?.entitlements !== "./Entitlements.appstore.plist" ||
        mac?.infoPlist !== "./Info.appstore.plist" ||
        mac?.files?.["embedded.provisionprofile"] !== "./.appstore/embedded.provisionprofile") {
      process.exit(1);
    }
  ' "$TAURI_DIRECTORY/tauri.appstore.conf.json" ||
    fail "App Store Tauri config is invalid"
  plutil -lint "$ENTITLEMENTS_FILE" "$INFO_PLIST_FILE" >/dev/null

  local configured_bundle configured_team configured_app_id sandbox network files encryption
  configured_bundle="$(node -p "require('$TAURI_CONFIG').identifier")"
  configured_team="$(/usr/libexec/PlistBuddy -c \
    'Print :com.apple.developer.team-identifier' "$ENTITLEMENTS_FILE")"
  configured_app_id="$(/usr/libexec/PlistBuddy -c \
    'Print :com.apple.application-identifier' "$ENTITLEMENTS_FILE")"
  sandbox="$(/usr/libexec/PlistBuddy -c \
    'Print :com.apple.security.app-sandbox' "$ENTITLEMENTS_FILE")"
  network="$(/usr/libexec/PlistBuddy -c \
    'Print :com.apple.security.network.client' "$ENTITLEMENTS_FILE")"
  files="$(/usr/libexec/PlistBuddy -c \
    'Print :com.apple.security.files.user-selected.read-write' "$ENTITLEMENTS_FILE")"
  encryption="$(/usr/libexec/PlistBuddy -c \
    'Print :ITSAppUsesNonExemptEncryption' "$INFO_PLIST_FILE")"

  [[ "$configured_bundle" == "$APP_BUNDLE_ID" ]] ||
    fail "Tauri identifier is $configured_bundle; expected $APP_BUNDLE_ID"
  [[ "$configured_team" == "$APPLE_TEAM_ID" ]] ||
    fail "Entitlements Team ID is $configured_team; expected $APPLE_TEAM_ID"
  [[ "$configured_app_id" == "$APPLE_TEAM_ID.$APP_BUNDLE_ID" ]] ||
    fail "Entitlements application identifier is $configured_app_id"
  [[ "$sandbox" == "true" && "$network" == "true" && "$files" == "true" ]] ||
    fail "App Store sandbox, network client, and user-selected read/write entitlements must be enabled"
  [[ "$encryption" == "false" ]] ||
    fail "Review ITSAppUsesNonExemptEncryption in $INFO_PLIST_FILE"
  validate_icns_has_1024 "$SOURCE_ICNS_FILE" "Source"
}

bundle_root() {
  if [[ "$BUILD_TARGET" == "host" ]]; then
    printf '%s/target/release/bundle' "$REPOSITORY_ROOT"
  else
    printf '%s/target/%s/release/bundle' "$REPOSITORY_ROOT" "$BUILD_TARGET"
  fi
}

prepare_api_key() {
  require_value APPLE_API_ISSUER
  require_value APPLE_API_KEY_PATH
  [[ -f "$APPLE_API_KEY_PATH" ]] ||
    fail "App Store Connect private key not found: $APPLE_API_KEY_PATH"

  if [[ -z "${APPLE_API_KEY_ID:-}" ]]; then
    APPLE_API_KEY_ID="${APPLE_API_KEY:-}"
  fi
  if [[ -z "${APPLE_API_KEY_ID:-}" ]]; then
    local filename
    filename="$(basename "$APPLE_API_KEY_PATH")"
    if [[ "$filename" == AuthKey_*.p8 ]]; then
      APPLE_API_KEY_ID="${filename#AuthKey_}"
      APPLE_API_KEY_ID="${APPLE_API_KEY_ID%.p8}"
    else
      fail "Set APPLE_API_KEY_ID or name the private key AuthKey_KEYID.p8"
    fi
  fi

  mkdir -p "$REPOSITORY_ROOT/private_keys"
  STAGED_API_KEY="$REPOSITORY_ROOT/private_keys/AuthKey_${APPLE_API_KEY_ID}.p8"
  if [[ "$APPLE_API_KEY_PATH" != "$STAGED_API_KEY" ]]; then
    cp "$APPLE_API_KEY_PATH" "$STAGED_API_KEY"
    chmod 600 "$STAGED_API_KEY"
  else
    STAGED_API_KEY=""
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
    --upload)
      UPLOAD=true
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
OUTPUT_DIRECTORY="${OUTPUT_DIRECTORY:-dist/app-store}"
REQUIRE_CLEAN_GIT="${REQUIRE_CLEAN_GIT:-true}"
INSTALL_DEPENDENCIES="${INSTALL_DEPENDENCIES:-false}"
APP_DISTRIBUTION_IDENTITY="${APP_DISTRIBUTION_IDENTITY:-auto}"
INSTALLER_DISTRIBUTION_IDENTITY="${INSTALLER_DISTRIBUTION_IDENTITY:-auto}"

require_value APP_BUNDLE_ID
require_value APPLE_TEAM_ID
require_value PROVISIONING_PROFILE
require_value APP_BUILD_NUMBER
[[ "$APP_BUILD_NUMBER" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] ||
  fail "APP_BUILD_NUMBER must contain one to three dot-separated integers"
validate_boolean REQUIRE_CLEAN_GIT
validate_boolean INSTALL_DEPENDENCIES

for command in cargo codesign date git iconutil node openssl pkgutil plutil pnpm rustup security sips uuidgen xcrun; do
  require_command "$command"
done
xcrun --find productbuild >/dev/null || fail "productbuild is not installed"

if [[ "$CHECK_ONLY" != "true" && "$REQUIRE_CLEAN_GIT" == "true" && \
      -n "$(git status --porcelain)" ]]; then
  fail "Git working tree is not clean. Commit or stash changes, or set REQUIRE_CLEAN_GIT=false."
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" != "24" ]]; then
  echo "warning: Node.js 24 is recommended; current version is $(node --version)" >&2
fi

validate_project_configuration
validate_profile
setup_temporary_keychain

resolve_identity application "$APP_DISTRIBUTION_IDENTITY"
APP_DISTRIBUTION_IDENTITY="$RESOLVED_IDENTITY"
APP_DISTRIBUTION_IDENTITY_HASH="$RESOLVED_IDENTITY_HASH"
identity_is_in_profile "$APP_DISTRIBUTION_IDENTITY_HASH" ||
  fail "Application signing certificate is not included in the provisioning profile"

resolve_identity installer "$INSTALLER_DISTRIBUTION_IDENTITY"
INSTALLER_DISTRIBUTION_IDENTITY="$RESOLVED_IDENTITY"

info "Application identity: $APP_DISTRIBUTION_IDENTITY"
info "Installer identity:   $INSTALLER_DISTRIBUTION_IDENTITY"
info "Mac App Store signing configuration is valid"

if [[ "$UPLOAD" == "true" ]]; then
  prepare_api_key
fi
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

mkdir -p "$STAGING_DIRECTORY"
cp "$PROVISIONING_PROFILE" "$STAGED_PROFILE"
# The embedded profile is part of the installed app bundle. Mac App Store
# validation requires every payload file to be readable by non-root users.
chmod 644 "$STAGED_PROFILE"

RUNTIME_CONFIG="{\"bundle\":{\"macOS\":{\"bundleVersion\":\"$APP_BUILD_NUMBER\"}}}"
BUILD_ARGS=(--bundles app --config "$APPSTORE_CONFIG" --config "$RUNTIME_CONFIG")
if [[ "$BUILD_TARGET" != "host" ]]; then
  BUILD_ARGS+=(--target "$BUILD_TARGET")
fi

info "Building and signing the sandboxed Mac App Store app"
APPLE_SIGNING_IDENTITY="$APP_DISTRIBUTION_IDENTITY" \
  pnpm --filter @nodalstudio/desktop tauri build "${BUILD_ARGS[@]}"

BUNDLE_ROOT="$(bundle_root)"
APP_PATH="$BUNDLE_ROOT/macos/Nodal Studio.app"
[[ -d "$APP_PATH" ]] || fail "App bundle was not generated: $APP_PATH"
[[ -f "$APP_PATH/Contents/embedded.provisionprofile" ]] ||
  fail "Provisioning profile was not embedded in the app"

info "Verifying app signature, identifier, Sandbox, build number, and payload permissions"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_PATH/Contents/Info.plist")" == \
      "$APP_BUNDLE_ID" ]] || fail "Built app has the wrong bundle identifier"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_PATH/Contents/Info.plist")" == \
      "$APP_BUILD_NUMBER" ]] || fail "Built app has the wrong CFBundleVersion"
codesign -d --entitlements - "$APP_PATH" 2>&1 |
  grep -F 'com.apple.security.app-sandbox' >/dev/null ||
  fail "Built app signature does not contain the App Sandbox entitlement"

UNREADABLE_FILE="$(find "$APP_PATH" -type f ! -perm -004 -print -quit)"
[[ -z "$UNREADABLE_FILE" ]] ||
  fail "App bundle contains a file that non-root users cannot read: $UNREADABLE_FILE"
UNSEARCHABLE_DIRECTORY="$(find "$APP_PATH" -type d ! -perm -001 -print -quit)"
[[ -z "$UNSEARCHABLE_DIRECTORY" ]] ||
  fail "App bundle contains a directory that non-root users cannot traverse: $UNSEARCHABLE_DIRECTORY"

APP_ICON_NAME="$(/usr/libexec/PlistBuddy -c \
  'Print :CFBundleIconFile' "$APP_PATH/Contents/Info.plist")"
[[ "$APP_ICON_NAME" == *.icns ]] || APP_ICON_NAME="$APP_ICON_NAME.icns"
validate_icns_has_1024 "$APP_PATH/Contents/Resources/$APP_ICON_NAME" "Bundled"

APP_VERSION="$(/usr/libexec/PlistBuddy -c \
  'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")"
if [[ "$OUTPUT_DIRECTORY" != /* ]]; then
  OUTPUT_DIRECTORY="$REPOSITORY_ROOT/$OUTPUT_DIRECTORY"
fi
mkdir -p "$OUTPUT_DIRECTORY"
PKG_PATH="$OUTPUT_DIRECTORY/Nodal-Studio-${APP_VERSION}-${APP_BUILD_NUMBER}.pkg"
rm -f "$PKG_PATH"

info "Creating the signed Mac App Store installer package"
xcrun productbuild \
  --sign "$INSTALLER_DISTRIBUTION_IDENTITY" \
  --timestamp \
  --component "$APP_PATH" /Applications \
  "$PKG_PATH"

info "Verifying installer package signature"
PKG_SIGNATURE="$(pkgutil --check-signature "$PKG_PATH")"
printf '%s\n' "$PKG_SIGNATURE"
printf '%s\n' "$PKG_SIGNATURE" | grep -F "$INSTALLER_DISTRIBUTION_IDENTITY" >/dev/null ||
  fail "Installer package is not signed with the configured identity"

if [[ "$UPLOAD" == "true" ]]; then
  info "Uploading package to App Store Connect"
  xcrun altool \
    --upload-app \
    --type macos \
    --file "$PKG_PATH" \
    --apiKey "$APPLE_API_KEY_ID" \
    --apiIssuer "$APPLE_API_ISSUER"
fi

info "Mac App Store package completed"
echo "App: $APP_PATH"
echo "PKG: $PKG_PATH"
if [[ "$UPLOAD" != "true" ]]; then
  echo "Next: drag the PKG into Transporter and click Deliver."
fi
