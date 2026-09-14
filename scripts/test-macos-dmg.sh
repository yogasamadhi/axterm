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
hdiutil attach -nobrowse -readonly -mountpoint "$mount_directory" "$dmg_path"
mounted=1

source_app="$mount_directory/Axterm.app"
installed_app="$install_directory/Axterm.app"
if [ ! -d "$source_app" ]; then
  echo "Axterm.app is missing from the mounted DMG." >&2
  exit 1
fi

ditto "$source_app" "$installed_app"
hdiutil detach "$mount_directory" -quiet
mounted=0
rmdir "$mount_directory"

if mount | grep -F "$mount_directory" >/dev/null 2>&1; then
  echo "DMG remained mounted before the installed-app journey." >&2
  exit 1
fi

AXTERM_PACKAGED_APP="$installed_app" bun run test:packaged
