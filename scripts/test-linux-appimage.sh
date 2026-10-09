#!/bin/sh
set -eu

if [ "$(uname -s)" != 'Linux' ] || [ "$(uname -m)" != 'x86_64' ]; then
  echo 'The AppImage runtime gate requires Linux x64.' >&2
  exit 2
fi

for required_command in bunx xvfb-run realpath; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "The AppImage runtime gate requires $required_command on the test host." >&2
    exit 2
  fi
done

artifact_dir=release
if [ "$#" -ne 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != '--artifact-dir' ] || [ -z "$2" ]; then
    echo 'Usage: sh scripts/test-linux-appimage.sh [--artifact-dir DIRECTORY]' >&2
    exit 2
  fi
  artifact_dir=$2
fi

set -- "$artifact_dir"/*.AppImage
if [ "$#" -ne 1 ] || [ ! -f "$1" ] || [ -L "$1" ]; then
  echo "Expected exactly one regular AppImage in $artifact_dir." >&2
  exit 2
fi
artifact_path=$(realpath "$1")

AXTERM_APPIMAGE_PATH="$artifact_path" \
AXTERM_APPIMAGE_RUNTIME_RECEIPT="$artifact_dir/AXTERM_APPIMAGE_RUNTIME.linux-x64.json" \
APPIMAGE_EXTRACT_AND_RUN=1 \
  xvfb-run -a -s '-screen 0 1920x1080x24' \
  bunx playwright test --project=packaged \
  -g 'packaged Linux AppImage runtime launches outside the source checkout'
