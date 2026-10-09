#!/bin/sh
set -eu

if [ "$(uname -s)" != "Linux" ]; then
  echo "The DEB installation gate requires Linux." >&2
  exit 2
fi

if [ "$(dpkg --print-architecture)" != "amd64" ]; then
  echo "The release DEB installation gate requires Linux x64 (amd64)." >&2
  exit 2
fi

for required_command in curl xvfb-run python3; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "The DEB installation gate requires $required_command on the test host." >&2
    exit 2
  fi
done
if ! /usr/bin/python3 -c 'import gi; gi.require_version("Gtk", "3.0"); from gi.repository import Gtk' >/dev/null 2>&1; then
  echo 'The DEB installation gate requires Python GI with GTK 3 for the launcher icon check.' >&2
  exit 2
fi

deb_path="${1:-${AXTERM_DEB_PATH:-}}"
if [ -z "$deb_path" ]; then
  set -- release/axterm_*_amd64.deb
  if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    echo "Expected exactly one release/axterm_*_amd64.deb artifact." >&2
    exit 2
  fi
  deb_path="$1"
fi

if [ ! -f "$deb_path" ]; then
  echo "DEB artifact does not exist: $deb_path" >&2
  exit 2
fi
deb_path="$(readlink -f "$deb_path")"
sidecar_path="${AXTERM_PACKAGED_SIDECAR:-$(dirname "$deb_path")/AXTERM_PACKAGED_ARTIFACTS.linux-x64.spdx.json}"
if [ ! -f "$sidecar_path" ]; then
  echo "Packaged SPDX sidecar does not exist: $sidecar_path" >&2
  exit 2
fi

if dpkg-query -W -f='${db:Status-Status}' axterm 2>/dev/null | grep -q '^installed$'; then
  echo "Refusing to replace a pre-existing installed axterm package." >&2
  exit 2
fi

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    command -v sudo >/dev/null 2>&1 || {
      echo "sudo is required to install the DEB on this runner." >&2
      exit 2
    }
    sudo "$@"
  fi
}

cleanup() {
  if dpkg-query -W -f='${db:Status-Status}' axterm 2>/dev/null | grep -q '^installed$'; then
    run_privileged env DEBIAN_FRONTEND=noninteractive apt-get remove -y axterm >/dev/null
  fi
}
trap cleanup EXIT INT TERM

run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$deb_path"

installed_root=/opt/Axterm
installed_executable="$installed_root/axterm"
if [ ! -x "$installed_executable" ]; then
  echo "Installed Axterm executable is missing: $installed_executable" >&2
  exit 1
fi

package_version="$(dpkg-query -W -f='${Version}' axterm)"
binary_version="$($installed_executable --no-sandbox --version | tr -d '\r')"
printf '%s\n' "$binary_version" | grep -F "$package_version" >/dev/null || {
  echo "Installed binary version '$binary_version' does not match DEB version '$package_version'." >&2
  exit 1
}

desktop_files="$(dpkg-query -L axterm | awk '/^\/usr\/share\/applications\/.*\.desktop$/ { print }')"
if [ -z "$desktop_files" ]; then
  echo "Installed Axterm desktop entry is missing." >&2
  exit 1
fi
for scheme in axterm; do
  registered=0
  while IFS= read -r desktop_file; do
    if [ -f "$desktop_file" ] && awk -F= -v expected="x-scheme-handler/$scheme" '
      /^MimeType=/ {
        count = split(substr($0, 10), types, ";")
        for (position = 1; position <= count; position++) {
          if (types[position] == expected) found = 1
        }
      }
      END { exit !found }
    ' "$desktop_file"; then
      registered=1
      break
    fi
  done <<EOF
$desktop_files
EOF
  if [ "$registered" -ne 1 ]; then
    echo "Installed Axterm desktop entry does not register $scheme:// links." >&2
    exit 1
  fi
done

bun run sbom:packaged:check -- "$installed_root/resources" --platform linux-x64 --sidecar "$sidecar_path"
bun run release:updater-feed:package-check -- "$installed_root/resources"
AXTERM_DEB_PATH="$deb_path" AXTERM_PACKAGED_APP="$installed_root" \
  xvfb-run -a -s '-screen 0 1920x1080x24' bun run test:packaged
