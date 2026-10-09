#!/bin/sh
set -eu

duration_ms="${AXTERM_SOAK_DURATION_MS:-60000}"
case "$duration_ms" in
  *[!0-9]*|'')
    echo "AXTERM_SOAK_DURATION_MS must be an integer" >&2
    exit 2
    ;;
esac

fixture_name="axterm-phase21-soak-$$"
cleanup() {
  docker rm -f "$fixture_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker build -q -t axterm-openssh-fixture tests/fixtures/openssh >/dev/null
docker run --rm -d --name "$fixture_name" --label dev.axterm.fixture=phase21-soak \
  -p 127.0.0.1::2222 \
  -e PUID=1000 -e PGID=1000 -e TZ=Etc/UTC \
  -e USER_NAME=fixture -e USER_PASSWORD=axterm-fixture-password \
  -e PASSWORD_ACCESS=true -e SUDO_ACCESS=false \
  axterm-openssh-fixture >/dev/null

fixture_port="$(docker port "$fixture_name" 2222/tcp | sed 's/.*://')"
attempt=0
until nc -z 127.0.0.1 "$fixture_port"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker logs "$fixture_name"
    exit 1
  fi
  sleep 1
done

AXTERM_SSH_FIXTURE_PORT="$fixture_port" \
AXTERM_SOAK_DURATION_MS="$duration_ms" \
node --expose-gc node_modules/vitest/vitest.mjs run --config tests/soak/vitest.config.ts
