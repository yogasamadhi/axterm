#!/bin/sh
set -eu

network_name="axterm-ssh-fixture-net-$$"
fixture_name="axterm-ssh-fixture-jump1-$$"
hop2_name="axterm-ssh-fixture-jump2-$$"
target_name="axterm-ssh-fixture-target-$$"
cleanup() {
  docker rm -f "$fixture_name" "$hop2_name" "$target_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker build -q -t axterm-openssh-fixture tests/fixtures/openssh >/dev/null
docker network create "$network_name" >/dev/null
docker run --rm -d --name "$fixture_name" --label dev.axterm.fixture=ssh-jump1 \
  --network "$network_name" -p 127.0.0.1::2222 \
  -e PUID=1000 -e PGID=1000 -e TZ=Etc/UTC \
  -e USER_NAME=fixture -e USER_PASSWORD=axterm-fixture-password \
  -e PASSWORD_ACCESS=true -e SUDO_ACCESS=false \
  axterm-openssh-fixture >/dev/null
docker run --rm -d --name "$hop2_name" --label dev.axterm.fixture=ssh-jump2 \
  --network "$network_name" \
  -e PUID=1000 -e PGID=1000 -e TZ=Etc/UTC \
  -e USER_NAME=fixture -e USER_PASSWORD=axterm-fixture-password \
  -e PASSWORD_ACCESS=true -e SUDO_ACCESS=false \
  axterm-openssh-fixture >/dev/null
docker run --rm -d --name "$target_name" --label dev.axterm.fixture=ssh-target \
  --network "$network_name" \
  -e PUID=1000 -e PGID=1000 -e TZ=Etc/UTC \
  -e USER_NAME=fixture -e USER_PASSWORD=axterm-fixture-password \
  -e PASSWORD_ACCESS=true -e SUDO_ACCESS=false \
  axterm-openssh-fixture >/dev/null

fixture_port="$(docker port "$fixture_name" 2222/tcp | sed 's/.*://')"
attempt=0
until nc -z 127.0.0.1 "$fixture_port" && \
  docker exec "$fixture_name" nc -z "$hop2_name" 2222 && \
  docker exec "$hop2_name" nc -z "$target_name" 2222; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker logs "$fixture_name"
    exit 1
  fi
  sleep 1
done

AXTERM_SSH_FIXTURE_PORT="$fixture_port" \
AXTERM_SSH_HOP2_HOST="$hop2_name" \
AXTERM_SSH_TARGET_HOST="$target_name" \
bunx vitest run tests/integration/ssh-fixture.test.ts
bun run --cwd apps/desktop build
AXTERM_SSH_FIXTURE_PORT="$fixture_port" bunx playwright test --project=desktop \
  --grep "B-12 authenticated save-and-connect"
if [ "${AXTERM_PACKAGED_SSH:-0}" = "1" ]; then
  AXTERM_SSH_FIXTURE_PORT="$fixture_port" bunx playwright test --project=packaged --grep "packaged SSH"
fi
