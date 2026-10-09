# IR-11 packages without published root license files

Date: 2026-09-20  
State: **source mappings improved; six package-internal omissions remain visible**

The generated `THIRD_PARTY_LICENSE_TEXTS.json` reports six installed production
packages without root `LICENSE`/`LICENCE`/`COPYING`/`NOTICE` files. This record
separates verified upstream text from mere package-level license labels. It
does not reclassify a missing package file as present, nor does it certify
published-bundle source lineage or legal compliance.

| Installed package                            | Source evidence and local text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Remaining question                                                                                                                                                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@xterm/addon-serialize@0.14.0`              | Its manifest pins xterm.js commit [`f447274`](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/LICENSE); the installed `src/SerializeAddon.ts` was previously matched to that commit. Exact root MIT text is `licenses/xterm-addon-serialize-LICENSE.txt`, SHA-256 `b569f629d00f2626a8100df2a1798210535621e42164dfd426a6fe5aac7b0ccd`.                                                                                                                                                                                        | Other included file-level attribution and final platform contents.                                                                                                                                                                                     |
| `@xterm/headless@6.0.0`                      | The official [xterm.js 6.0.0 release tag](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0) resolves to the same `f447274` commit and its root MIT text has the same hash, so the existing local exact text is referenced in `THIRD_PARTY_NOTICES.txt`.                                                                                                                                                                                                                                                                                                  | The tag's checked-in [`headless/package.json`](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/headless/package.json) still says `5.5.0`; verify the 6.0.0 npm publication/build step and bundle lineage separately. |
| `drizzle-orm@0.45.2`                         | Official [tag `0.45.2`](https://github.com/drizzle-team/drizzle-orm/tree/273c78071d4841b497f5144734b38294df7ec64b) has a matching [`drizzle-orm/package.json`](https://github.com/drizzle-team/drizzle-orm/blob/273c78071d4841b497f5144734b38294df7ec64b/drizzle-orm/package.json) and a root [Apache-2.0 LICENSE](https://github.com/drizzle-team/drizzle-orm/blob/273c78071d4841b497f5144734b38294df7ec64b/LICENSE), copied byte-for-byte to `licenses/drizzle-orm-LICENSE.txt`, SHA-256 `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`. | Verify published compiled JavaScript and any file-level notices against the tagged source.                                                                                                                                                             |
| `@hono/zod-openapi@1.6.3`                    | Official matching [tagged package manifest](https://github.com/honojs/middleware/blob/bc7d9e67119f870b5275569b371676663c74c976/packages/zod-openapi/package.json) declares MIT. The complete [tagged source tree](https://api.github.com/repos/honojs/middleware/git/trees/bc7d9e67119f870b5275569b371676663c74c976?recursive=1) has no root or nested legal file matching LICENSE/COPYING/NOTICE (871 entries, not truncated).                                                                                                                                | Establish exact copyright notice and distribution text with publisher/qualified rights review; do not invent an owner from the SPDX label.                                                                                                             |
| `@hono/zod-validator@0.9.1`                  | Official matching [tagged package manifest](https://github.com/honojs/middleware/blob/8de0f1ea32b76d40df0ec4a06ed5af2e100ccbfd/packages/zod-validator/package.json) declares MIT. The complete [tagged source tree](https://api.github.com/repos/honojs/middleware/git/trees/8de0f1ea32b76d40df0ec4a06ed5af2e100ccbfd?recursive=1) likewise has no legal file (870 entries, not truncated).                                                                                                                                                                    | Same exact-notice and publisher/rights review.                                                                                                                                                                                                         |
| `@devolutions/iron-remote-desktop-rdp@0.7.0` | The installed manifest declares `MIT OR Apache-2.0`; `THIRD_PARTY_NOTICES.txt` records the selected Apache-2.0 distribution option and packaged full text.                                                                                                                                                                                                                                                                                                                                                                                                     | Confirm exact source-to-published JS/WASM lineage, additional file-level notices and live RDP behavior.                                                                                                                                                |

The xterm.js and Drizzle texts now appear in the app's About and licenses view
and in the package's `licenses/` directory. The Hono entries remain explicit
missing-text exceptions, not accepted notices. The root-file archive's six
missing entries therefore remain unchanged by these source mappings. IR-02
and IR-11 stay **In progress** pending a full package/source/artifact rights
review on macOS, Windows and Linux.

For Drizzle, three installed JS source-map `sourcesContent` samples were also
compared byte-for-byte with the corresponding official `0.45.2` tagged
TypeScript files. The matching SHA-256 values are:

- `src/index.ts`: `cc0da45244d87553b49ff5df0e2e90b61fc7aed4980a7fe8524879bf9be20c34`
- `src/sqlite-core/index.ts`: `2326471de09d72a35ca9abd7ff3abcc41696b03b9023037ff95ac55d85ae0319`
- `src/sqlite-core/dialect.ts`: `fcc401a3f3e40ce865b3da9fc2c13bca2ede65a882a72fccd231c539003e1bb5`

A unit test pins the installed copies. These three matches strengthen the
version mapping but do **not** establish full compiled-bundle provenance.

An unsigned macOS arm64 `package:dir` was built in a fresh source copy at
`/tmp/axterm-license-map.uN8uS9` after a frozen install; `.git` and `vendor`
were absent. The complete packaged suite passed 14 journeys with nine
platform/fixture-conditional skips. The package-file and About tests include
the new Drizzle text and compare all exposed legal files byte-for-byte with
the source. The app inventory reports 89 ASAR package manifests, zero missing
license metadata and 14 external legal files. Its two ASAR packages without
an internal root license are still reported, rather than hidden by the
external mappings.

The final source `bun run check` passes 825 unit tests (one skipped), Level 1
architecture, 256-operation Contract, component/license-text drift,
localization and production build checks, plus three visual/accessibility
Playwright journeys.

| Artifact                                                   | SHA-256                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Source and packaged `licenses/drizzle-orm-LICENSE.txt`     | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| Source and packaged `THIRD_PARTY_NOTICES.txt`              | `380441cfd21b7ccaa505aabb217cc409c7bd5101fe8dc3ca0709c6b2dbdb3e6d` |
| `release/mac-arm64/Axterm.app/Contents/Resources/app.asar` | `a07bb62faa14b9cc6e9ecbf2d99605afb245a0c8d0e740ee9ba32f326f42e585` |

This is a local unsigned directory app, not signed/notarized macOS, a tested
Windows/Linux installer or qualified legal sign-off.
