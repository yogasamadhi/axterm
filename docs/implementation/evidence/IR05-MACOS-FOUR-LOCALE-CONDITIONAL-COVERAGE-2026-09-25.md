# IR-05 macOS four-locale conditional-state coverage — 2026-09-25

Scope: **W-05-02 engineering progress, not W-05-02 or IR-05 acceptance**.
This record freezes the current visible-state coverage rather than treating a
catalog key or one representative screenshot as proof that every error/dialog
is localized. The four release locales are `en`, `ja`, `zh-CN` and `zh-TW`.

## Language-save error state

`LanguageSettingsPanel` previously rendered the raw Runtime/client exception
when a language update failed. That string could be technical or English-only,
and could expose the server's problem detail in the visible status. The panel
now renders a locale-specific `language.saveFailed` message, refetches the
saved Settings value and leaves the previous language active. The new message
is an unreviewed draft like the rest of the core catalog; qualified human
language and rights review remains W-05-01.

The source-Electron regression intercepts the Settings `PATCH` with a controlled
HTTP 500 containing a canary detail. For each of the four current languages it
checks the translated failure, no canary in the UI, the original select value
and document language, then allows a successful retry. The packaged H-11
journey repeats the four failed-save states in a copied current-source macOS
app, in addition to its existing navigation, representative surfaces and cold
restart checks.

```sh
bun run locales:core:generate
# 2,587 keys in each locale; review remains pending

bun run build
bunx playwright test --project=visual \
  -g 'failed language changes localized'
# 1/1 passed; four failure/retry pairs

node scripts/package-desktop.mjs --dir \
  --output /tmp/axterm-w05-language-error.xeGCY2
AXTERM_PACKAGED_APP=/tmp/axterm-w05-language-error.xeGCY2/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  -g 'packaged H-11 localization switches immediately and survives a cold restart'
# 1/1 passed; includes four failed-save states

AXTERM_PACKAGED_APP=/tmp/axterm-w05-language-error.xeGCY2/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  -g 'packaged P-04/P-07 localizes SSH Host Key review'
# 1/1 passed on the same current app archive: unknown and changed key in all 4 locales

bunx vitest run packages/runtime/src/adapters/sqlite/language-catalog-migration.test.ts
# 15/15 passed: all former locale IDs and the 4 retained IDs keep a recoverable backup
```

| Item                                   | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| Language-error unsigned app `app.asar` | `4925f5f0815448a8cf331a4b57b3183ac8280b4e48c3c7ddcfc8113b7aee435b` |
| `language-settings-panel.tsx`          | `09f170637e1dd474ed0bd26e0c07ca9a96c705cccd305739739c0c2f88515b0b` |
| `i18n/core.ts`                         | `b34a2fcfc148e83c1bd18b47fbfd891b3ca21901d3589629afac46e4d95c2292` |
| Updated packaged journey source        | `8c3cfcf79f3c7ffce706e41aa8a0b2ecc4b4e009534d3f25e29947f65da8d366` |

## Changed Host Key at 200% zoom

The first expanded packaged journey used the language-error app archive above.
At a 1440×900 physical window and 200% interface zoom (720×450 CSS viewport),
the English changed-key dialog failed: its content was taller than its client
box while `overflow-y` was `hidden`. The confirmation and rejection controls
could therefore be clipped without a scroll path. The `interaction-modal`
container now scrolls when necessary. The test checks all four languages for
horizontal bounds and for a scrollable vertical overflow after the unconfirmed
replacement warning appears; it then clicks Reject and verifies that the
saved fingerprint remains unchanged.

```sh
AXTERM_PACKAGED_APP=/tmp/axterm-w05-language-error.xeGCY2/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  -g 'packaged P-04/P-07 localizes SSH Host Key review'
# failed: en changed Host Key dialog clips unscrollable vertical content

node scripts/package-desktop.mjs --dir \
  --output /tmp/axterm-w05-hostkey-zoom.JbqoMd
AXTERM_PACKAGED_APP=/tmp/axterm-w05-hostkey-zoom.JbqoMd/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  -g 'packaged P-04/P-07 localizes SSH Host Key review'
# 1/1 passed; all four changed-key states at 200% zoom

AXTERM_PACKAGED_APP=/tmp/axterm-w05-hostkey-zoom.JbqoMd/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  -g 'packaged H-11 localization|packaged macOS keeps all four languages and Settings categories bounded at 200%'
# 2/2 passed on the same new package
```

