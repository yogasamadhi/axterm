#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "The DMG acceptance journey requires macOS." >&2
  exit 2
fi

dmg_path="${1:-${AXTERM_DMG_PATH:-}}"
if [ -z "$dmg_path" ]; then
  set -- release/Axterm-*.dmg
  if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    echo "Expected exactly one release/Axterm-*.dmg artifact." >&2
    exit 2
  fi
  dmg_path="$1"
fi

if [ ! -f "$dmg_path" ]; then
  echo "DMG artifact does not exist: $dmg_path" >&2
  exit 2
fi
dmg_directory="$(cd "$(dirname "$dmg_path")" && pwd -P)"
sidecar_path="${AXTERM_PACKAGED_SIDECAR:-$dmg_directory/AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json}"
if [ ! -f "$sidecar_path" ]; then
  echo "Packaged SPDX sidecar does not exist: $sidecar_path" >&2
  exit 2
fi

temporary_root="${TMPDIR:-/tmp}"
mount_directory="$(mktemp -d "${temporary_root%/}/axterm-dmg-mount.XXXXXX")"
install_directory="$(mktemp -d "${temporary_root%/}/axterm-dmg-install.XXXXXX")"
mounted=0

cleanup() {
  if [ "$mounted" -eq 1 ]; then
    hdiutil detach "$mount_directory" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$mount_directory" "$install_directory"
}
trap cleanup EXIT INT TERM

hdiutil verify "$dmg_path"
diskutil image attach --nobrowse --readOnly --mountPoint "$mount_directory" "$dmg_path"
mounted=1

source_app="$mount_directory/Axterm.app"
installed_app="$install_directory/Axterm.app"
if [ ! -d "$source_app" ]; then
  echo "Axterm.app is missing from the mounted DMG." >&2
  exit 1
fi

ditto "$source_app" "$installed_app"

plist_path="$installed_app/Contents/Info.plist"
if [ ! -f "$plist_path" ]; then
  echo "Installed Axterm Info.plist is missing." >&2
  exit 1
fi
if ! url_types_json="$(plutil -extract CFBundleURLTypes json -o - "$plist_path")"; then
  echo "Installed Axterm Info.plist does not declare URL protocol types." >&2
  exit 1
fi
if ! printf '%s\n' "$url_types_json" | bun -e '
const urlTypes = JSON.parse(await Bun.stdin.text());
const schemes = new Set(urlTypes.flatMap((entry) => entry.CFBundleURLSchemes ?? []));
const missing = ["axterm"].filter((scheme) => !schemes.has(scheme));
const retiredName = ["elect", "erm"].join("");
if (missing.length > 0 || schemes.has(retiredName)) {
  console.error(`Expected only Axterm URL scheme; missing: ${missing.join(", ")}`);
  process.exit(1);
}
'; then
  echo "Installed Axterm bundle must declare axterm:// without retired URL schemes." >&2
  exit 1
fi

hdiutil detach "$mount_directory" -quiet
mounted=0
rmdir "$mount_directory"

if mount | grep -F "$mount_directory" >/dev/null 2>&1; then
  echo "DMG remained mounted before the installed-app journey." >&2
  exit 1
fi

bun run sbom:packaged:check -- "$installed_app/Contents/Resources" --platform macos-arm64 --sidecar "$sidecar_path"
bun run release:updater-feed:package-check -- "$installed_app/Contents/Resources"
node scripts/commercialization/audit-retired-name.mjs --check "$installed_app"
AXTERM_PACKAGED_APP="$installed_app" bun run test:packaged
