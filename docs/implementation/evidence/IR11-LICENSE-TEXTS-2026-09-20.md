# IR-11 installed-package root-license texts — macOS arm64 evidence

Date: 2026-09-20  
State: **root-file text coverage improved; IR-02/IR-11 remain unaccepted**

`THIRD_PARTY_LICENSE_TEXTS.json` is generated from the frozen installed Bun
production graph, without reading `vendor/legacy-prototype`. It records the exact
UTF-8 contents and SHA-256 of 119 root `LICENSE`/`LICENCE`/`COPYING`/`NOTICE`
files across 125 package name/version entries. The default `bun run check`
verifies the archive against the installed package paths. The generated file
does not store machine-specific paths. It explicitly lists six packages
without a published root license file:

- `@devolutions/iron-remote-desktop-rdp@0.7.0`
- `@hono/zod-openapi@1.6.3`
- `@hono/zod-validator@0.9.1`
- `@xterm/addon-serialize@0.14.0`
- `@xterm/headless@6.0.0`
- `drizzle-orm@0.45.2`

The existing separate xterm.js source mapping and selected Apache-2.0
Devolutions notice are not silently treated as complete mappings for all six.
The absence of a root file is an explicit review item, not a finding that the
package is unlicensed.

A fresh source copy at `/tmp/axterm-license-texts.Z2Isya` excluded `.git`,
`vendor`, installed modules, prior builds and local databases. Their absence
was checked before the frozen install and again before the independent check.
`bun install --frozen-lockfile`, `bun run licenses:texts:check`, and unsigned
macOS arm64 `bun run package:dir` passed. The complete packaged-app suite
passed 14 journeys with nine platform/fixture-conditional skips. A subsequent
unsigned DMG/ZIP build passed `hdiutil verify`; its app was mounted, copied
outside the checkout, detached and passed the same complete 14-journey
packaged suite with nine conditional skips. Its legal
tests compare the archive byte-for-byte with the source, require every actual
ASAR package manifest to be represented, compare every ASAR root-license-file
hash with the archive, and read three different package texts in the app's
About and licenses view. The final ASAR has 89 package manifests, no missing
package-level license metadata, and 13 external legal files. Two actual ASAR
packages lack an internal root license file; both are present in the archive's
six-package review queue. Both the source and isolated-copy `bun run check`
passed 820 unit tests (one skipped), Level 1/Contract/localization/component/text
drift gates, production build and three visual/accessibility Playwright
journeys.

| Artifact                                                         | SHA-256                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `THIRD_PARTY_LICENSE_TEXTS.json` in source and app               | `cdc699c5ded292768f1ec15ee2cde0f40c3357022bf2389cbed79a37c17bfbef` |
| `THIRD_PARTY_NOTICES.txt` in source                              | `a115ea38b9bb690a9b84e54808ab91198eed7aba8d04045e06ae44994ec88f51` |
| `package:dir` `app.asar` before the DMG rebuild                  | `284cdab3a48618cb307500cdcf77a3ca52a5a657d7e47f8a435a11ca7f7aa423` |
| Final `release/mac-arm64/Axterm.app/Contents/Resources/app.asar` | `74e23d319a5076728798fa91888f59614f6d9e8c1addc00818c65238cb95ce99` |
| `release/Axterm-0.10.0-arm64.dmg`                                | `b22213ed09ef96047fb6b025390fd43c0b4782a7e5dead831de39d0595d33b32` |
| `release/Axterm-0.10.0-arm64-mac.zip`                            | `101d3fe58e646e0b8193f02ee34bc855286c99e80a824e32c650df8ff7b25211` |

This is **not** a complete license/NOTICE bundle or artifact SBOM. Root files
can omit nested or file-level notices, and production-graph packages do not
exactly equal bundled JavaScript/native/Electron contents. The six missing
root files need verified source mappings; LGPL/MPL source-availability and
distribution duties, asset/font/WASM provenance, Windows/Linux packages,
installed upgrade, and qualified rights review remain open. The app and
archive still identify third-party sources honestly during the migration
period.
