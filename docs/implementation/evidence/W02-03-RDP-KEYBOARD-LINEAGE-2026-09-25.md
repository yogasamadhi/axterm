# W-02-03 RDP keyboard mapping source-lineage escalation

Date: 2026-09-25  
Status: **engineering replacement present; qualified release-rights review still required**  
Screened former map: `apps/desktop/src/renderer/src/components/rdp-canvas-adapter.ts`  
Current map: `apps/desktop/src/renderer/src/components/rdp-scancodes.ts`

This is a triage finding, **not** a determination that protocol numbers are
copyrightable, that Axterm copied a protected work, or that the whole product
has a particular license. It must not be used to mark W-02-01, W-02-03 or IR-02
accepted.

## Reproducible inputs and observations

- Fixed Legacy Prototype reference: commit
  [`799bedef98c1deae676ae03041719de98d3b57f1`](https://github.com/legacy-prototype/legacy-prototype/blob/799bedef98c1deae676ae03041719de98d3b57f1/src/client/components/rdp/code-scan.js),
  `src/client/components/rdp/code-scan.js`. Its first line points to
  `citronneur/mstsc.js/client/js/keyboard.js` as a source.
- Pinned mstsc.js reference: commit
  [`6c8cbbdbcb1116512c875eec745e56a18f9ebe1d`](https://github.com/citronneur/mstsc.js/blob/6c8cbbdbcb1116512c875eec745e56a18f9ebe1d/client/js/keyboard.js),
  raw `keyboard.js` SHA-256
  `d7252b31f3963197f69a3334fa67e09bed82f86808f1dd003495ab3bc7783e9e`.
  That source file carries a Sylvain Peyrefitte copyright header and
  GPL-3.0-or-later statement; the repository also has a
  [GPL-3.0 license file](https://github.com/citronneur/mstsc.js/blob/6c8cbbdbcb1116512c875eec745e56a18f9ebe1d/LICENSE).
- At the time of the screen, Axterm's `KEY_SCANCODES` contained **84 named entries**. Of these, **82** had
  the same name and numeric value in both fixed Legacy Prototype's `KeyMap` and the
  pinned mstsc.js `KeyMap`; there are **zero** same-name value differences.
  Axterm's two extra names are `MetaLeft`/`MetaRight`, corresponding to the
  `OSLeft`/`OSRight` convention used in those references. Direct comparison
  used the source object entries, not only a fuzzy text score.
- A bounded TypeScript-scanner screen compared **248 then-current product JS/TS
  source files** in `apps/desktop/src` and four `packages/*/src` trees with
  **644** fixed Legacy Prototype `src/app`/`src/client` files. It normalized literal
  values, used 7-token shingles, and found 42 file pairs with at least 20
  shared shingles. The RDP pair was the largest containment candidate:
  310 shared shingles, 0.518 containment of the smaller file and 0.134
  Jaccard overlap. Their complete file bytes differ. This screen excludes
  tests, fixtures, other repository trees and historical versions; the
  metrics are **not** a copied-code percentage.
- The next candidates were current `terminal-theme-presets.ts` against
  Legacy Prototype theme defaults (78 shared shingles, 0.322 containment) and current
  `remote-monitor-model.ts` against Legacy Prototype's monitor model (80, 0.211).
  Subsequent [bounded follow-up](W02-03-MONITOR-THEME-SIMILARITY-2026-09-25.md)
  found exact monitor behavior overlap and made a distinct Axterm engineering
  replacement; the current theme source has zero exact key/color pairs against
  the two fixed default-theme files. Neither finding is a rights clearance.
  Both changed/current files remain in the per-file review queue.

## Engineering replacement from a separately licensed source

The former inline `KEY_SCANCODES` object has been removed. The current
`RDP_SCANCODES` module was mechanically generated from
[Chromium `dom_code_data.inc` at commit `6f88d301153935f5ea3ad43fbbb4096ddfe25685`](https://github.com/chromium/chromium/blob/6f88d301153935f5ea3ad43fbbb4096ddfe25685/ui/events/keycodes/dom/dom_code_data.inc)
(raw SHA-256
`841e2c58e6388f14736717eb6e365c8b8e9767788e36339bf1d35a37ab48e5b2`).
The selection rule is: USB keyboard usage-page `0x07` rows with a nonzero
Windows scan-code column and a browser code in the existing 84-key Axterm
input surface. All **84** selected name/value pairs match the former
behavior, with no new input codes enabled. The new module follows Chromium
row order, carries its source copyright header and pins its input commit and
hash. The exact [Chromium BSD-style root license](https://github.com/chromium/chromium/blob/6f88d301153935f5ea3ad43fbbb4096ddfe25685/LICENSE)
is preserved at `licenses/chromium-dom-code-data-LICENSE.txt` (SHA-256
`368cca1106be99d39ecd32a38d8305585d802a475effb66380b91ffc9bcf709b`)
and referenced in `THIRD_PARTY_NOTICES.txt`; both are available through the
existing package/Legal inclusion path. The two focused map tests and typecheck
passed. The final `bun run check` passed **1,244 unit/integration tests** (38
skipped), its architecture/Contract/license/source/build gates and **21/21**
visual/accessibility journeys.

A freshly built **unsigned** macOS arm64 directory app has `app.asar` SHA-256
`143f51043b89881e4df56f5de3708e0992a5d64ba6708fe3ed197c5d50ed3603`.
On that same artifact, two packaged journeys passed: external license/notices
files byte-match source, and the app's About/Legal view renders the new exact
Chromium text with the other notices (**2/2**). Current source hashes are:
`rdp-canvas-adapter.ts`
`89ad9905a2308d1b9ee8cc369ffd5b7d4c5eb3ab5acb4f7295b2da8f80e8f330`,
`rdp-scancodes.ts`
`1b0b114c4f008d7af328b108a011dc8c356f3ba5ef2d66c8d01ca336bfb56fa9`,
and `THIRD_PARTY_NOTICES.txt`
`f0ade45bf1ef444c8a1786af17a4610715580fe3c8ad6f5379c11a417aa39786`.
These packaged checks do **not** exercise a live RDP server, prove Windows/Linux
behavior, or replace qualified rights review.

The migration-period source after this replacement also passed
`bun run candidate:check`: a disposable Git root commit
`b85e650406639ccd886c418afc0f9db48f9414e0` and a distinct
`git clone --no-local` contained **952 tracked files** with audited source
tree SHA-256
`f8872ba2201352a324a6bce9d3b278d98d1064bf08ef855d02b29114a23cd709`.
The clone had no `.gitmodules`, `vendor/legacy-prototype`, generated OpenAPI file or
uncommitted changes. Frozen Bun installation rebuilt the macOS native
module and the clone's complete `bun run check` passed **1,244 tests**, all
its architecture/Contract/source/license/build checks and **21/21**
visual/accessibility journeys. SSH and external-peer suites were not
requested in this run. This is local source reproducibility for the current
migration-period snapshot, not a final public removal build, a real owner
repository, source-rights acceptance or three-platform release proof.

This is a concrete alternative provenance path, **not** a conclusion that
the old map had protectable expression, that the replacement is free of all
upstream obligations, or that the final package is cleared. A qualified
reviewer must evaluate whether the current 84-key selection and exact
generated bytes can be retained under the documented BSD terms, and whether
any historical-distribution action is required.

## Decision required before an Apache-2.0 release

Assign a qualified source-rights reviewer to assess the exact RDP table's
provenance, protectable expression versus protocol facts, Legacy Prototype's source
chain, and applicable notices or replacement. The intended browser-code and
RDP scancode behavior can also be checked against the independent
[W3C `KeyboardEvent.code` specification](https://www.w3.org/TR/uievents-code/)
and [Microsoft RDP keyboard-event specification](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/7acaec9f-c8a6-4ee9-87d6-d9b89cf56489).
Review the current Chromium-derived table and the former Legacy Prototype/mstsc.js
chain separately. If the current table cannot be retained with a documented
Apache-compatible rights basis, replace it again from an approved source,
add behavioral tests and re-review the resulting exact bytes. A cosmetic
rename/reformat or merely adding a GPL notice is **not** clearance.

Until that decision and any required remediation are recorded, treat this as
an explicit **release stop** for the RDP source-rights scope. The finding does
not change the existing W, IR or M1 engineering acceptance counts.
