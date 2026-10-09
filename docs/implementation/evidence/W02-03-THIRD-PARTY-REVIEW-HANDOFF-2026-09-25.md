# W-02-03 third-party source and rights review handoff

Updated: 2026-09-25  
Status: **prepared for assignment, not reviewed or approved**  
Scope: [W-02-03](../REMAINING_RELEASE_WORK.md), with cross-task pointers to
W-02-01, W-03-01, W-04-01, W-05-01, W-06-01, W-07-01 and IR-02/IR-11.

This is a decision queue for qualified reviewers, not an automated clearance
report. The [third-party audit](../THIRD_PARTY_LICENSE_AUDIT.md) is the
detailed evidence index; the pinned JSON ledgers remain the authoritative
byte-level queues. The current production component index has **140**
name/version entries, but that count does not cover every inlined source,
native crate, embedded WASM file, font, image or Electron/Chromium component.
The [source-file ledger](../../../compliance/AXTERM_SOURCE_FILE_REVIEW_LEDGER.json) has
**966/966 pending** source decisions. No item below is promoted to
`reviewed` by this handoff.

**Priority escalation:** The [RDP keyboard mapping lineage screen and engineering replacement](W02-03-RDP-KEYBOARD-LINEAGE-2026-09-25.md)
found that 82 of the former 84 named scan-code entries matched a pinned
`mstsc.js` file carrying a GPL-3.0-or-later header; fixed Legacy Prototype explicitly
cites that file. The former inline map has now been replaced with a map
mechanically sourced from pinned Chromium BSD-licensed data, preserving the
84-key behavior and adding separate source/packaged notices. This is not a
legal conclusion about protocol facts, historical derivation or the current
bytes. A qualified reviewer must accept or reject the current provenance
and distribution terms before release. The theme and remote-monitor
candidate comparison and monitor-model replacement in the same bounded screen
are [recorded separately](W02-03-MONITOR-THEME-SIMILARITY-2026-09-25.md);
both files remain pending file-level review.
The [bookmark Trigger preset comparison and replacement](W02-03-BOOKMARK-TRIGGER-PRESETS-2026-09-25.md)
is another prioritized file-level decision; changed behavior and green tests
do not establish authorship.

## Decisions to assign