| Item                                  | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| Host Key zoom unsigned app `app.asar` | `de5951f78d71fb068ad92e0c0b2f51de1e9f44fbb8f3ec012e8c136a97c5d2`   |
| `ssh-bookmark-form.css`               | `90e80e0e1907c926398a480717089d25851dc69014d1a36979ce1c1cc17f3f31` |
| Expanded packaged journey source      | `888159a645854acd6e03ce5d5b810409cf09ebfc94a54edf4c2f3173442fbe64` |

## Behavior and terminal Settings save failures

Two more Settings panels displayed raw Runtime/client exception messages on a
failed `PATCH`: `BehaviorSettingsPanel` and `TerminalRecoverySettingsPanel`
(both terminal settings and monitor settings). They now show their existing
localized failure messages instead. No exception body is placed in visible UI.
The four-language source-Electron journey injects a controlled HTTP 500 with a
canary detail, checks each of the three failed-save paths in `en`, `ja`,
`zh-CN` and `zh-TW`, verifies the setting remains unchanged, and retries each
save successfully. The current unsigned macOS package repeats the behavior
and terminal-recovery failures and retries in all four languages inside H-11;
the monitor branch is covered by the source journey, not the packaged journey.

```sh
bun run build
bunx playwright test --project=visual \
  -g 'failed behavior and terminal settings saves'
# 1/1 passed; four languages × three failed-save and retry paths

node scripts/package-desktop.mjs --dir \
  --output /tmp/axterm-w05-settings-errors.3nR69r
AXTERM_PACKAGED_APP=/tmp/axterm-w05-settings-errors.3nR69r/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  -g 'packaged H-11 localization switches immediately and survives a cold restart'
# 1/1 passed; four languages × behavior and terminal-recovery failure/retry
```

| Item                                   | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| Settings-error unsigned app `app.asar` | `0e1cdbeaaad8b4d8645e35f1fa26bd533929ed63b61440f0a9d1d3ee208dd359` |
| `behavior-settings-panel.tsx`          | `288b73438a607aaf34b0c1f7df70b1fb28d42a4f545118267141e049e39f0892` |
| `terminal-recovery-settings-panel.tsx` | `045700154b71d6e45e0723a8b692293a5af6d3188132af3cf064c64a2f0b2b57` |
| Source-Electron journey                | `d2a8fae3113143a1efd4bf2fc098ed9bca5e4a6a3f187ce1a42afd94ef9bbaa8` |
| Expanded packaged H-11 journey         | `546e96b70d8417e26503595bea891afd89a073cd355db214b7616d99bbf2d7b0` |

## Proxy, tab and window preference failures

`TabPreferencesPanel` previously displayed the raw exception on a failed
Settings `PATCH`. `WindowPreferencesPanel` appended the raw exception to a
translated load/save/reset message. `ProxySettingsPanel` exposed the raw
Settings read error, and its save/test handler displayed arbitrary exception
text. These paths now render existing localized failure messages without the
untrusted detail. Proxy's own username/password validation remains specific:
only the two locally constructed `ProxyInputError` messages are displayed;
Runtime/network errors use `proxy.operationFailed`. The Japanese window error
template was also revised so its load/save forms read naturally.

The source-Electron journey runs all four release languages. It injects a
canary HTTP 500 into tab and proxy saves and the window-preference GET/PATCH,
checks localized alerts and absence of the canary, verifies the tab value is
unchanged on failure, then retries. It separately verifies the locally
validated proxy-password-without-username message remains specific in all
four languages. The final current-source unsigned macOS package repeats the
remote failure/retry paths, including window load failure/retry, in H-11.
The shared `settings` query's initial proxy-load failure, window reset-bounds
failure and proxy connection-test failure are corrected by the same code
paths but have **not** been individually demonstrated in this packaged run.

```sh
bun run locales:core:generate
bun run build
bunx playwright test --project=visual \
  -g 'proxy, tab and window preferences failures'
# 1/1 passed; four languages, remote failure/retry and local proxy validation

node scripts/package-desktop.mjs --dir \
  --output /tmp/axterm-w05-preferences-final.921mHQ
AXTERM_PACKAGED_APP=/tmp/axterm-w05-preferences-final.921mHQ/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  -g 'packaged H-11 localization switches immediately and survives a cold restart'
# 1/1 passed; four-language proxy/tab/window remote failure/retry
```

