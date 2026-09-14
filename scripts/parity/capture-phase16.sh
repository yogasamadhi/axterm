#!/bin/sh
set -eu

fixture_name="axterm-parity-phase16-$$"
cleanup() {
  docker rm -f "$fixture_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker build -q -t axterm-openssh-fixture tests/fixtures/openssh >/dev/null
docker run -d --name "$fixture_name" -p 127.0.0.1::2222 \
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

if [ "${AXTERM_PARITY_SKIP_BUILD:-0}" != "1" ]; then
  bun run build
fi

scenarios="${AXTERM_PARITY_PHASE16_SCENARIOS:-files.browse-operate files.transfers files.edit-inspect}"
targets="${AXTERM_PARITY_TARGETS:-axterm electerm}"
for scenario in $scenarios; do
  for target in $targets; do
    AXTERM_SSH_FIXTURE_PORT="$fixture_port" \
      node scripts/parity/capture.mjs --target="$target" --scenario="$scenario"
  done
done
