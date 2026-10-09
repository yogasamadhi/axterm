# IR-05 current macOS package: four-locale navigation sweep — 2026-09-25

Scope: **partial W-05-02 macOS engineering evidence**, not language or rights
approval. The selected app is the unsigned arm64 candidate copied from the
current [verified DMG](IR13-MACOS-CURRENT-DMG-INSTALL-2026-09-25.md); no product
code or packaged app byte changed for this follow-up.

The packaged localization journey now switches among `en`, `ja`, `zh-CN` and
`zh-TW` in a cold-profile app. For **each** language it compares seven visible
activity-rail buttons' accessible names and seven Settings-category labels
against the current Axterm navigation catalog, opens all seven Settings
categories and checks their page containers, then returns to General. This
adds 28 activity-name checks, 28 Settings-label checks and 28 category-open
checks to the existing immediate-switch, representative workflow and cold-
restart journey. The test intentionally checks a visible page container rather
than a heading that the compact Settings layout hides; category selection is
also checked via `aria-current=page`.

Three targeted packaged results on the same app archive:

| Journey                                                                                     | Result     | Exact scope                                                                                                                                            |
| ------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packaged H-11 localization switches immediately and survives a cold restart`               | 1/1 passed | Four-language navigation sweep plus existing representative Japanese/Traditional Chinese content, terminal controls and cold restart.                  |
| `packaged upgrade migrates a retired language to English and preserves its database backup` | 1/1 passed | Seeded `de` setting becomes `en`; the pre-migration database backup retains `de`. This is a controlled fixture, not a real public old-version upgrade. |
| `packaged app keeps only the four selected Electron runtime locale families`                | 1/1 passed | Actual packaged Electron locale directory contains only the four selected families.                                                                    |

Command form:

```sh
AXTERM_PACKAGED_APP=/tmp/axterm-macos-current-dmg.2kk8Po/mac-arm64/Axterm.app \
bunx playwright test --project=packaged \
  -g 'packaged H-11 localization switches immediately and survives a cold restart'
```

The retired-language and runtime-locale journeys were run with the same
`AXTERM_PACKAGED_APP` and their exact test names above. The app was copied to
an isolated directory/profile by each journey. The first navigation-sweep
attempt failed because its new assertion required a compact-layout heading to
be visibly rendered. The assertion was corrected to the visible page
container, and the complete localization journey then passed; this is not
reported as a product bug.

| Item                    | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| Packaged journey source | `f9b45a33e3695773033fe9660886c2119a18bd2ffaa78d932073464ea85d365c` |
| App `app.asar`          | `01e2fa75cc7b674cb4f7561ad336127c47512219aa4faf6aa3099ca60f69bb20` |
| DMG                     | `aaf99221aed3c1749acc48261dd7427f0c8cd0f40b77298368558df0846661a8` |

This does not enumerate every conditional UI/error state, prove four-language
overflow and screen-reader quality on every page, replace qualified human
translation/rights review, or establish Windows/Linux behavior. W-05-01/02/03
and IR-05 remain open.