| Item                                  | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| Preferences-error unsigned `app.asar` | `bd832ba3c035b972abde2a71a89fdfe3b4c5b49958f257e63a58d1ec5d9f19af` |
| `proxy-settings-panel.tsx`            | `65a729c6d6934dccffecfa974f0f722a184dc54745b33042c2795e411ba4036f` |
| `window-preferences-panel.tsx`        | `e045a494db5d598c73fc29cb292c9d14b942040b94111bea859323da6a71f616` |
| `tab-preferences-panel.tsx`           | `d8e334d46bc08bf68386975125e96861d9c6ad5777d457108b62a6ce2472dcfd` |
| `i18n/core.ts`                        | `113a94ac33474b0e0691d27c77831b38e509bcf10750253ab85e5c8d0a6f44a1` |
| Source-Electron journey               | `5c676ec6932b6e5dfa9b459386fd98c6c5895d7239aefdebdcc5376f086a11bd` |
| Expanded packaged H-11 journey        | `7f79b2b6e33844d3a57cd03dce6c9e23e64a6bd4b84498ced95619f34263fe6c` |

## Shared Settings first-read failure and simulated Runtime outage

The Settings workspace now shows a localized, focusable retry alert when its
initial shared Settings `GET` fails without cached data. The alert is inside
the scrollable content panel: the first source test caught the retry button
being covered by the absolute-positioned category tabs when the alert was a
direct workspace child. The alert was moved into `PanelFrame` and the
four-locale source journey then passed **1/1**. The Runtime ready/degraded
labels in the status area and reconnect overlay also use four-locale catalog
keys instead of hard-coded English.

The source journey chooses each of `en`, `ja`, `zh-CN` and `zh-TW`, injects a
controlled Settings HTTP 500 and Runtime metadata HTTP 503 with a canary
problem detail, checks the localized failure/retry and ready/degraded text,
checks that the canary never appears, and verifies recovery. It is **not** a
real utilityProcess crash: the separate existing hard-kill journey proves
supervision/recovery but did not check four-language outage copy. At this
source-only point, current Mac package and 200% evidence was still missing;
the packaged follow-up below supplies it.

```sh
bun run locales:core:generate
# 2,591 keys per locale; human review still pending
bun run build
bunx playwright test --project=visual \
  -g 'P-07 shows localized Settings load recovery and Runtime outage'
# 1/1 passed; controlled HTTP failures, four languages
```

## S1 current unsigned macOS package at 200% and real Runtime restart

The current-source unsigned macOS arm64 directory app passes the separate S1
packaged journey **1/1**. At a 1440×900 physical window and 200% interface
zoom (720×450 CSS viewport), each of the four release languages exercises an
initial Settings `GET` failure with a canary problem detail. The localized
alert's retry button can be focused, is fully within the viewport, works via
Enter and recovers the saved setting. The same package also renders localized
ready/degraded text and reconnects after a **synthetic HTTP 503** for Runtime
metadata; the canary is not shown. Those HTTP faults are not described as a
utilityProcess crash.

The journey then launches a **fresh packaged host for each language**, reads
the Runtime PID and generation from the app UI, verifies that the PID is not
the host PID, sends `SIGKILL` to that one test-owned utilityProcess, and waits
for a new generation, ready state and the language-specific Runtime-recovered
banner. All four real-crash recoveries passed. The first trial had put four
kills in one host, exceeding the supervisor's intentional three-restart cap;
it timed out on the fourth kill. The corrected isolated-launch test passes
without altering that product safety cap. This proves UI feedback and
supervision, **not** `.part` ownership/cleanup after a transfer crash (W-03-02).

```sh
node scripts/package-desktop.mjs --dir --output /tmp/axterm-s1.TjntjH
AXTERM_PACKAGED_APP=/tmp/axterm-s1.TjntjH/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  -g 'packaged macOS S1 localizes Settings recovery and real Runtime restart'
# 1/1 passed, four locales; synthetic HTTP failures and four separate real kills
```

| Item                        | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| Current unsigned `app.asar` | `883220cc45ab8a193d88ae527a64120e7ea80556a6be2b9920a1af5ab336d59b` |
| `app.tsx`                   | `98b7b805cf81607a2132a680d872a6e6d8578d3d9165c00e521a0b9564659a76` |
| `panels.tsx`                | `c53398bad3be65f04dfb59e2ea9d600ef33625eb116cc8807fc438eb276dae10` |
| `i18n/core.ts`              | `5f05bf37c47d937e5ebaf0d88436d19b8710adaac5b77142d49ab9d4a37e3992` |
| Packaged S1 journey         | `2f22f527b878dc7395a9431f884350faa4687bb5b9a28f578f24f313a67f0a5b` |

