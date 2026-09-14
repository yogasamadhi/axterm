#!/bin/sh
set -eu

if [ "${AXTERM_PARITY_SKIP_BUILD:-0}" != "1" ]; then
  bun run build
fi

scenarios="${AXTERM_PARITY_PHASE18_SCENARIOS:-automation.commands-batch automation.triggers-scripts monitor.info-remote widgets.lifecycle}"
targets="${AXTERM_PARITY_TARGETS:-axterm electerm}"
for scenario in $scenarios; do
  for target in $targets; do
    node scripts/parity/capture.mjs --target="$target" --scenario="$scenario"
  done
done
