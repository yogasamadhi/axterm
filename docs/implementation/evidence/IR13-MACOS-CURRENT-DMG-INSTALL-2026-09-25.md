# IR-13 current macOS DMG independent-install journey — 2026-09-25

Status: **unsigned macOS arm64 engineering candidate verified; IR-13 remains Open**.

The current source passed `bun run check` after the FTP active-data timeout
regression was added. Only then was a new `0.10.0` macOS arm64 ZIP and DMG
created with `scripts/package-desktop.mjs`. That order matters: the packaging
script rebuilds native modules but does **not** rebuild the TypeScript/Electron
application output. The earlier
[active-stall directory-package trial](IR04-MACOS-FTP-ACTIVE-STALL-2026-09-25.md)
did not prove this build order and is superseded for current-source packaged
identity by this candidate.

The local unsigned DMG passed `hdiutil verify`, read-only mount, `ditto` copy
into a separate temporary install directory and detach before launch. The
installed `Axterm.app` preserved the migration-period `axterm://` and
`legacy-prototype://` URL declarations. Its actual `Contents/Resources` matched the
generated macOS arm64 SPDX sidecar byte-for-byte; its bundled update-feed
record passed the package-record check. The update-feed record is still
**pending**, not a public active service.

The installed-copy Playwright suite passed **23 applicable tests, 14 conditional
skips** in 3.4 minutes. For this run, all three opt-in FTP modes were enabled
in the same installed-app journey: a 32-second upload, a 36 MiB rate-limited
download, passive upload stall/cleanup and active upload stall/cleanup. The
FTP journey passed **1/1**. Applicable packaged checks also covered native
module loading/publication, four Electron locale families, TRZSZ/ZMODEM/
XMODEM local-PTY transfers, About/legal files, accessibility and three
viewports, custom-theme and independent-format migration, IronRDP startup,
updater behavior, host-key review and prior-schema/Vault upgrade.

```sh
node scripts/package-desktop.mjs \
  --output /tmp/axterm-macos-current-dmg.2kk8Po
bun run sbom:packaged \
  /tmp/axterm-macos-current-dmg.2kk8Po/mac-arm64/Axterm.app/Contents/Resources \
  --platform macos-arm64 \
  --output /tmp/axterm-macos-current-dmg.2kk8Po/AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json
AXTERM_PACKAGED_FTP_LONG_TRANSFER=1 \
AXTERM_PACKAGED_FTP_STALLED_TRANSFER=1 \
AXTERM_PACKAGED_FTP_ACTIVE_STALLED_TRANSFER=1 \
bun run test:dmg:macos \
  /tmp/axterm-macos-current-dmg.2kk8Po/Axterm-0.10.0-arm64.dmg
```

`release:hashes:check` rehashed both distributables against a generated
platform-scoped manifest. The exact local artifacts are:

| Item                           | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `Axterm-0.10.0-arm64.dmg`      | `aaf99221aed3c1749acc48261dd7427f0c8cd0f40b77298368558df0846661a8` |
| `Axterm-0.10.0-arm64-mac.zip`  | `93a0b62b53c378bbb23eae4ec1b2c3f17188aef3dacc754c7020017c5d11f6b4` |
| Installed app `app.asar`       | `01e2fa75cc7b674cb4f7561ad336127c47512219aa4faf6aa3099ca60f69bb20` |
| Verified packaged SPDX sidecar | `eb4af5a7aac8d9b7124af7f9bcfea1adecd277c6bef935ea9001d84499a192de` |

The 14 skipped cases are conditional real-volume transfer tests (3), Linux
package tests (3), Windows package tests (6), historical-packaged-app upgrade
(1) and external SSH fixture (1). Some have separate earlier records, but this
candidate's 23/37 result does not include them. This is an unsigned,
unnotarized **local** candidate; it is not a public download, a signed
installer, an active authenticated update feed, a public stable migration
release, a customer-data upgrade, native Windows/Linux proof or legal/design
acceptance. IR-13 remains **Open** and IR-08/IR-11 remain unaccepted.