| Review owner to appoint                         | Evidence ready now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Decision and missing proof                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol/code-lineage reviewer                  | [Publisher commits and installed license hashes](IR02-TRANSFER-PUBLISHER-SOURCE-2026-09-24.md), [current 33-file isolated `trzsz2` rebuild](IR02-TRANSFER-REPRODUCIBLE-BUILD-2026-09-24.md), [current Axterm wrappers against fixed Legacy Prototype commit](IR02-TRANSFER-LEGACY_PROTOTYPE-REFERENCE-2026-09-24.md), and the MIT package notices. Legacy Prototype uses the same `zmodem2@1.4.0` and `trzsz2@1.2.0` versions.                                                                                                                                   | Examine XMODEM, ZMODEM, TRZSZ wrappers **and the libraries' earlier source chain**, not only names, hashes or identical-line counts. Decide retain/replace, copyright/notice completeness and distribution terms on the final bytes. Independently review no-replace publication and Proposed ADR-019 under W-03-01; that safety decision is not a copyright decision.           |
| FTP/code-lineage reviewer                       | `basic-ftp@6.2.1` is the current MIT dependency; `@legacy-prototype/ftp-srv` is absent from the production graph. The [Mac FTP exception matrix](IR04-MACOS-FTP-EXCEPTION-MATRIX-2026-09-25.md) and [third-party audit](../THIRD_PARTY_LICENSE_AUDIT.md) identify the adapter and runtime evidence.                                                                                                                                                                                                                                                              | Review `basic-ftp` source/license chain and Axterm's FTP adapter for direct Legacy Prototype-derived expression and complete notice placement; separately sign off security behavior under W-04-01. Passing FTP tests does not decide authorship.                                                                                                                                |
| Native/Rust reviewer                            | `@openclaw/fs-safe@0.13.1` and macOS arm64 binding: [source/byte investigation](IR11-FS-SAFE-NATIVE-SOURCE-2026-09-24.md), [official npm attestation](IR11-FS-SAFE-NPM-ATTESTED-PROVENANCE-2026-09-24.md), [61-package plus one-binary pending ledger](../../../compliance/NATIVE_DEPENDENCY_REVIEW_LEDGER.json). Root texts and 156 source-header candidates are packaged. The local binding rebuild is **not** byte-identical to the published binary.                                                                                                         | Determine applicable license/attribution and nested/file-level notices for each retained source and the shipped binding; resolve source-to-binary uncertainty or explicitly accept/restrict it with evidence. Include `node-pty`/serialport shipped native binaries and patched `node-pty` notice. Windows/Linux target graphs and artifacts remain separate.                    |
| WASM/RDP reviewer                               | `@devolutions/iron-remote-desktop-rdp@0.7.0` declares `MIT OR Apache-2.0`; the embedded WASM hash and source candidates are in the [WASM scope record](IR11-IRONRDP-WASM-SOURCE-SCOPE-2026-09-24.md) and [259-package plus one-WASM pending ledger](../../../compliance/IRONRDP_DEPENDENCY_REVIEW_LEDGER.json). The package omits a root license file; Axterm packages upstream Apache text separately.                                                                                                                                                          | Decide the applicable license option, copyright/nested notices and exact source-to-WASM obligations. Do not infer linked code from a candidate Cargo graph or a matching embedded binary hash. Record whether this implementation can be retained for commercial Apache-2.0 distribution.                                                                                        |
| Remote-protocol license reviewer                | [noVNC source availability](IR11-NOVNC-SOURCE-AVAILABILITY-2026-09-23.md) covers `@novnc/novnc@1.7.0` (MPL-2.0); [SPICE source attribution](IR11-SPICE-SOURCE-ATTRIBUTION-2026-09-23.md) covers `spice-client@1.2.0` (LGPL-3.0-or-later). Legal texts and source notices are bundled and About-accessible.                                                                                                                                                                                                                                                       | Determine actual file-level MPL obligations and LGPL corresponding-source/relinking duties for the **bundled renderer form** and final packages. A package-level SPDX string or source-map match is insufficient.                                                                                                                                                                |
| Font, language and theme reviewers              | [Product asset provenance](../PRODUCT_ASSET_PROVENANCE.md) pins two bundled `@fontsource/maple-mono@5.3.0` font bytes and its OFL notice. The [core-language ledger](../../../scripts/localization/axterm-core-review-ledger.json) has four locale entries of **2,617** keys each; the [navigation ledger](../../../scripts/localization/axterm-navigation-review-ledger.json) has four locale entries of **44** keys each. Every language and rights status remains pending. [Theme migration](../THEME_CATALOG_MIGRATION.md) describes four curated built-ins. | Check Maple Mono's original OFL/Reserved Font Name terms and actual platform bundles; establish independent source/translation rights for each locale and accessible name; review each theme's name, palette and design origin. Translation coverage and contrast tests are not rights approval. W-05-01 and W-06-01 keep their own sign-offs.                                   |
| Package attribution and product-asset reviewers | The [10-entry missing-declaration queue](../../../compliance/LICENSE_ATTRIBUTION_REVIEW_LEDGER.json) is **10/10 pending**, despite supplemental publisher materials. The [five product-mark files](../../../compliance/PRODUCT_ASSET_REVIEW_LEDGER.json) have pending rights, brand and public-disposition fields.                                                                                                                                                                                                                                               | For each package, establish a defensible holder/notice conclusion from primary material and decide retain/replace. For the application mark, obtain creator authorization and independent brand/trademark review under W-07-01/02; generated icon variants do not prove those rights. The remaining components and final package contents still require their own scoped review. |

## Required reviewer output and stopping rule

For every retained component or asset, record the **exact current version or
file hash**, primary source/license evidence, rights holder and applicable
license choice, required notice/source/distribution action, a `retain` or
`replace/exclude` decision, reviewer identity, review date and unresolved
issues. For an uncertain source chain, leave it pending or mark
`needs-follow-up`; do not backfill a favorable conclusion from a clean build,
an npm manifest author, a source-map match or an automated zero-hit scan.
Changed bytes must be re-reviewed. A final retained package also needs its
actual signed/installed-platform contents checked; Mac evidence cannot sign
for Windows/Linux.

The existing strict gates include `source:review:reviewed-check`,
`licenses:attribution:reviewed-check`, `licenses:native:reviewed-check`,
`licenses:ironrdp:review:reviewed-check`, `locales:core:reviewed-check`,
`locales:navigation:reviewed-check` and `assets:marks:reviewed-check`.
They are **expected to fail while the truthful pending records remain**.
Passing them later is necessary evidence for their own scopes, not by itself
the qualified W-02-03 conclusion or a final release approval.
