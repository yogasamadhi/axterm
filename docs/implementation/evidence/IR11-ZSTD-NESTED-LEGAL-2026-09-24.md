# IR-11 vendored Zstandard legal texts in the macOS package — 2026-09-24

Status: **two identified nested texts preserved and packaged; license applicability and rights review pending**.

The pinned `@openclaw/fs-safe@0.13.1` source checkout is tag commit
`7022a0a10c53e36f34a467df68ed5614a1db1741`. Its `Cargo.lock` SHA-256 is
`d169c18102ef5a465cf645ceecc15956aafd2f694031d2006284bbcb59284bbd`.
The macOS arm64 locked graph contains `zstd-sys@2.1.0+zstd.1.5.7` with `.crate`
SHA-256 `0ef0a8027ec3ee71300ab3bcbcd0393f434aa72b91ca6d635a39941deae8eea0`.
A nested `LICENSE`/`COPYING`/`NOTICE`/`AUTHORS`/`COPYRIGHT` filename scan of
all 61 pinned Cargo source-package directories identified two additional legal
files in this crate's vendored `zstd/` tree. The scan is a discovery method,
not proof that every source comment, generated file or linked object has been
fully reviewed.

| Exact archive path | Preserved file                            |  Bytes | SHA-256                                                            |
| ------------------ | ----------------------------------------- | -----: | ------------------------------------------------------------------ |
| `zstd/LICENSE`     | `licenses/zstd-sys-Zstandard-LICENSE.txt` |  1,549 | `7055266497633c9025b777c78eb7235af13922117480ed5c674677adc381c9d8` |
| `zstd/COPYING`     | `licenses/zstd-sys-Zstandard-COPYING.txt` | 18,091 | `f9c375a1be4a41f7b70301dd83c91cb89e41567478859b77eef375a52d782505` |

`bun run licenses:zstd:embedded:generate -- <pinned fs-safe checkout>` checks
the Git commit, lock-file hash, locked crate identity/checksum, archive bytes,
extracted Cargo source bytes and both original legal-file hashes before writing
the files. The routine offline `licenses:zstd:embedded:check` and final-public
prerequisite verify the pinned scope and preserved bytes; unit tests reject a
changed source scope or license byte. The root-only 111-text bundle remains
unchanged and these are separate supplemental files.

The nested `zstd/LICENSE` is a BSD-style Zstandard copyright/permission text;
`zstd/COPYING` is GPLv2. For example, the locked archive's
`zstd/lib/common/fse_decompress.c` header says the source is licensed under
both and the recipient may select either option. Preserving both files is a
conservative source-text measure, **not** a selection of the GPL option or a
conclusion about which code is linked into the published `.node` and what
distribution obligations apply. The crate's root BSD-3-Clause legal files
remain in `licenses/fs-safe-rust-ROOT-LICENSES.txt`. A qualified reviewer must
resolve applicable choices, attribution and the final source-to-binary map.

An isolated **unsigned** macOS arm64 directory app at
`/tmp/axterm-zstd-macos-UQ0V4D/mac-arm64/Axterm.app` contained both exact
files in `Contents/licenses/`. The two focused legal/About packaged journeys
passed, then the full directory-app packaged suite passed **22**, skipped
**11** platform/fixture-gated cases and failed **0**. Its artifact-level SPDX
sidecar matched the exact Resources tree, SHA-256
`81428ce26d56908e74c7c0305604385b9742e8e76aa342cef16dff16b8140388`;
`app.asar` SHA-256 was
`08d493c01079c2aab653834e8827bcbc518a26b9005546aededb42f1be19b242`.

A fresh unsigned DMG at
`/tmp/axterm-zstd-dmg-wYA3jq/Axterm-0.10.0-arm64.dmg` has SHA-256
`bac546c3e9f705e2e50d74d67ee6e7ba3cb46509f85d01db5e5c44b0ee07756a`.
`test:dmg:macos` validated the disk image, mounted it read-only, copied the app
outside the checkout, detached the image, verified its package SPDX sidecar
and update-feed record, and reran the packaged suite (**22 passed / 11 skipped**).
That DMG's sidecar SHA-256 is
`2e2d0a7a2f876799f12e97916e50f63767c38b13be147be264a5a6a2c1878064`;
it records **102 packages, 252 files and 353 relationships**, including both
new texts. The copied app's `app.asar` SHA-256 is
`999aa1b3f697298ae83799514dc917d34380fe115fdbbee5046fc5a2f71f34ad`.
The package inventory and Legal/About tests compare every `licenses/*.txt`
against the repository original. No signing, notarization, public download,
real old-public-version upgrade or Windows/Linux test was performed here.

The conditional macOS SSH fixture was then run separately against this fresh
DMG build's `mac-arm64/Axterm.app`: the OpenSSH container fixture integration
test passed **1/1**, the source-Electron authenticated save/connect journey
passed **1/1**, and the packaged app's authenticated SSH terminal journey
passed **1/1**. The fixture containers/network were removed by the script's
cleanup. This adds a local container peer, not evidence from a public or
customer-controlled external SSH server.

The native review ledger still has **61 source packages plus one published
binary pending**. The mismatch between local rebuilt and published `.node`
bytes, other nested/inlined notices, platform-specific source graphs and
qualified license/source-rights decisions remain open. IR-02 and IR-11 stay
**In progress**; this macOS engineering evidence does not authorize release.
The full `bun run check` passed **227 test files, 1,148 tests passed / 34
skipped**, 360 architecture modules / 1,310 dependencies, 267 Contract
operations and 11 visual/accessibility journeys. The final-public gate still
refused promotion on eight pre-existing pending prerequisites; the new
`licenses:zstd:embedded:check` prerequisite passed.
