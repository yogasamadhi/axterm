# IR-04 current FTP read-handle Linux x64 DEB installation — 2026-09-24

Status: **audited-source-to-emulated-installed-DEB evidence; IR-04 In progress and IR-13 Open**.

## Candidate and build boundary

The current worktree was copied through `prepare-independent-snapshot.mjs
--check --keep` before dependency installation. The audit passed with **832
source files**, **18,555,931 bytes**, source-tree SHA-256
`2d855e4fd43efd6f0c6172b36b8668625cbcd768ae309c7e9d3602bd194453c2`,
and no reported forbidden entry, generated OpenAPI, installed dependency,
environment file or high-confidence secret. This is a source-hygiene result,
not a source-rights or trademark decision.

An emulated Debian `linux/amd64` container used Bun 1.4.0 and Node 24.18.0.
`bun install --frozen-lockfile` installed 613 packages; the production build
and packaging-layout check passed; native modules were rebuilt for Electron
44.3.0. The Electron Linux x64 ZIP was supplied explicitly to electron-builder
as `electronDist` rather than downloaded during packaging. Its SHA-256
`8b49b9efdd73c0f467edc3c1cd5678392c384ccf224f34ff54179f736e2f384b`
matched the earlier official release checksum. The local Node tarball and
`fpm` archive retained their previously checked SHA-256 values
`55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742`
and `44b0ec6025c14ec137f56180e62675c0eae36233cdce53d0953d9c73ced8989f`.
The disposable build image was
`sha256:1e1de458eae85757064659d2a525e12391701a6792b785edac12ce65decfaff1`.

Two setup attempts are not counted as successes: invoking electron-builder
from the workspace root could not resolve the desktop Electron dependency;
invoking it from `apps/desktop` without `electronDist` tried to download
Electron remotely and made no download progress. The latter temporary process
was stopped. The successful build reused the **same** installed and built
source snapshot, invoked electron-builder from `apps/desktop`, and supplied
the verified local Electron ZIP plus `CUSTOM_FPM_PATH`.

## Installed result

The new unsigned DEB was installed with
`sh scripts/test-linux-deb.sh /output/axterm_0.10.0_amd64.deb` in a fresh,
disposable x64 container. That image's prior Axterm package was removed first,
and Python GI/GTK 3 was installed so the launcher-icon journey actually ran.
The installed `/opt/Axterm` reported version `0.10.0`; its Resources matched
the generated SPDX sidecar, including `app.asar` SHA-256
`2fb7e8055aea2c1f2e35901060ec6e1d24a736757db19e232bff620a445e0fe1`.
The packaged `AXTERM_UPDATE_FEED.json` matched the current source-controlled
record byte-for-byte; the record is still `pending`, not a public update feed.

The full installed Playwright suite passed **23 applicable journeys** and
skipped eight declared Windows-only, historical-binary or opt-in SSH journeys.
The applicable set includes FTP Widget, XMODEM/ZMODEM/TRZSZ, legacy and Axterm
migration, four-locale runtime packaging, Legal/About, GTK launcher icon,
updater fixture and startup outside the checkout. The deterministic
ancestor-swap injection remains a source-level regression on macOS and Linux
arm64/x64; the installed FTP journey uses the production opener.

| Retained unsigned artifact                      |       Bytes | SHA-256                                                            |
| ----------------------------------------------- | ----------: | ------------------------------------------------------------------ |
| `axterm_0.10.0_amd64.deb`                       | 114,095,952 | `46b367054ef986c4b00e548766799ad7927deba7bc20bd0ae76b713634ec51cb` |
| `AXTERM_PACKAGED_ARTIFACTS.linux-x64.spdx.json` |     307,314 | `3ae235610f611d0466b9501b96d6b31cde889b79a525c3a2b2014fb83db2f898` |
| `AXTERM_RELEASE_ARTIFACTS.linux-x64.json`       |         629 | `7bac8a2ac6023c77b16a3697797757e6fd0dce6ff7c23700fb49dd1c818587e5` |

The three files are retained in the ignored local directory
`release/axterm-linux-read-handle-20260924/`. The copied release-hash
manifest was verified against the retained DEB after copying. This candidate
supersedes the earlier FTP restart-handle DEB for **latest local Linux x64**
evidence; the older AppImage bytes are not attributed to this source.

## Limits and next gate

This was Docker x64 emulation on a macOS arm64 host with Xvfb, not a native
Linux desktop or a public installer download. It is unsigned, has no genuine
old-version binary upgrade and no packaged external SSH fixture in this suite.
A [separate same-source AppImage](IR13-LINUX-X64-APPIMAGE-READ-HANDLE-2026-09-24.md)
now has static payload evidence, but no native runtime pass. The isolated
container installation did not exercise a
public HTTPS update feed. Independent FTP security/source-rights review,
Windows and native-Linux installation, release signing and owner approval
remain open. IR-04 stays **In progress**, IR-13 stays **Open**, and the
independent matrix remains **2/14 Accepted**.