At the S1 snapshot, S2–S5, human language/rights and product review, signed
release behavior, and native Windows/Linux results were still open; W-05-02
and IR-05 were not accepted. The S2 follow-up below supersedes only that cell.

## S2 SSH, FTP and connection-profile editors at 200% zoom

The first four-language source journey caught a real SSH editor defect: a
failed save rendered its alert in the Host page **behind** the active modal.
The request was correctly rejected, but the user could not reliably see or
associate the message with the form. While the SSH editor is open, its error
now appears inside that modal with `role="alert"`; non-editor Host errors
remain in the page. SSH/FTP service failures also use four-language safe
messages instead of the raw client/Runtime exception. Connection-profile
save failures use an existing four-language operation message in a live status
region. Locally constructed SSH validation messages remain specific.

The shared source/packaged journey runs `en`, `ja`, `zh-CN`, `zh-TW` at a
1440×900 physical window and 200% zoom (720×450 CSS viewport). In **each**
language it exercises all three editors: required-name validation without a
POST, an injected HTTP 500 carrying a canary detail, retained form fields and
localized accessible feedback, then a successful retry that creates the Host,
FTP bookmark or connection profile. It checks dialog/input/button accessible
names, modal and document horizontal bounds, in-viewport actions and no
canary in visible text. It does not claim an actual network outage, human
translation review or Windows/Linux behavior.

```sh
bun run build
bunx playwright test --project=visual -g 'P-07 S2 localizes SSH, FTP and connection editor'
# 1/1 passed; four languages × three editors

node scripts/package-desktop.mjs --dir --output /tmp/axterm-s2.N9ZvQz
AXTERM_PACKAGED_APP=/tmp/axterm-s2.N9ZvQz/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  -g 'packaged macOS S2 localizes SSH, FTP and connection editor'
# 1/1 passed on copied unsigned Mac app, outside the source checkout
```

| Item                        | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| S2 unsigned Mac `app.asar`  | `123abc09ad7e440f42a2164d795ff46d567afc3881f79d47b16d1e784dd4de36` |
| `panels.tsx`                | `0cf15e4968c799be6332958bc7b77d430a7a7889dc6c8a03199a7ca12c8cbf56` |
| `connection-profiles-panel` | `b5df3dd940c8c405c6c33b3dfa84298bd36f30c768ce7edfb9dc9993f7b7a307` |
| `i18n/core.ts`              | `c714a4653329bee26cb9b3bd48c72b39aa95329e3b78f83e1130031665812662` |
| Shared S2 test journey      | `5caf4b11927a9077543971dea52ff7f403cf29a3aa2021c9b84ee714ae3a12c0` |

S2 is accepted at the **Mac engineering cell** only. S3–S5, W-05-01 human
language/rights review, W-05-03 Windows/Linux verification and the wider
product review remain open. W-05-02 and IR-05 are still In progress.

## S3 terminal search/menu, local file listing and transfer states at 200% zoom

The shared journey runs the four release locales at 1440×900 physical pixels
and 200% zoom (720×450 CSS viewport). In each locale, a **real local PTY**
opens its context menu and terminal search. It checks accessible names,
Escape dismissal, focused search input, a real output match, no match and
invalid-regex feedback. At the narrow viewport it uses the existing keyboard
shortcuts to create a local terminal and collapse the sidebar; the test does
not force-click hidden tabs.

The embedded file manager reads a real Host-granted local directory, then
receives a controlled HTTP 500 with a canary problem detail. Its error and
keyboard-operable retry are visible, the stale file table is hidden, and a
successful refetch restores the table. Previously the error followed a tall
file list and could be below the visible area at 200% zoom. The transfer
center checks empty and completed-card presentation, then a controlled HTTP
500, localized retry, no raw canary and no stale card presented as live state.
The completed card is a **synthetic API response**, not evidence of an actual
file transfer; real transfers are covered separately. No remote SFTP directory
listing, human language review or Windows/Linux result is inferred here.

```sh
bun run build
bunx playwright test --project=visual -g 'P-07 S3 localizes terminal search'
# 1/1 passed; all four locales on source Electron

node scripts/package-desktop.mjs --dir --output /tmp/axterm-s3.Gc1clT
AXTERM_PACKAGED_APP=/tmp/axterm-s3.Gc1clT/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged -g 'packaged macOS S3'
# 1/1 passed on a copied unsigned Mac app outside the source checkout
```

