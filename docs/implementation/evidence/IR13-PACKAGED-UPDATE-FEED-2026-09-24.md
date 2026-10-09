# IR-13 packaged update-feed trust root — 2026-09-24

Status: **source and unsigned macOS arm64 directory package verified; IR-13
remains Open**.

## Gap and correction

Before this work, Axterm's updater was configured only by Desktop Host process
environment. A normal installed application with no externally supplied
variables therefore had no fixed public update feed or key. That was suitable
for integration fixtures but not a reproducible commercial release.

The root `UPDATE_FEED_RECORD.json` is now the source-controlled, non-secret
release record. Its current `pending` state deliberately carries no URL or
key. An `active` record must contain a real public HTTPS manifest URL, an
Ed25519 SPKI public key, and a dated release-owner approval with evidence.
`release:updater-feed:active-check` rejects the current pending state; the
final-public promotion gate includes it as a prerequisite. The ordinary
`bun run check` runs the structural check without pretending that a public
feed exists.

Electron-builder copies the record into `AXTERM_UPDATE_FEED.json` under each
platform's app Resources. A packaged active record takes precedence over
runtime environment values, so those values cannot replace a released app's
pinned trust root. A missing or malformed packaged record reports
`UPDATE_CONFIGURATION_INVALID`. A pending development package can still use
an explicit environment-backed local integration fixture. The installed
macOS DMG, Linux DEB and Windows NSIS gates and packaging CI now compare the
packaged file byte-for-byte against the reviewed source record; an optional
`--active` form also enforces public-feed approval.

## Verification

- Focused update-feed record, updater, final-public and documentation tests
  passed **31/31**. The tests cover pending versus active promotion, public
  HTTPS/key/approval validation, package byte mismatch, missing package
  record, and precedence over hostile runtime environment values.
- `bun run build` passed. A fresh unsigned macOS arm64 directory app was built
  under `/tmp/axterm-update-feed-UANiMN/mac-arm64/Axterm.app`.
- `bun run release:updater-feed:package-check --
/tmp/axterm-update-feed-UANiMN/mac-arm64/Axterm.app/Contents/Resources`
  passed. The source and packaged feed record both have SHA-256
  `ce4f3e7a03e4b6239d0c972629292f7703bb6bb5c568275b2d5ffd7a0d1acdc9`.
- The new package's signed-updater journey passed **1/1** using a local
  Ed25519-signed loopback fixture. Its Resources matched a generated packaged
  SPDX sidecar: sidecar SHA-256
  `7cdc3d5718966e36781af2fab0fe95047e1c557da5d1fe9d5a65bab59dcf8ed1`,
  `app.asar` SHA-256
  `ad751ce14a0db32ee4c65c0883299a89483dc6d3798632c29ff306b343637b6b`.
- `bun run release:updater-feed:check` passes; the active check exits 1 with
  `Public update-feed configuration is still pending`, as required.

| Source                        | SHA-256                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| Desktop updater               | `5954e2bd140643d574ce5cc04c512bc0dc6fe4207904141a907d3ffcb133d06b` |
| Update-feed record gate       | `e53b2cd2591e76b9806241c38437083da71275a138133cc336378513ac97b594` |
| Packaged-record byte verifier | `9715622221b151d3c76e13f9b499da0f6328a46f348fc5e5061dd1565edd8e4c` |

This local package is unsigned and not an installed/notarized DMG. Windows and
Linux resource copying, installed checks and CI are code-level changes only
until their actual platform runners pass. No real feed domain, public key,
private signing identity, downloaded installer, signed update or old-to-new
installed upgrade is claimed. The release owner must fill and approve the
record, verify exact final package bytes on all platforms, and retain public
HTTPS and upgrade evidence before IR-13 can be accepted.
