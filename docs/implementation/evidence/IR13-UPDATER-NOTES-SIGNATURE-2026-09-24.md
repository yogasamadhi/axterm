# IR-13 signed updater manifest-note authentication — 2026-09-24

Status: **source, production Electron and unsigned macOS arm64 directory package
verified; IR-13 remains Open**.

## Gap and correction

The manifest has a `notes` field, but the prior six-field Ed25519 record did not
include it. A feed intermediary could alter that text while retaining a valid
artifact signature. The current UI exposes only updater status, not the notes;
this closes an authentication gap before a controlled public feed is approved,
not an observed user-facing exploit.

`canonicalManifestRecord` now appends `JSON.stringify(manifest.notes)` as a
seventh LF-separated field. JSON string encoding keeps embedded line breaks
unambiguous. The published signer instructions in `SIGNED_UPDATE_FEED.md` use
the same seven-field record; the old six-field format is intentionally rejected.
Both source and packaged Electron update fixtures now sign with the shared
canonical-record implementation instead of hand-maintained copies.

## Verification

- The focused updater file passes **20/20** tests. A new test signs multiline
  notes, changes only the served notes, and verifies `UPDATE_SIGNATURE_INVALID`.
  The former six-field implementation would have accepted that altered text.
- `bun run typecheck`, `bun run build`, and the production Electron `H12 signed
updater` journey passed.
- A fresh unsigned macOS arm64 directory app was built under
  `/tmp/axterm-updater-notes-O4E9dt/mac-arm64/Axterm.app`. Its packaged signed
  updater journey passed **1/1** using a local Ed25519-signed loopback fixture.
- The packaged Resources matched a generated SPDX sidecar. Sidecar SHA-256:
  `6e02ea640c608893aecfc8c7d4042d92b144c93d1c7e949c8c665f5d00a7db89`;
  `app.asar` SHA-256:
  `144dc4beaebfca189ed7cefdf093b00da8a9d923e1e1846ee55eb80a17306403`.

| File                        | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| Updater source              | `6bbe1fcb3a2f3668183438fa4f425c6bb354b8a081a1057df2a24306e7bcef71` |
| Focused unit test           | `f3754a1071970819ed3ac195b83274336b258622e3170a387aa632be674f44ed` |
| Production Electron fixture | `f674c33246666ac4643cde902cb04eb992551482f6c078e013babdf44b0938bb` |
| Packaged Electron fixture   | `9a8e50e7297d999b1f855b63c18b3cc729719e9600072439ccaf5497d0a56aea` |

The package is unsigned and not an installed/notarized DMG. The fixture uses
loopback HTTP, not a controlled public HTTPS feed. No signing identity, final
release notes, real installed binary-to-binary upgrade, Windows or native-Linux
result is claimed. IR-13 remains **Open**.
