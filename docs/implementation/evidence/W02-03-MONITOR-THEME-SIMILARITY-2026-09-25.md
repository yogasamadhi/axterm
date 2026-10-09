# W-02-03: monitor-model replacement and bounded theme comparison

Date: 2026-09-25  
Status: engineering change verified locally; **source/design rights remain pending**  
Scope: `apps/desktop/src/renderer/src/app/remote-monitor/remote-monitor-model.ts`,
`remote-monitor-bar.tsx`, `packages/shared/src/terminal-theme-presets.ts`

This follows the two non-RDP candidates in the
[bounded source-lineage screen](W02-03-RDP-KEYBOARD-LINEAGE-2026-09-25.md).
It is not a legal opinion, clean-room assertion, or acceptance of W-02-01,
W-02-03, IR-02, IR-06 or IR-10. The engineering author inspected the fixed
Legacy Prototype reference while triaging these files; a qualified reviewer still
needs to decide whether the resulting work can be retained and how it must
be attributed.

## Fixed comparison and finding

The reference is Legacy Prototype commit `799bedef98c1deae676ae03041719de98d3b57f1`.
Its `src/client/components/remote-monitor/monitor-model.js` has SHA-256
`d11450c3220f048b68a0eda5be69a99ba500d96862b385c47de1563eababf22a`.
The former Axterm model used the same `80/90` enter and `75/85` recovery
threshold branches as that reference, the same binary-unit scaling and
precision choices, and the same `['/', '/home', '/var', '/data']` disk priority.
These are concrete semantic similarities, not merely common property names;
their rights significance remains for review. Other helpers, including the
network-interface choice, were not shown to be identical.

For the theme candidate, current `terminal-theme-presets.ts` SHA-256 is
`529c39b483b6e9940cab0f3019970e347a906bcc1ffced2641f7fdde5115b382`.
The fixed reference files are `src/client/common/theme-defaults.js` SHA-256
`b28200fb1349d007ff43abd772415ab527d92fd6eb587a4a10ca0a40a774616b`
and `src/app/upgrade/db-defaults.js` SHA-256
`c94a69750fa9f01d801c925adb91eb002ce17f2d9697117d02b18437400e6264`.
A case-folded scan of literal CSS-color `key=value` / `key: value` pairs found
**102** distinct pairs in the current source, **61** and **44** in the two
reference files, and **zero exact key/value pairs** shared with either
reference. The earlier token-shingle score was therefore substantially
affected by shared terminal/UI field names. This bounded comparison does not
cover every historical Legacy Prototype theme, runtime-generated values, palette
authorship, or design/trademark similarity; theme review stays pending.

## Axterm monitor behavior now specified by product needs

The replacement uses separately chosen operational headroom: CPU enters
warning/critical at **85/95%**, memory at **80/92%**, and disk at **75/90%**.
Each level has a five-percentage-point recovery band; out-of-range percentages
are unknown. The UI now retains the previous level per Terminal Information
sample and per disk identity, and resets when the monitor is inactive or the
terminal changes. Previously the model accepted `previous` but the bar always
called it without previous state, so the promised hysteresis was not actually
applied. Disk summaries now put the fullest mount first, making capacity
pressure visible before fixed mount-name preference.

Byte display uses magnitude calculation and `Intl.NumberFormat`, with one
decimal below ten units and whole units thereafter; positive sub-byte rates
show `<1 B` and invalid rates show `—`. Uptime uses two unpadded units.
These visible formatting differences are intentional under ADR-016's allowed
targeted UI/UX changes. The Level 1 Runtime sampling and Query identity are
unchanged.

Focused tests cover pressure entry/recovery, invalid values, same-terminal
sample transitions, terminal change and inactive reset, capacity ordering,
byte/rate and uptime display. `bunx vitest run
tests/unit/remote-monitor-model.test.ts` passed **4/4**; `bun run
typecheck` and full `bun run check` passed (**1,246** unit/integration tests,
**21/21** visual/accessibility journeys, architecture/Contract/source/build
checks). `bun run test:ssh` also passed its Docker OpenSSH integration case
**1/1** and Electron B-12 authenticated SSH journey **1/1**; B-12 opens the
actual Terminal Information panel and remote monitor bar. This is current
source/desktop evidence, not a new signed installed-package result or a
qualified design/source review.

Next review action: decide the present model's retained source/design rights,
and separately verify theme origin, palette authorship and packaging. Keep
the exact changed file bytes pending in the source-file ledger until a named
reviewer provides evidence and a dated conclusion.
