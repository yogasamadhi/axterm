# IR-05 / W-05-02 / S4: four-locale theme, Widget and AI states on macOS

Date: 2026-09-25. Scope: **Mac engineering cell S4 only** from
[the fixed execution board](../REMAINING_RELEASE_WORK.md). The test uses a clean
profile, the real local Runtime and Host, English/Japanese/Simplified
Chinese/Traditional Chinese, a 1440×900 physical window at 200% zoom
(720×450 CSS viewport), and keyboard focus/Enter on each recovery button.
The same shared journey ran in source Electron and a copied unsigned macOS
arm64 `.app` produced from the current source. No Windows/Linux, signing,
human translation, design or rights approval is inferred.

| Surface         | Normal and empty state                                                                                                              | Controlled failure and recovery                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terminal themes | Real Runtime built-in list and searchable theme editor; an unmatched search shows the distinct “no matching themes” state           | HTTP 500 on the theme list shows a localized alert and keyboard retry, not an endless loading indicator or a false empty result. A successful refetch restores real themes.                  |
| Widgets         | Real Runtime catalog and configurable built-in selection; unmatched search and an empty running-instance list have their own states | Separate controlled HTTP 500 responses for catalog and instance list show localized alerts and retries, hide false empty states, and do not claim “0 running” when the count is unavailable. |
| AI              | Real no-provider setup dialog, chat workspace, empty history and empty conversation                                                 | HTTP 500 on chat history shows a localized recovery alert instead of “no chat history”; successful retry returns the genuine empty state. The activity-rail AI accessible name is localized. |

The controlled `application/problem+json` title **and** detail contain
`s4-runtime-secret-canary-do-not-display`; neither appears in the UI. The
theme and Widget action-error helpers no longer display arbitrary Error
messages. AI action errors now use safe localized wording, preserving only a
locally constructed proxy-input validation message. This journey specifically
asserts the four read-failure paths above; it does **not** claim to exercise
every mutation, AI provider network call or remote Widget instance.
Recovery alerts remain inside the horizontal viewport, and each retry button
is focusable and in the viewport at 200%.

```sh
bun run typecheck
bun run build
bunx playwright test --project=visual -g 'P-07 S4'
# 1/1 passed; four locales in source Electron

node scripts/package-desktop.mjs --dir --output /tmp/axterm-s4-final.IJJdji
AXTERM_PACKAGED_APP=/tmp/axterm-s4-final.IJJdji/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged -g 'packaged macOS S4'
# 1/1 passed; copied unsigned Mac app outside the checkout
```

| Identity                     | SHA-256                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| S4 unsigned Mac `app.asar`   | `fa11c3f59dddbe18b7ce9a208ccab762bb91e7282bbf36d309a752dd9b4efbe3` |
| Theme workspace source       | `605c646670ccb42d073e6944fc99c0e6d20a3ce8092974693b5b13dbbff6413a` |
| Widget workspace source      | `8d7cdf499051d42daeda54130094d3881a7f6f7f4badb241e563f75a070de87d` |
| AI panel source              | `01bb108eedebab1cac011e9857db616a1b0aba270d99f4cc11d8c3a3248f1a71` |
| Four-language catalog source | `048e8c88531e3520f1ccaa732097aa9a0502b6f79520249036af2e2e605ef387` |
| Shared S4 journey            | `21a9b7d0ea92b21608a9f8b2f2bdb14fb54386cec5b4fb0d42a7469044458e39` |

S4 is accepted at the scoped Mac engineering level. **S5** (remaining
Shell/navigation errors and product-review handoff), W-05-01 qualified
translation/rights review, W-05-03 Windows/Linux and the broader IR-05 gate
remain open. This evidence closes **0 W items** and changes **0 IR states**.
