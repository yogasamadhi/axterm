# IR-13 macOS arm64 DMG with packaged update-feed record — 2026-09-24

Status: **unsigned local DMG installation and 21 applicable packaged journeys
verified; IR-13 remains Open**.

## Scope and artifact identity

Axterm `0.10.0` was rebuilt from the current worktree into isolated directory
`/tmp/axterm-feed-dmg-SvCdLh/`. The build used `node
scripts/package-desktop.mjs --output <empty directory>`, which disables
ambient macOS signing-certificate discovery; electron-builder reported code
signing skipped. The repository `release/` directory was not modified.

| Artifact                                     |       Bytes | SHA-256                                                            |
| -------------------------------------------- | ----------: | ------------------------------------------------------------------ |
| `Axterm-0.10.0-arm64.dmg`                    | 141,993,648 | `fd8fe0c5dd4dcdca881d8fde2c321a4fdfb2da10a7a56cd3ba83514bf343c5f9` |
| `Axterm-0.10.0-arm64-mac.zip`                | 136,657,913 | `7ac69baf04ef8e8e4ac785a989e7a0cf1df1768c9cc80e54953bd47036afe2e7` |
| DMG blockmap                                 |     149,138 | `1e56d883bd7f8aa9937c574b2a96d4b99c3fcfa772738f9a053929f756a6ed45` |
| ZIP blockmap                                 |     143,074 | `89290d54bc5e9b5dd3755a08e1218075e574f8698493f91e36d490eeb21489ae` |
| Packaged SPDX 2.3 sidecar                    |     308,224 | `1d3a66ac015dce178b978bd729d980059879a22668810f1ed329e3a9c0f45da4` |
| Release-artifact hash manifest               |         798 | `51c6dd09e7e9a09f0660abf512fa422225d1bbdb199bf47e8b2bd6ebd2b04190` |
| `Contents/Resources/app.asar`                |           — | `29df8049dba580d7a40de67a03850e125ece461af18efa9526e9b5ba2c0450fe` |
| `Contents/Resources/AXTERM_UPDATE_FEED.json` |           — | `ce4f3e7a03e4b6239d0c972629292f7703bb6bb5c568275b2d5ffd7a0d1acdc9` |
| `Contents/THIRD_PARTY_NOTICES.txt`           |           — | `45b153c0c9ae06814f8a2ef22999bcbf9ba92951a05fef29c8d980a9f6ce4332` |

The packaged update-feed record matches the source `UPDATE_FEED_RECORD.json`
byte-for-byte; both are still `pending`. The packaged notices match the source
`THIRD_PARTY_NOTICES.txt` byte-for-byte. The Resources were inventoried into
the sidecar and verified against both the builder output and the copied
installed app. The release-artifact hash manifest was regenerated and checked
against the retained DMG, ZIP and blockmaps; `unzip -tq` found no ZIP errors.

## Installed-app result

`sh scripts/test-macos-dmg.sh
/tmp/axterm-feed-dmg-SvCdLh/Axterm-0.10.0-arm64.dmg` passed. It verified the
DMG CRCs, mounted the image read-only, copied `Axterm.app` into a separate
temporary installation directory, detached the image before launching the
app, checked its actual Resources against the SPDX sidecar, and ran
`release:updater-feed:package-check` against the installed copy. The packaged
Playwright suite then passed **21/21 applicable journeys** and conditionally
skipped 10 Windows/Linux, preserved-historical-binary and opt-in SSH cases.
Passing journeys include FTP Widget, all three local-PTY transfer protocols,
Legal/About, four runtime locale families, migration and recovery, Host Key
review, cold restart, prior-schema/Vault upgrade, the signed-manifest updater
fixture and checkout-independent startup. The temporary installation and
mount directories were removed on exit; no test DMG remained mounted.

## Limits

This is an unsigned local installation candidate, not a signed or notarized
public release. The update journey uses a loopback fixture and the pending
record; it does not prove a live HTTPS feed or binary-to-binary upgrade from a
preserved public installer. No Windows/native-Linux installation, platform
signing, contributor-rights, language, brand, source-rights or legal approval
is inferred. IR-13 stays **Open**; the earlier
[macOS DMG record](IR13-MACOS-DMG-2026-09-24.md) remains historical evidence
for different bytes.
