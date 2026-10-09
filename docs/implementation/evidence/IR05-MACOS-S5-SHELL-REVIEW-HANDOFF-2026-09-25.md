# IR-05 / W-05-02 / S5: Mac Shell error recovery and product-review handoff

Date: 2026-09-25. Scope: the **Mac engineering S5 cell**, not qualified
translation, product/brand approval, signed distribution, Windows/Linux, or
the full IR-05 gate. The source journey and an unsigned macOS arm64 directory
app use a clean profile, the real local Host/Runtime, all four supported
languages, and a 1440×900 physical window at 200% zoom.

## What was checked

- Shell catch paths no longer render arbitrary `Error.message`. The Shell
  displays a local, translated fallback for unexpected errors; only explicitly
  constructed `LocalShellError` messages may pass through. This is a scoped
  boundary, not a claim that every Renderer component has been audited.
- A controlled HTTP 500 on bookmark-group creation shows a localized alert,
  retains the dialog and entered name, and succeeds on retry. A controlled
  HTTP 500 on workspace save likewise retains the name and succeeds on retry;
  the menu clears the name only after a successful save.
- The test puts the same canary in the server problem title and detail and
  asserts neither is displayed. At 200% the alert has `role="alert"`, stays
  within the viewport and does not create horizontal page overflow. The real
  sidebar shortcut is used to reach the group toolbar at this zoom.
- This is a mutation/recovery sample for the four languages. It does not
  assert all possible server failures, every conditional page, or an external
  product-review decision.

Source and package results:

```sh
bun run typecheck
bun run build
bunx playwright test --project=visual -g 'P-07 S5'
# 1/1 passed; four languages in source Electron

node scripts/package-desktop.mjs --dir --output /tmp/axterm-s5-final.Q0rUE4
AXTERM_PACKAGED_APP=/tmp/axterm-s5-final.Q0rUE4/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  -g 'packaged macOS (Shell and Settings|S1|S2|S3|S4|S5|keeps all four languages)'
# 7/7 passed
AXTERM_PACKAGED_APP=/tmp/axterm-s5-final.Q0rUE4/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  -g 'packaged P-04/P-07 localizes SSH Host Key review|packaged H-11 localization switches immediately and survives a cold restart'
# 2/2 passed
```

All nine packaged tests above ran on the **same** unsigned `Axterm.app` with
`app.asar` SHA-256
`08b3edb130dbf616801adfa676a4c97353fbd3507440f4422b6cd8f05b724651`.
Together they recheck the S0 Host Key/language-switch baseline and S1–S5
journeys on one artifact. Earlier S1–S4 evidence remains valid for its own
documented scope; the common-artifact run does not convert synthetic HTTP
failure or no-provider states into live provider/remote-service proof.

## Product-review handoff — pending, not signed

The product reviewer should inspect the four-language Shell, navigation,
Settings, Host Key dialog, editors, terminal/file/transfer, themes, Widgets,
and AI no-provider states against the S0–S5 evidence. Record the reviewer's
name, date, chosen screenshots/issues, and accept/rework decision in this
record or a linked ticket. No reviewer has signed this handoff yet. Any
identified issue returns to W-05-02; the Mac engineering S5 cell itself is
accepted and should not expand into an unbounded page-by-page test sweep.

W-05-02 therefore remains **open**. W-05-01 still needs qualified language
and rights review, W-05-03 needs Windows/Linux native evidence, and IR-05
remains **In progress**. This evidence closes **0 W items** and changes **0 IR
states**.
