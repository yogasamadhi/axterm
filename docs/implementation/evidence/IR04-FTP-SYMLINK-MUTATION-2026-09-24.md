# IR-04 FTP symlink mutation boundary — 2026-09-24

Status: **implementation and macOS packaged regression verified; IR-04 remains In progress**.

## Failure established before the fix

The independently authored FTP server canonicalized the complete pathname
for `DELE`, `RMD` and `RNFR`. A final-component symbolic link whose target was
also inside the granted root therefore identified the _target_ rather than
the link. The new real-FTP regression first failed on `DELE file-link`: the
server returned `250 File deleted` even though the command named a symlink,
and the referenced regular file was removed. The same path resolution also
allowed `RMD` to remove an empty target directory and `RNFR` to select a
target file for later renaming. This is a File Grant integrity issue, not an
outside-root escape.

## Correction and coverage

`DELE`, `RMD` and `RNFR` now use a mutation-specific path resolver. It
canonicalizes and confines the parent, then calls `lstat` on the final entry
and rejects a symbolic link before any mutation or rename-source selection.
Read-only commands retain their existing path behavior. The tests require all
three commands to fail for in-root links, the referenced file and empty
directory to remain intact, `RNTO` after a rejected `RNFR` to fail, and the
control connection to accept a following `NOOP`.

The focused real-FTP Adapter suite passed **26/26**. The pinned Linux Bun
source-runtime smoke passed on both `linux/arm64` and `linux/amd64`, including
the new `ftp-symlink-mutation-denial=pass` marker and the existing ASCII
restart, binary transfer, authentication, passive-socket and rename checks.

The current worktree's `bun run check` passed before the packaged-journey
assertions were added: 221 test files passed and 5 skipped; 1,097 tests passed
and 33 skipped; 359 architecture modules / 1,310 dependencies; 267 Contract
operations; independent-snapshot, license/SBOM, build/package-layout and all
11 visual/accessibility journeys. The packaged-journey test was then extended
with the same symlink denial checks and passed **1/1** against a fresh unsigned
macOS arm64 directory package outside the checkout. The actual Resources
matched its generated SPDX sidecar. A final full `bun run check` after all
source, test and documentation edits then passed with the same 1,097/33
unit-test result and all 11 visual/accessibility journeys.

| Evidence item               | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| FTP server source           | `b502e5d83fb68e4b65ea9474a31fb6198240d053817dc780df76822f5e60cf43` |
| Focused Adapter test        | `5fae84b2fd983f2f965e39133761b0bfe398ce2925a420435775954fa0ca0b13` |
| Linux source smoke          | `983a0dce49b462e14df9ece6eaa27a7f13cbb95abeb02fd209c0e737f4be09b3` |
| Packaged FTP journey        | `1c493be1d7d1688980b44cf655a7c08de00f1fb90f879f023c296d16397b6c5f` |
| macOS package `app.asar`    | `32af4d1743eb0d9fb32de6d6b7e2872860e26d8497f44b4d39567a5f5a5ee6b5` |
| macOS packaged SPDX sidecar | `f27f27d382af65bc16ea13ab13d17e5fecfc6693e5b11d334be6712a8e10c68d` |

## Linux x64 package candidate

An audited 820-file independent source snapshot (18,456,891 bytes; source-tree
SHA-256 `c712c27a14eb4b1b1f72b489a866ed2407d6ae1f985f296e3b2f23de054a7e06`)
was built under emulated Debian `linux/amd64` with Bun 1.4.0, Node 24.18.0,
frozen dependencies and the Electron 44.3.0 Linux x64 ZIP whose SHA-256
`8b49b9efdd73c0f467edc3c1cd5678392c384ccf224f34ff54179f736e2f384b`
was checked against the official release checksum file. The resulting
`app.asar` SHA-256 is
`d6e1c559782975ff6a8bbc9b22f22769704f5b9bd132c0ed65a2318e315dcf62`.
The unpacked and installed Resources matched the packaged SPDX sidecar
`904028b0fddf2f9ddc7f35a0664781a0e503f2aef1d22f4cf437638f3319d0ff`.

| Retained unsigned artifact                |       Bytes | SHA-256                                                            |
| ----------------------------------------- | ----------: | ------------------------------------------------------------------ |
| `axterm_0.10.0_amd64.deb`                 | 114,032,996 | `1d50cad03d24f6c4a2254c814992c8325749bc3d2c25373b88ce6f58e1467ba9` |
| `Axterm-0.10.0.AppImage`                  | 145,979,210 | `ce9d998ba699bc47fcea9be09dd1e01851a933c4ab559f10162644327acd1687` |
| `AXTERM_RELEASE_ARTIFACTS.linux-x64.json` |         791 | `460cb55e13ea0d29363caeebd6fdee137d538ba236eab0a3c1a8147aedfc786d` |

The disposable-container DEB install gate passed **23 applicable packaged
journeys**, including the extended FTP Widget path; eight Windows-only,
historical-binary or opt-in SSH journeys skipped. AppImage SquashFS extraction
and legal/SPDX comparison passed (offset `188392`). Copies of the four files
are retained in the ignored local directory
`release/axterm-linux-ftp-symlink-20260924/`; its copied release hash manifest
was checked again.

The first two full DEB suite attempts had one failure each at the first
`toBeFocused` assertion of the migration accessibility journey, while the
other 22 applicable journeys passed. That test passed when isolated and in a
nine-test prefix. The packaged test now explicitly brings its window forward
before each keyboard activation without removing the focus assertion. A third
full installed-suite run passed 23/23. The package was built before this
test-only foreground addition; production bytes were unchanged. The final
full run used a temporary diagnostic branch that would print DOM/window focus
state on failure; it did not print and did not alter product code or relax the
assertion. This emulated-host focus instability should remain visible to
native-Linux reviewers rather than be mistaken for proven platform stability.

## Remaining limits

The macOS package is unsigned and not an installed/notarized DMG. The Linux
container checks include source-level arm64/x64 and installed-package x64
under emulation, not a current native-Linux desktop run. The packaged symlink assertions are conditional on non-Windows hosts
because Windows symlink creation can require privileges; Windows installed
package evidence remains missing. Node's path-based operations still have a
small interval between the final filesystem check and mutation, and a
concurrent external actor could exchange an ancestor path during it. The
independent protocol/security and source-rights reviews must assess this
residual race. This evidence does not close IR-04 or IR-13.
