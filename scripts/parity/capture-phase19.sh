#!/bin/sh
set -eu

if [ "${AXTERM_PARITY_SKIP_BUILD:-0}" != "1" ]; then
  bun run build
fi

scenarios="${AXTERM_PARITY_PHASE19_SCENARIOS:-settings.navigation-map settings.themes settings.shortcuts-window settings.data-sync-i18n-update settings.localization-ltr settings.localization-rtl}"
targets="${AXTERM_PARITY_TARGETS:-axterm electerm}"
for scenario in $scenarios; do
  for target in $targets; do
    node scripts/parity/capture.mjs --target="$target" --scenario="$scenario"
  done
done
