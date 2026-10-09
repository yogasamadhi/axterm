# IR-13 current Linux x64 AppImage static payload — 2026-09-24

Status: **same-source AppImage built and statically verified; native launch and IR-13 acceptance remain open**.

## Source and toolchain

This AppImage was built from the same audited 832-file independent source
snapshot (tree SHA-256
`2d855e4fd43efd6f0c6172b36b8668625cbcd768ae309c7e9d3602bd194453c2`)
as the [current installed Linux DEB](IR04-FTP-READ-HANDLE-LINUX-DEB-2026-09-24.md).
The emulated Debian `linux/amd64` builder used the same frozen Bun install,
Node 24.18.0 native-module rebuild, production output and verified Electron
44.3.0 Linux x64 ZIP. The legacy FUSE2 AppImage toolset
`appimage-12.0.1.7z` came from the official electron-builder-binaries
release and matched the exact SHA-256 pinned in the installed
`app-builder-lib@26.16.1` source:
`d12ff7eb8f1d1ec4652ca5237a7fbdca33acc0c758045636feca62dc6ecb8ec4`.
It was seeded into an isolated builder cache; the production AppImage build
completed with an embedded block map.

## Static artifact proof

`bun run test:appimage:linux -- --artifact-dir ... --sidecar ...` located the
embedded SquashFS at byte **188,392**, extracted it without executing the x64
runtime, verified the required legal entries and compared the exact extracted
Resources to its SPDX sidecar. Its `app.asar` SHA-256 is
`2fb7e8055aea2c1f2e35901060ec6e1d24a736757db19e232bff620a445e0fe1`.
The sidecar bytes are identical to those of the separately built and installed
DEB; this proves the inventoried resource set matches, not that both launchers
have equivalent runtime behavior. The retained release hash manifest was
verified after copying.

| Retained unsigned artifact                      |       Bytes | SHA-256                                                            |
| ----------------------------------------------- | ----------: | ------------------------------------------------------------------ |
| `Axterm-0.10.0.AppImage`                        | 146,064,823 | `a5a0b35309e79f1910a92bfd53ec2866b2631ef77969eee1c84fdd2554dcc47d` |
| `AXTERM_PACKAGED_ARTIFACTS.linux-x64.spdx.json` |     307,314 | `3ae235610f611d0466b9501b96d6b31cde889b79a525c3a2b2014fb83db2f898` |
| `AXTERM_RELEASE_ARTIFACTS.linux-x64.json`       |         629 | `3cf1ab00a00916b333ddf52327aab26dc8a7dc0939172ac0397ba3f2ed660e5c` |

The three files are retained in the ignored local directory
`release/axterm-linux-appimage-read-handle-20260924/`. The DEB has a separate
retained hash manifest; these are two independently built artifacts tied to
the same audited source snapshot and identical packaged resource inventory.

## Runtime probe and limits

A direct `APPIMAGE_EXTRACT_AND_RUN=1` version probe in the emulated x64
container did **not** start the AppImage. The shell fallback reported binary
parse errors, and direct loader invocation reported `ELF file ABI version
invalid` before Axterm code ran. The AppImage file is an x86-64 ELF with the
expected embedded SquashFS and passes the static payload check; this result
does not establish whether the AppImage runtime works or fails on a native
Linux x64 desktop. It must be tested there, with launcher, deep-link, update,
external SSH and upgrade journeys as applicable. No native execution,
signature, public download, source-rights or release-owner approval is
claimed. IR-13 remains **Open** and the matrix remains **2/14 Accepted**.
