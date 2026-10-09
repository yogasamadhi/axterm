# IR-04 FTP bounded directory listing — 2026-09-24

Status: **implementation, macOS package and emulated Linux x64 DEB installation
verified; IR-04 remains In progress**.

## Gap and correction

The independently implemented local FTP server declared a 1,000-entry
directory limit, but `LIST`, `NLST` and `MLSD` first used `readdir` to load
every entry before checking the array length. A large authorized directory
could therefore consume memory proportional to its full entry count before
the limit took effect. The server now iterates with `opendir` and a 32-entry
buffer, stores at most 1,000 names, and returns FTP `550` when it encounters
entry 1,001. The output generation retains the existing limit and skips
symbolic links and internal staging files as before. Early rejection exits
the async iterator and closes the directory handle.

## Reproduction and observed results

| Check                                                                                                                                                                                                      | Result                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bunx vitest run packages/runtime/src/adapters/widget/widget-server-adapters.test.ts`                                                                                                                      | 27/27 passed. The new real-FTP regression rejects 1,001 entries for each of `LIST`, `NLST` and `MLSD`, accepts `NOOP` after each rejection, and lists exactly 1,000 entries after removing one. |
| `AXTERM_LINUX_FTP_TEST_PLATFORM=linux/arm64 bun run test:ftp:linux-container`                                                                                                                              | Passed, including `linux-arm64-ftp-bounded-list=pass max=1000`.                                                                                                                                 |
| `AXTERM_LINUX_FTP_TEST_PLATFORM=linux/amd64 bun run test:ftp:linux-container`                                                                                                                              | Passed, including `linux-x64-ftp-bounded-list=pass max=1000`.                                                                                                                                   |
| `bun run build` and `node scripts/package-desktop.mjs --dir --output /tmp/axterm-ftp-bounded-package-Lx58xw`                                                                                               | Passed; built a new unsigned macOS arm64 directory package outside the checkout.                                                                                                                |
| `AXTERM_PACKAGED_APP=/tmp/axterm-ftp-bounded-package-Lx58xw/mac-arm64/Axterm.app bunx playwright test --project=packaged -g 'packaged FTP Widget runs the independent server outside the source checkout'` | 1/1 passed. The packaged test exercises all three listing verbs, recovery, the exact 1,000-entry boundary and the existing transfer, rename, symlink, curl and lifecycle path.                  |

| Evidence item            | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| FTP server source        | `7e47540f573c2beb69815ca6dea82cd8001ad24c2ccc621a0de65b01082a03ad` |
| Focused Adapter test     | `193e1327ab9713392015dedf52c1dbd7f27949c809f4531a2ed9ce962cac9597` |
| Linux source smoke       | `df6e0cb29e7f29fdfed61e9201b6ebe805a02405878dfb4863e82bb1af9b2c3a` |
| Packaged FTP journey     | `160877db00d49c0915e4e6dd40335eedd671e4a1af196671b6427d719b49b56c` |
| macOS package `app.asar` | `f443b4e1ebd8bff89af775104f4664f07dfed8dcc2371dcc9e71fee784b384f2` |

The complete `bun run check` passed after the code and test changes: 221 test
files passed / 5 skipped; 1,098 tests passed / 33 skipped; 359 architecture
modules / 1,310 dependencies; 267 Contract operations; source-snapshot,
license/SBOM, build/package-layout and all 11 visual/accessibility journeys.

## Linux x64 installed candidate

The current independent source snapshot first passed its 821-file audit
(`18,470,545` bytes; source-tree SHA-256
`f9f763a9b0217407e7837fdff24f578ded76718db5e67d171588a9ef18d4c49f`).
Under emulated Debian `linux/amd64`, Bun 1.4.0 installed frozen dependencies,
Node 24.18.0 built the desktop and Runtime, and electron-builder 26.16.1
packaged Electron 44.3.0. The Node tarball SHA-256 was
`55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742`;
the Electron Linux x64 ZIP matched its official `SHASUMS256.txt` entry
`8b49b9efdd73c0f467edc3c1cd5678392c384ccf224f34ff54179f736e2f384b`.
The builder's pinned Linux x64 `fpm` archive matched its declared SHA-256
`44b0ec6025c14ec137f56180e62675c0eae36233cdce53d0953d9c73ced8989f`.
The package used the verified local Electron ZIP and `CUSTOM_FPM_PATH` to
avoid inaccessible GitHub downloads from the container.

| Retained unsigned artifact                      |       Bytes | SHA-256                                                            |
| ----------------------------------------------- | ----------: | ------------------------------------------------------------------ |
| `axterm_0.10.0_amd64.deb`                       | 114,095,564 | `2cdbee3944a1e5fc614235438444773e6b2821475a6b03cc5309f82e278875a0` |
| `AXTERM_PACKAGED_ARTIFACTS.linux-x64.spdx.json` |     307,314 | `eea4b8ff07614da46bbc76c7fa8953677733fb28924bb6870ad0cc8afe773781` |
| `AXTERM_RELEASE_ARTIFACTS.linux-x64.json`       |         629 | `039d5d6d5e023f6dd014d8fa02f29c5c115a6affe3b3df4f0b5ce584f7f5650c` |

The installed `/opt/Axterm/resources` matched the SPDX sidecar, including
`app.asar` SHA-256
`95251e4d9e28e1220f87af2db8043cd8644b3a3082a4a88e1fdab0fbfc745f26`.
The exact DEB was installed in a disposable container by
`sh scripts/test-linux-deb.sh /output/axterm_0.10.0_amd64.deb`. Its packaged
suite passed **23 applicable journeys** and skipped eight Windows-only,
historical-binary or opt-in SSH journeys. The FTP journey included all three
over-limit listing commands, recovery and the exact 1,000-entry boundary.
After copying the three files into ignored
`release/axterm-linux-ftp-bounded-20260924/`, `bun run release:hashes:check`
again verified the retained DEB against its manifest.

The Linux install gate previously forwarded only `AXTERM_PACKAGED_APP`, so
the GTK launcher-icon journey looked for a default `release/` DEB and silently
skipped when the candidate was in an isolated directory. The gate now forwards
the resolved `AXTERM_DEB_PATH` and checks its Python GI/GTK 3 prerequisite;
the journey ran and passed against the installed candidate. The gate regression
unit suite passed 9/9. These test/gate-only changes were exercised from a
second audited snapshot (821 files, source-tree SHA-256
`8b8c8073ff592a28cb998b6af74564a2e11d81fa3c4f409e1cd1188ba0f346cf`);
the packaged product bytes did not change between snapshots.

Intermediate runs are not counted as passing evidence: the first DEB attempt
could not download Electron in the container, and AppImage plus DEB toolset
attempts could not download from GitHub; verified local ZIP and `fpm` inputs
resolved the DEB build. The first installed suite skipped the icon journey
because of the path mismatch. A later run exposed missing source-side renderer
build output for the legal test, absent Python GI for the now-active icon test,
and the previously observed intermittent emulated-host focus failure in the
migration accessibility journey. After adding the test prerequisites and
building the source-side renderer, the final full suite passed **23/23** with
the original focus assertion intact.

## Limits

The Linux source and installed-DEB checks ran in containers under x64 emulation
from a macOS arm64 host, not a native Linux desktop or upgrade. The AppImage
target did not complete in this run and is not credited as current evidence.
The macOS package is a local, unsigned directory build, not a signed/notarized
installation. Windows packaged behavior and independent FTP protocol/security
and source-rights reviews remain open. This correction addresses enumeration
memory growth from `readdir`; it is not a complete proof of all FTP resource
bounds or File Grant race freedom and does not close IR-04 or IR-13.