| Item                       | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| S3 unsigned Mac `app.asar` | `ca1ba7434da388cfde98663d9a9f606361ee74e3d956896e1f70d4d1431f10b6` |
| `app.tsx`                  | `08e3ed379c488e3e47284912afd0ec34651c45a5492502d653b6de8b3e6e4de1` |
| `panels.tsx`               | `ca62e5208599ee0d1f78d3abab5d22b4f591bf1a958a8d86aa579207db964a78` |
| `i18n/core.ts`             | `5566f5ae68a1dd185682c22bd81c5eac995f434e49241821460b11c86bb84426` |
| Shared S3 test journey     | `1f840862ef0d9d0959b809a973e5ce9a33e66ca7a06c9aef393febb7d0092fae` |

S3 is accepted as a **Mac engineering cell** only. S4–S5, qualified language,
product and rights review, real old-public-version upgrades, signed release
and native Windows/Linux evidence remain open. W-05-02 and IR-05 stay In
progress.

## Coverage versus outstanding work

| Visible state / accessible name                                         | Four-locale current evidence                                                                                                                                                                                                                                                                                                                                                                                                                 | Still missing for W-05-02                                                                                                    |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Activity rail and Settings navigation                                   | Seven rail labels and seven Settings categories per locale in the [packaged navigation sweep](IR05-MACOS-FOUR-LOCALE-NAVIGATION-2026-09-25.md); current H-11 packaged journey also passed                                                                                                                                                                                                                                                    | Manual screen-reader quality and human wording review are separate W-05-01/product checks                                    |
| Settings page visibility and narrow layout                              | Four locales × seven categories at 200% in [source and current-source packaged checks](IR05-MACOS-FOUR-LOCALE-SETTINGS-ZOOM-2026-09-25.md), including expanded long Legal/SBOM content                                                                                                                                                                                                                                                       | Other conditional content within those pages is not implied by category visibility                                           |
| Language and Settings save/load failures                                | Language switch/restart and failure/retry; behavior, terminal recovery, tab and proxy saves plus window load/save pass four-locale source and earlier Mac packages; monitor save and local proxy validation pass source. Shared Settings initial-read failure/retry, synthetic Runtime 503, 200% keyboard access and real packaged Runtime restart feedback now pass all four languages in the current Mac package without raw server detail | Other Settings writes and conditional pages remain; signed release, human review and native Windows/Linux are separate gates |
| Retired persisted language                                              | Controlled `de`→`en` backed-up migration in the [packaged navigation record](IR05-MACOS-FOUR-LOCALE-NAVIGATION-2026-09-25.md); all 15 historical locale IDs passed database migration/backup unit cases                                                                                                                                                                                                                                      | Real public old-version upgrade belongs to W-08-02; the full 15-ID set has not been exercised inside a packaged upgrade      |
| SSH Host Key unknown/changed dialog                                     | On the new zoom app archive, unknown-key and changed-key text, accessible alert name, high-risk badge, unchecked confirmation, denial guidance and rejection run in all four locales; changed-key geometry and rejection pass at 200%                                                                                                                                                                                                        | Human translation/rights and assistive-tech review remain open                                                               |
| SSH/FTP/connection-profile editor                                       | S2 source and current unsigned Mac package cover all four languages at 200%: required validation, controlled service failure with safe alert/status, success retry, accessible names and horizontal bounds                                                                                                                                                                                                                                   | Human wording and assistive-tech review; other protocol editors are outside the fixed S2 cell                                |
| Sync warning, terminal search/menu, batch input                         | S3 source and unsigned Mac package cover terminal search/menu found, no match, invalid regex and keyboard dismissal in all four languages at 200%; H-11 covers representative other states                                                                                                                                                                                                                                                   | Sync warning and batch-input conditional states remain in S4–S5; qualified review remains separate                           |
| File manager, transfers, themes, widgets, AI and remaining Shell errors | S3 source and unsigned Mac package cover a real local directory, safe failure/retry and transfer empty/synthetic-completed/failure states in all four languages at 200%; core keys exist for other surfaces                                                                                                                                                                                                                                  | Remote file listing, real transfer, themes, Widget, AI and remaining Shell errors are not proven by S3                       |

These macOS packages are unsigned and do not establish Windows/Linux
rendering, qualified translation/rights approval, or complete W-05-02 coverage.
The 46-task ledger and IR states therefore do not change.
