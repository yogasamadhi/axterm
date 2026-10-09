# IR-04 FTP resumed-upload source-handle cleanup — 2026-09-24

Status: **source, unsigned macOS package and emulated Linux x64 DEB
installation verified; IR-04 remains In progress**.

## Gap and correction

For `REST STOR`, the FTP server opens the existing source to validate the
restart offset before accepting a data connection. It closed that handle for
an invalid offset, but `FileHandle.stat()` or the TYPE A restart scan could
also reject. Those exceptions bypassed the close path, leaking a file handle
for each failed command while the control session remained usable. This is a
Runtime lifecycle defect, not a claim of a File Grant escape.

The validation now owns the handle in one `try`/`catch`: every failure after
open closes it before rethrowing the original error. Successful validation
still retains the handle for the streamed prefix copy and the existing
transfer-completion cleanup. The server's normal opener remains `node:fs/promises`;
the optional opener injection is only a narrow failure-test seam.

## Verification

The real TCP control-session regression injects `EIO` separately at `stat`
and at the TYPE A restart scan's `read`, then checks FTP `550`, exactly one
source-handle close, unchanged original bytes and a successful subsequent
`NOOP`. The read case failed before the correction (`closeCalls` was `0`,
expected `1`). After the correction, the complete real FTP Adapter file
passes **29/29** tests.

`bun run build` passed. A fresh unsigned macOS arm64 directory package was
built outside the checkout with
`node scripts/package-desktop.mjs --dir --output /tmp/axterm-ftp-restart-close-B6GFnA`.
Its Resources matched a generated packaged SPDX sidecar, and the packaged
FTP Widget journey passed **1/1** with the production server implementation.
That journey covers ordinary FTP transfers and existing containment cases;
the injected `EIO` branches are exercised at source level, not inside the
package.

| Item                        | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| FTP server source           | `3842552b42d3110ff9e77643e379359fb0340cf8414aa748a57f772918e98b7a` |
| Focused Adapter test        | `7b3b1c6e411d4cbd52366cef5cc39cb800f33871e9a67e93ffbfd8d1084e229d` |
| macOS package `app.asar`    | `7eb03521d2873b38a7472d9aecb647b6d62f6a36faf99e2a3b93d6b12f873482` |
| macOS packaged SPDX sidecar | `6260a993f1b0e23894e79769e55e6db9bf0396c10d32ce893db687b1c50cd428` |

## Linux x64 installed candidate

An audited 822-file / 18,482,944-byte independent source snapshot (tree
SHA-256 `0bedc88efd2cdad80e9953cc9b0138be1381d7614831f1f0eaf54a00f68d5159`)
was built under emulated Debian `linux/amd64` using Bun 1.4.0, Node 24.18.0,
frozen dependencies and Electron 44.3.0. The disposable build image ID was
`sha256:1e1de458eae85757064659d2a525e12391701a6792b785edac12ce65decfaff1`.
The Node tarball SHA-256 was
`55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742`;
the Electron Linux x64 ZIP matched its official release checksum
`8b49b9efdd73c0f467edc3c1cd5678392c384ccf224f34ff54179f736e2f384b`.
The pinned local `fpm` archive matched
`44b0ec6025c14ec137f56180e62675c0eae36233cdce53d0953d9c73ced8989f`.
Those local inputs were used because the container could not reliably fetch
GitHub-hosted builder tools.

The new DEB was installed through `sh scripts/test-linux-deb.sh
/output/axterm_0.10.0_amd64.deb` in a disposable x64 container with Python
GI/GTK 3 installed. Its actual `/opt/Axterm/resources` matched the generated
SPDX sidecar, including `app.asar` SHA-256
`8e8a56458133d9f7fbb1cefa3fa76bd29f509af65065c04573765d9bf9e402a5`.
The full installed suite passed **23 applicable journeys** and skipped eight
Windows-only, historical-binary or opt-in SSH journeys. The FTP Widget,
three terminal-transfer protocols, migration accessibility, GTK launcher icon
and independent startup journeys passed. The direct `EIO` injections remain
source-level regressions; the installed FTP journey exercises the production
server and its ordinary error/containment paths.

| Retained unsigned artifact                      |       Bytes | SHA-256                                                            |
| ----------------------------------------------- | ----------: | ------------------------------------------------------------------ |
| `axterm_0.10.0_amd64.deb`                       | 114,094,888 | `09ac6f6c9877d1c52683fe15755e0ec21de103a13de61258cab4f10845851b27` |
| `AXTERM_PACKAGED_ARTIFACTS.linux-x64.spdx.json` |     307,314 | `f63510288aa59c3193e66128a93b2c2bce9f3b7aed0ae4bcbf9d96285776eb03` |
| `AXTERM_RELEASE_ARTIFACTS.linux-x64.json`       |         629 | `11fed09c839000d22ac065eaf955143cabb9b5c11cdbcde354137a7971df9e3d` |

The three files are retained in ignored
`release/axterm-linux-ftp-restart-20260924/`; the copied release-hash manifest
was checked again against the retained DEB. This candidate is newer than the
bounded-list DEB cited in the earlier IR-04 record.

## Remaining limits

The macOS package is unsigned, locally generated and not an
installed/notarized DMG. The Linux DEB was installed under x64 emulation from
a macOS arm64 host, not on a native Linux desktop, and no AppImage was built
in this run. Windows/native-Linux installed-package and upgrade evidence remain
outstanding. The correction does not resolve path-operation races,
independent protocol/security and source-rights review, signing or final
distribution gates. IR-04 stays **In progress** and IR-13 **Open**.
