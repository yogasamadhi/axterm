# IR-04 FTP ASCII leading restart boundary — 2026-09-24

Status: **engineering regression fixed and packaged paths revalidated; IR-04 remains In progress**

## Failure and fix

The existing NVT-ASCII `REST STOR` regression covered every transfer-octet
offset, but its fixture began with an ordinary `A` byte. Changing the fixture
to begin with a local newline exposed the missing boundary at `REST 1`: the
client resumes after the first network CR of the leading CRLF, which maps to
**zero complete local prefix bytes**. Before the fix, the focused Vitest case
received `550 Requested action failed` instead of `226 Transfer complete`.
The upload path attempted to create a file read stream with `end: -1`.

`NodeLocalFtpServer` now copies the existing file prefix only when its mapped
local length is greater than zero. At zero it opens the staging file with
exclusive creation (`wx`) for the incoming bytes; with a nonzero prefix it
appends after copying that prefix. The existing parent/source identity checks,
atomic rename and failure cleanup remain in the same upload path. The unit
fixture still checks every offset and now includes a leading CRLF, later CRLF
and CR-NUL. It passes all 25 FTP adapter tests.

## Cross-platform source and packaged checks

The pinned Bun source-runtime container smoke passed on both Linux arm64 and
Linux x64. Its real FTP control/data sockets now exercise ASCII `REST STOR`
offsets **1, 4 and 7**, respectively inside the leading CRLF, later CRLF and
CR-NUL; binary transfer, authentication denial, passive-socket lifecycle,
rename and symlink rejection still pass:

```text
linux-ftp-nvt-ascii-rest=pass offsets=1,4,7
linux-arm64-ftp-rename-overwrite=pass
linux-arm64-ftp-pasv-lifecycle-smoke=pass bytes=8196
linux-ftp-nvt-ascii-rest=pass offsets=1,4,7
linux-x64-ftp-rename-overwrite=pass
linux-x64-ftp-pasv-lifecycle-smoke=pass bytes=8196
```

The repaired current working tree passed `bun run check`: 221 test files
passed, 5 skipped; 1,096 tests passed, 33 skipped; 359 architecture modules
and 1,310 dependencies; all 267 Contract operations; production build and
package-layout checks; all 11 Axterm visual/accessibility journeys.

An unsigned macOS arm64 directory package passed the focused packaged FTP
Widget journey **1/1** after its Resources matched a generated SPDX sidecar.
The package's `app.asar` SHA-256 was
`7190018b5bfe2a68f14c9d3249e0c7531580497b8b4b4d18e27b58d97054f4c7`;
the sidecar SHA-256 was
`1c6cd73142a05b2e8050139d1a7c2c9b0f88b7abb726aa91d56f27721768d990`.
That journey exercises real binary and curl ASCII upload/download and Widget
shutdown; the exact leading `REST 1` assertion is in the focused unit and
Linux source-runtime smoke.

## Current Linux x64 package candidate

The independent snapshot prepared **after** the fix passed its audit with 818
source files, 18,442,097 bytes and source-tree SHA-256
`9b9cc536767e61e807fc7b7f55f5445af2169e89de02f9306ab317cd50853d84`.
Under Docker Desktop's emulated Debian `linux/amd64`, the local builder image
`sha256:1e1de458eae85757064659d2a525e12391701a6792b785edac12ce65decfaff1`
used Bun 1.4.0, Node 24.18.0, frozen dependencies and the official
Electron 44.3.0 Linux x64 ZIP verified against its release SHA-256. The
packager's offline checksum-cache filename was corrected to
`SHASUMS256.txt-44.3.0`; a direct `@electron/get` diagnostic then reported a
cache hit and returned the already verified ZIP without a network fetch.

| Artifact                                        |       Bytes | SHA-256                                                            |
| ----------------------------------------------- | ----------: | ------------------------------------------------------------------ |
| `axterm_0.10.0_amd64.deb`                       | 114,031,288 | `de748d03af35dc89ea0085a6f4dd8ee6ccb3014480ede79f4dde3ac769e3ab81` |
| `Axterm-0.10.0.AppImage`                        | 145,978,823 | `fe99342872a7fe5364b35f7b3f18e48c53c40132674767d9bcad06c39185d4ab` |
| `AXTERM_PACKAGED_ARTIFACTS.linux-x64.spdx.json` |     307,314 | `d5e050bf0d2daa810a4c83f1d68561abf1a0daf4bc012e94e3af4f3ecdb417ae` |
| `AXTERM_RELEASE_ARTIFACTS.linux-x64.json`       |         791 | `7d1f94bb51416faa1112a06596db96728ef605a77b24793c2df3c627a5e0bb65` |

The unpacked and installed `app.asar` SHA-256 was
`dbad0f971d322497b88407c96dd6f0d24095a5fa5c95195b7cf4770b6d3ca92f`.
The DEB was installed into `/opt/Axterm` in a disposable container and its
Resources matched the SPDX sidecar. All 23 Linux-applicable packaged journeys
passed, including FTP Widget; eight Windows-only, historical-artifact or
opt-in SSH journeys skipped. AppImage SquashFS extraction found the legal
files and matched the same sidecar (`145978823` bytes, offset `188392`).
The four unsigned files are retained in the ignored local directory
`release/axterm-linux-ftp-rest-prefix-20260924/`; their copied release hash
manifest passed `bun run release:hashes:check` again. The preceding
`release/axterm-linux-ftp-ascii-20260924/` candidate predates this fix.

## Limits

The Linux installation ran under x64 emulation on macOS arm64; it is not
native Linux desktop evidence. The macOS directory package is unsigned.
Windows packaging, historical binary upgrade, external SSH, signing, public
updater feed, migration-window publication, independent protocol/security
review and source-rights approval remain open. IR-04 is In progress and IR-13
is Open.
