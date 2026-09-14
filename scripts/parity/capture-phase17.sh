#!/bin/sh
set -eu

if [ "${AXTERM_PARITY_SKIP_BUILD:-0}" != "1" ]; then
  bun run build
fi

scenarios="${AXTERM_PARITY_PHASE17_SCENARIOS:-protocol.ftp protocol.telnet protocol.serial protocol.rdp protocol.vnc protocol.spice protocol.web-deeplink terminal.transfer-protocols}"
targets="${AXTERM_PARITY_TARGETS:-axterm electerm}"
for scenario in $scenarios; do
  for target in $targets; do
    node scripts/parity/capture.mjs --target="$target" --scenario="$scenario"
  done
done

