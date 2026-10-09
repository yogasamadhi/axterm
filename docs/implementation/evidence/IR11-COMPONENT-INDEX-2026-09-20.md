# IR-11 production component index — macOS arm64 evidence

Date: 2026-09-20  
State: **metadata coverage improved; third-party notice/SBOM gate remains open**

`THIRD_PARTY_COMPONENTS.json` is deterministically generated from the frozen
installed graph reported by `bun pm licenses --json --prod`. It records 125
distinct package name/version/license entries from 120 Bun report records.
`bun run licenses:components:check` is part of the default `bun run check` and
fails on drift or conflicting license declarations. The index is deliberately
a conservative production-dependency list, not an exact artifact SBOM or a
replacement for copyright and license texts.

The macOS arm64 app built from the no-`.git`, no-`vendor` source copy contains
the source-identical JSON outside `app.asar` and the same bytes in Settings →
About and licenses. Its ASAR inventory reports 89 package instances, including
three Axterm workspace packages; all 86 third-party manifest identities and
their declared license values occur in the source index. It reports no missing
package-level license metadata, 12 external legal files, and two published
packages without their own root LICENSE file (`@xterm/addon-serialize` and
`@devolutions/iron-remote-desktop-rdp`), both already mapped separately in the
transition notice. The package tests compare source/package/About bytes and
enforce the 86-package coverage against the **actual ASAR**.

The final updated source `bun run check` passes 817 unit tests (one skipped), the
component-index check, architecture/Contract/localization/build checks and
three visual/accessibility Playwright journeys. The unsigned DMG passed
`hdiutil verify`, mount, independent copy, detach and the complete packaged
journey (14 passed, nine platform/fixture skips). The first DMG test attempt
exposed a ZMODEM **test-peer** race: any first input could start binary output
before the E2E sent its explicit start byte. The peer now waits for `!`; a
real-PTY regression test sends an unrelated byte first, the focused packaged
ZMODEM journey passed five consecutive runs, and the complete DMG journey
passed afterward. This did not modify Axterm's packaged protocol engine.

Current artifact SHA-256 values:

| Artifact                                                   | SHA-256                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `THIRD_PARTY_COMPONENTS.json` in source and app            | `00cd2b503cd623fe958eee182149b90bc49ed65940c12c29bab4035d5480c8ce` |
| `THIRD_PARTY_NOTICES.txt` in source and app                | `77158e37beaa6916b16a823330755c5ab988251aa7a95b4efa55d0d127d396b2` |
| `release/Axterm-0.10.0-arm64.dmg`                          | `865f93cd6539c36173671c5cca9a080354d3318af049a00764d1828a65fa33cc` |
| `release/Axterm-0.10.0-arm64-mac.zip`                      | `6237e9b82020833e9c990ddbae134dbe8a8d8f4e05a097cbdc2bdf295441b11b` |
| `release/mac-arm64/Axterm.app/Contents/Resources/app.asar` | `69ab8b8ec1ddfe3e88178e18e0ebd447640931ec0ac58aa14f132bcf5ba479cb` |

Still required: exact applicable copyright/NOTICE text for every shipped
component; a source-to-binary map for inlined JavaScript, Electron/Chromium,
native binaries, WASM, fonts and other assets; LGPL/MPL distribution review;
Windows/Linux package and About checks; final clean-repository and qualified
rights sign-off. Manifest labels and this green macOS test do not close IR-02
or IR-11.
