# IR-11 Markdown-prefixed license notices — 2026-09-25

Status: **installed-source, current unsigned macOS package and About-page
extraction verified; qualified rights review remains pending**.

## Finding and correction

The root-license attribution extractor previously recognized a copyright
line only when `Copyright` or `©` was the first non-whitespace character.
The installed MIT `license.md` files for `lie@3.3.0` and
`process-nextick-args@2.0.1` have publisher copyright declarations prefixed
with `#Copyright` and `# Copyright`, respectively. Both files were already
archived byte-for-byte, but their declarations were omitted from the
derived metadata and both packages were falsely added to the specialized
`missingCopyrightDeclarations` review queue.

The extractor now recognizes one to six leading Markdown heading markers
before `Copyright` or `©`. It preserves the exact source line, including the
marker, and does not alter either legal file. A unit fixture verifies both
publisher spellings and confirms that a prose reference to copyright does
not become a declaration. The specialized queue now has **10 pending packages,
down from 12**. This is not a legal finding that either package or the other
ten entries are cleared for distribution.

| Installed package            | Root legal file SHA-256                                            | Preserved declaration                                     |
| ---------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| `lie@3.3.0`                  | `5c81b0caa98593408b03125efa25efe622341ed87ae55561968828cd887d64a4` | `#Copyright (c) 2014-2018 Calvin Metcalf, Jordan Harband` |
| `process-nextick-args@2.0.1` | `ecdccbcf39024f624ded480c01c0b25458e1eca8f26ecf040933865ce56d9a4f` | `# Copyright (c) 2015 Calvin Metcalf`                     |

## Verification

The focused license-text and attribution-ledger tests passed **7/7**. The
generated archive and regenerated scoped ledger have these source hashes:

| Source artifact                          | SHA-256                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `THIRD_PARTY_LICENSE_TEXTS.json`         | `4486add0b1e7c2f766be24a8f52cb5afadddb3ae7b22bd8a67cabb47439868a9` |
| `LICENSE_ATTRIBUTION_REVIEW_LEDGER.json` | `93e2321bc133ea0781fed0647dcf15bba0d45b2f3d906cbf944e8a8f2f58c0ca` |

A freshly built unsigned macOS arm64 directory app was placed in
`/tmp/axterm-license-heading-package.GHSKtM/mac-arm64/Axterm.app`. The
packaged legal-file and About-page journeys passed **2/2**, asserting the
archive's exact package bytes, the ten-entry queue and both recovered
publisher lines. The concrete Resources directory passed a regenerated
`sbom:packaged:check` comparison.

| Packaged artifact                    | SHA-256                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| `Contents/Resources/app.asar`        | `9d5f7b9680fa9de52399337deef3219478e082ab61ac6fc5e62e7f1faf345b14` |
| Verified macOS packaged SPDX sidecar | `92b6056f9da55e041f305f5fa065a7d46a8f2f6cac9d3bbcc91bc8209b2cd930` |

## Remaining boundary

The archive still has eight packages without a root LICENSE/COPYING/NOTICE
file, and the ten specialized copyright-attribution entries remain
`pending`. Preserving a publisher line is not proof that the line is complete
or that inlined, native, WASM, Electron/Chromium and non-code rights are
covered. This is only an unsigned macOS directory package, not a signed
installer or three-platform legal clearance. IR-02 and IR-11 remain **In
progress**.
