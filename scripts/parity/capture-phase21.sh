#!/bin/sh
set -eu

if [ "${AXTERM_PARITY_SKIP_BUILD:-0}" != "1" ]; then
  bun run build
fi

scenarios="${AXTERM_PARITY_PHASE21_SCENARIOS:-certification.resilience certification.platform-upgrade certification.visual-accessibility}"
targets="${AXTERM_PARITY_TARGETS:-axterm electerm}"
for scenario in $scenarios; do
  for target in $targets; do
    node scripts/parity/capture.mjs --target="$target" --scenario="$scenario"
  done
done
