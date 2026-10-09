# IR-13 current macOS arm64 unsigned candidate — 2026-09-24

State: **local engineering candidate; IR-13 remains Open**.

The current worktree was packaged with `node scripts/package-desktop.mjs
--output` into the isolated ignored directory
`release/ir10-macos-dmg.Fg1NQs/`. Earlier `release/` artifacts were not
overwritten. The candidate has no Axterm Developer ID signature or
notarization receipt; `codesign -dv` reports only an ad-hoc linker signature
on the embedded Mach-O. These are not public release bytes.

| Candidate artifact                                 | SHA-256                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `Axterm-0.10.0-arm64.dmg`                          | `321e4ffdcfb947a6d221237129b3f1808a4322b730611c6325763724d4127986` |
| `Axterm-0.10.0-arm64-mac.zip`                      | `eab26b03e65dbeee16338e6da13477f5b79e7f9c68893383bba5f36c55c3394a` |
| `mac-arm64/Axterm.app/Contents/Resources/app.asar` | `23e23e99948b22b72fcb84394d977fb3d4a62fc252ab9736e998c75a8185dd5c` |
| `AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json`  | `25b9f79de5e84091860ea8b2c35628f26f7d7e073f7ea3ccbb656633e83f6d30` |
| `AXTERM_RELEASE_ARTIFACTS.macos-arm64.json`        | `497efc3085392753ad4ca69f22e0c5b6bed6ecc1e26b44467c27b123cff911cc` |

`test:dmg:macos` verified the DMG CRC, mounted it read-only, copied the app
outside the checkout, detached the image, checked the copied Resources
against the exact packaged SPDX sidecar and update-feed record, and ran
**23 applicable packaged journeys successfully** (14 conditional skips).
The new macOS Shell/Settings three-viewport journey passed in that copied app;
see [the visual record](IR10-MACOS-PACKAGED-VISUAL-2026-09-24.md).
`release:hashes:check` separately matched the DMG and ZIP to the exact hash
manifest. The wrapper removed its temporary mounted and installed copies.

The same candidate's `app.asar` hash was checked again before the following
conditional journeys. `AXTERM_PACKAGED_APP=<candidate Axterm.app> bun run
test:ssh:packaged` passed the real Docker OpenSSH Runtime integration **1/1**,
source Electron save-and-connect **1/1**, and copied packaged-app SSH **1/1**.
The packaged journey exercised password authentication, explicit unknown
Host Key approval, SSH PTY output and search, SFTP `/tmp` browsing, then
bookmark/history persistence and reconnect after restart. The fixture's
three labelled containers and private Docker network were absent after the
wrapper exited. This is a controlled local peer, not an independent remote
service or terminal-transfer protocol-peer validation.

The conditional historical-app upgrade also passed **1/1** with
`AXTERM_PREVIOUS_PACKAGED_APP` set to the separately retained macOS arm64
directory app rebuilt from `657b3cc1552cd3b0dc3b0f73df1c1a4a5a8a6a6e`.
Its `app.asar` SHA-256 is
`5dc53bcc5997016a33e8fa41d588462a7b441cde759b181c95e4df6f91c916b0`.
The current candidate's copied app received data written by that historical
app. The ignored structured receipt
`test-results/packaged-evidence/historical-package-upgrade.json` has SHA-256
`14877cd84b0ad9e75b560bd3eb1e28f939f6841662704ec316e95c036f229c69`:
it records migration **33→38**, a byte-identical pre-migration rollback
database, byte-identical Vault files with credential roundtrips, preserved
Host/Bookmark/Profile/Quick Command links, an old built-in theme remapped to
Axterm `Default`, and explicit encrypted/plaintext legacy WebDAV recovery
without a recovery-side remote write. Both apps report version `0.10.0`;
this is a source-rebuilt historical producer with synthetic data, **not** a
published older installer, customer backup or actual version-number upgrade.

The normal `bun run check` also passed 235 test files (1,179 passed, 38
skipped), Level 1 architecture, 267 Contract operations, package layout and
all 11 source visual/accessibility journeys. It does not run the conditional
packaged SSH or historical-app tests unless their fixtures are supplied.

The same candidate was subsequently exercised on mounted real **FAT16** and
**ExFAT** volumes. FAT16 passed native no-replace publication and all three
packaged terminal-transfer roundtrips; ExFAT passed the corresponding
fail-closed Runtime and packaged-app checks without an incomplete final file.
Exact scope and limitations are in the [current real-volume record](IR03-CURRENT-MACOS-REAL-VOLUMES-2026-09-24.md).

Still required before IR-13 acceptance: a signed/notarized macOS release,
approved public HTTPS update feed and verified uploaded/downloaded artifact
bytes, a genuine older public-version/customer-data migration where available,
independent service/protocol review, native Windows/Linux installed evidence
and complete source/rights/brand review. No production credentials or user
data were used in this local trial.
