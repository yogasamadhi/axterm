# IR-05 macOS four-locale Settings at 200% zoom — 2026-09-25

Scope: partial W-05-02 and W-10-02 engineering evidence, not language,
accessibility, design or release approval. The test covers all four supported
locales (`en`, `ja`, `zh-CN`, `zh-TW`) and all seven Settings categories, for
**28 locale/category states** at a 1440×900 physical window with 200% zoom
(720×450 CSS viewport).

## Defect and correction

The first expanded source-Electron test failed on `en/legal`: its Settings
content measured 271 px of client width but 330 px of scroll width. The
About/Legal panel uses a Grid containing long unbroken license/SBOM filenames.
Its automatic minimum track width allowed a summary to stretch the grid beyond
the narrow Settings column. The panel now uses a zero-minimum `1fr` track and
wraps long summary text anywhere. Legal text and filenames remain readable;
the fix does not hide overflow or truncate legal notices.

## Verification

```sh
bunx playwright test --project=visual \
  -g 'all four language settings usable at 200% interface zoom'
# initial expanded run: failed at en/legal, 330 px scroll vs 271 px client
# after CSS correction: 1/1 passed, all 28 states

node scripts/package-desktop.mjs --dir \
  --output /tmp/axterm-w05-settings-zoom.Jg2DFi
# isolated unsigned macOS arm64 directory package; release/ untouched

AXTERM_PACKAGED_APP=/tmp/axterm-w05-settings-zoom.Jg2DFi/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  -g 'keeps all four languages and Settings categories bounded at 200% zoom'
# 1/1 passed, all 28 states inside copied current-source package
```

For each state the tests select the locale, open the category, verify the
selected page and assert both the content's `scrollWidth ≤ clientWidth + 1`
and the document's `scrollWidth ≤ viewportWidth + 1`. Vertical scrolling is
allowed. On the Legal page the packaged journey also expands the long-named
`AXTERM_PRODUCTION_DEPENDENCIES.spdx.json` details before measuring, so the
conditional legal text state is not hidden by the collapsed summary. The
packaged journey copies the app into an isolated directory and uses a fresh
profile; it does not rely on the earlier DMG's CSS bytes.

| Item                   | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `globals.css`          | `c556501b0e9ed511d8249ea17e869dc778b0ed0e2a62f472042c37a4ceeaccfa` |
| Current app `app.asar` | `a06b07d60a7358b89aed345e7b643cd668fe3496cd5b10da9aa2282e14c9004c` |

These geometry checks do not prove that all 2,586 message keys per locale
have been reviewed by qualified translators, that every conditional/error
surface is reachable and translated, or that Windows/Linux native packages
render identically. W-05-01/02/03, W-10-01/02/03 and IR-05/IR-10 remain open.
