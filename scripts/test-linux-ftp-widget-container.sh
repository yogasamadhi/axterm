#!/bin/sh
set -eu

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is required for the optional Linux FTP Widget source smoke.' >&2
  exit 2
fi

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
source_root=$(CDPATH='' cd -- "$script_directory/.." && pwd)
image="${AXTERM_LINUX_FTP_TEST_IMAGE:-node:24.18.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd}"
platform="${AXTERM_LINUX_FTP_TEST_PLATFORM:-}"

case "$platform" in
  '')
    expected_arch=''
    ;;
  linux/arm64)
    expected_arch='arm64'
    ;;
  linux/amd64)
    expected_arch='x64'
    ;;
  *)
    echo "Unsupported Linux FTP Widget test platform: $platform" >&2
    echo 'Use linux/arm64 or linux/amd64.' >&2
    exit 2
    ;;
esac

if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "Required local Docker image is unavailable: $image" >&2
  echo 'Pull or provide it explicitly before running this optional source smoke.' >&2
  exit 2
fi

set --
if [ -n "$platform" ]; then
  set -- "$@" --platform "$platform"
fi

docker run "$@" --rm \
  --read-only \
  --network none \
  --pids-limit 128 \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --mount "type=bind,src=$source_root,dst=/workspace,readonly" \
  --workdir /workspace \
  --env "AXTERM_LINUX_FTP_EXPECT_ARCH=$expected_arch" \
  --entrypoint node \
  "$image" \
  --experimental-transform-types \
  --disable-warning=ExperimentalWarning \
  --import ./scripts/register-ts-resolver.mjs \
  scripts/test-linux-ftp-widget-container.mjs
