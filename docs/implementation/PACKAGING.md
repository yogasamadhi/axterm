# Desktop packaging and acceptance

Updated: 2026-10-05

The 2026-09-26 commercial-detachment completion is recorded in
[COMMERCIALIZATION_CLEANUP_PLAN](COMMERCIALIZATION_CLEANUP_PLAN.md). The completed
[local optimization goal](LOCAL_OPTIMIZATION_GOAL_PLAN.md) included OP-09, which required a new
unsigned macOS candidate built from the optimized source. The new candidate has passed
independent installation, 14 feature/performance journeys, 40 applicable packaged journeys
and the OpenSSH extension; the final source gate also passed (1,328 tests / 23 visual-accessibility journeys). See the dated
[OP-09 receipt](evidence/local-optimization/OP-09-2026-10-03.md) for its exact bytes and skips.
Prior package receipts below identify earlier source.

For pure local repacks, the owner's 2026-10-05 instructions are to rebuild and package
directly without repeating development-stage tests, and to keep only the newest successful
package set. Remove older installers and obsolete packaged/test `.app` copies only after
the new package succeeds. Keep source, real user data, controlled backups, logs, screenshots
and dated acceptance records intact. Earlier records describe historical runs, not retained
installers or fresh validation of a later repack.

[ADR-022](../adr/ADR-022-commercial-release-mac-acceptance.md) and
[MCR-01–04](MINIMUM_COMMERCIAL_RELEASE.md) apply when a formal release is separately taken up:
rights/notices review, signed/notarized Mac installation and actual public delivery. They are
not the local OP-09 completion line. Windows/Linux native tests remain pending on separate
machines; no emulated or macOS test establishes their native acceptance.

## Local optimization candidate

The default package command writes to `release/`. Keep acceptance records, but remove
superseded binary artifacts after a successful replacement package.
OP-09 uses the existing `--output` argument and a new empty absolute directory outside source:

```sh
bun run build
axterm_opt_output="$(mktemp -d /tmp/axterm-local-opt-package.XXXXXX)"
env -u CSC_LINK -u CSC_KEY_PASSWORD -u CSC_NAME -u CSC_KEYCHAIN \
  -u WIN_CSC_LINK -u WIN_CSC_KEY_PASSWORD node scripts/package-desktop.mjs \
  --output "$axterm_opt_output"
```

The output directory must already exist, be empty and not be a symlink. The package script
rejects invalid/repeated options and source-root destinations, never publishes, and disables
ambient signing-certificate discovery. No system Credential Vault is consulted. OP-09 records
HEAD plus the complete dirty-source snapshot, tool versions, artifact SHA-256 and packaged
SPDX sidecars. Copy-install the app outside source, detach the DMG, then run with an isolated
user-data directory and restricted PATH. Verify the new palette, terminal consumption, SFTP,
settings, resource cleanup and AI review workflows using actual local protocol fixtures.
Keep original owner data and backups intact. The new `.app`/DMG/ZIP and all package journeys
are recorded in their own OP-09 receipt; earlier package tests do not close this goal.

## Targets

The electron-builder configuration in `apps/desktop/electron-builder.yml` defines:

| Platform | Architecture | Artifacts                    | Current evidence                                                                                |
| -------- | ------------ | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| macOS    | arm64        | DMG, ZIP, `.app`             | Optimized OP-09 candidate installed and verified locally; final source gate passed              |
| Windows  | x64          | NSIS installer, unpacked app | Real NSIS installation gate is committed; Windows runner result needed                          |
| Linux    | x64          | AppImage, deb, unpacked app  | Latest emulated-x64 DEB install: 23 applicable journeys pass; native release proof remains open |

Earlier macOS artifacts described below were unsigned development outputs; their dated
records remain historical evidence even when the superseded binaries have been removed.
New local optimization outputs use the isolated directory above. No package command uploads them.

Each platform package copies the root `UPDATE_FEED_RECORD.json` into its
Resources as `AXTERM_UPDATE_FEED.json`. The current record is `pending`, so
these local candidates do not have a public updater feed. An `active` release
record pins the HTTPS manifest URL and Ed25519 public key in the package and
cannot be overridden by process environment; the **existing** final-public promotion gate
requires `release:updater-feed:active-check`. ADR-022 requires a separate,
tested Mac/manual-update gate before a formal release can complete; the
pending feed must never be falsely marked active. The packaged updater journey
uses a pending local candidate plus an explicit loopback fixture, which is
not a substitute for a live HTTPS feed or installed upgrade.
The macOS DMG, Linux DEB and Windows NSIS installation gates compare the
installed `AXTERM_UPDATE_FEED.json` byte-for-byte with the reviewed root record
using `release:updater-feed:package-check`; CI also checks unpacked app
Resources before upload. For a final active candidate, run the same check with
`--active` and retain the installed-package receipt.

The archived 2026-09-24 local macOS arm64 DMG was installed and tested after adding the
native no-replace publication trial: **21 applicable packaged journeys passed**,
11 platform/fixture cases skipped, and the installed Resources matched the
SPDX sidecar and pending update-feed record. The separately added bundled-native
regression and packaged SSH fixture also passed. The unsigned DMG SHA-256 is
`c79b573a90c5ecebe4d269e921f2cb999d450e526915da87fa2a58b3c01e51ab`;
see the [latest macOS trial](evidence/IR03-MACOS-ARM64-NATIVE-PUBLICATION-2026-09-24.md).
The same DMG-built app subsequently passed all three packaged terminal-transfer
roundtrips with download destinations on a real mounted FAT16 volume where
hard links fail with `ENOTSUP`, plus a separate historical-source package
upgrade journey. Those scoped checks do not establish network-volume behavior
or a signed public-version upgrade.
This is not a notarized or publicly distributed release.

Current packaged metadata declares `axterm`, `ssh`, `telnet`, `vnc`, `rdp`,
`spice`, `serial` and `ftp` session schemes; ADR-021 removed `legacy-prototype`.
HTTP and HTTPS are not
claimed. The desktop uses a single-instance lock and forwards initial, macOS
`open-url` and second-instance links through the ADR-012 authenticated Runtime
ingress. Production Electron tests exercise those three handlers; installation-level
registration and activation still require evidence from each target operating system.

The source launcher uses a separate `Axterm Dev` application identity, user-data directory,
single-instance domain and Windows AppUserModelID. Running `bun run.ts` therefore cannot focus or
reuse an installed Axterm process, and development state never overwrites the packaged profile.
An explicit Electron `--user-data-dir` remains authoritative for isolated automation.

## Native modules

`node-pty` 1.1.0 carries the minimal macOS descriptor-close fix recorded in
`patches/node-pty@1.1.0.patch`. Development installation compiles that source for the current Node
ABI through `scripts/prepare-native.mjs`; a source-hash/ABI marker avoids redundant rebuilds.
`scripts/rebuild-native.mjs` then invokes `@electron/rebuild` for `node-pty` and
`@serialport/bindings-cpp` using the exact Electron version from the Desktop package before
electron-builder runs. `scripts/package-desktop.mjs` first snapshots the complete workspace
`node-pty/build` directory and restores it in `finally` after electron-builder has copied its
Electron artifacts, including when rebuild or packaging fails. Direct Electron rebuilds also
remove every Node ABI marker so the next preparation cannot trust a replaced binary. Unit tests
cover exact restoration, missing-build cleanup, idempotency and marker invalidation. The packaged
native binary and helper are unpacked from ASAR so the operating system can load/execute them.
Build tooling is never an end-user prerequisite.

`ssh2` works without its optional `cpu-features` accelerator. That accelerator is
excluded because its published package is incomplete for electron-builder's broad
rebuild path. SSH protocol behavior remains in ssh2's JavaScript implementation.
`ws` is also a packaged external dependency; bundling it changed the shape of its
optional `bufferutil` branch and caused binary terminal frames to crash the Runtime.

`zmodem2` 1.4.0 and `trzsz2` 1.2.0 are separately published pure-JavaScript
third-party protocol engines; Axterm's `xmodem.ts` is its own pure-JavaScript
engine. All three are bundled into the separate Runtime artifact. The packaging
gate verifies their protocol markers and that no copied source or workspace
dependency remains. Their notices stay required and the source/provenance review
for the two third-party engines remains open; this packaging statement is not a
rights conclusion. `trzsz2` 1.2.0 declares a missing top-level type path; the
committed Bun patch redirects only that declaration to the shipped
`dist/esm/lib/index.d.ts` and does not change executable code. See
[ADR-018](../adr/ADR-018-independent-terminal-transfer-implementations.md).

For hard-link-limited receive destinations, the Runtime's staged-file adapter
now uses the public atomic no-replace publication API of exact
`@openclaw/fs-safe@0.13.1`. The macOS arm64 native binding is packaged outside
ASAR and was loaded and exercised by the packaged Electron executable. The
normal hard-link path remains. This is a local implementation trial under
[ADR-019](../adr/ADR-019-atomic-no-replace-transfer-publication.md), not a
completed source-rights, removable-volume or other-platform acceptance. A
missing native binding fails closed instead of exposing a partial final file.

The packaged tests are the ABI gate. They launch the copied application with a PATH
that contains no user Node/Bun installation, start a local PTY, and verify output.
The Docker variant also establishes a real SSH terminal from the packaged app. This is a
repository-only integration fixture: Docker is not shipped, invoked by the application or required
on an end-user machine. Fixture containers use Docker auto-remove plus an `EXIT`/interrupt trap and
have no restart policy or product-data mount.

The Local FTP Server Widget is deliberately a loopback-only convenience service:
its Contract and adapter allow only `localhost`, `127.0.0.1` and `::1`, and its
form exposes the IPv4/IPv6 loopback choices. FTP is not encrypted, so it must not
be used for network sharing; the separately authenticated SSH Server Widget is
the supported encrypted path when a user intentionally needs to share over a
network.

## Commands

```sh
bun install --frozen-lockfile
bun run check
bun run test:e2e
bun run package:dir
bun run sbom:packaged -- release/mac-arm64/Axterm.app/Contents/Resources --platform macos-arm64 --output release/AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json
bun run sbom:packaged:check -- release/mac-arm64/Axterm.app/Contents/Resources --platform macos-arm64 --sidecar release/AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json
bun run release:hashes -- release --platform macos-arm64 --output release/AXTERM_RELEASE_ARTIFACTS.macos-arm64.json
bun run test:packaged
bun run test:dmg:macos
bun run test:deb:linux
bun run test:nsis:windows
bun run test:ssh:packaged
bun run release:hashes:check -- release --platform macos-arm64 --manifest release/AXTERM_RELEASE_ARTIFACTS.macos-arm64.json
bun run package
```

`test:dmg:macos` is the macOS installation gate. It verifies the sole DMG in
`release/`, mounts it read-only, copies `Axterm.app` with preserved framework
links, detaches the image, verifies that the **installed** app matches the
matching packaged SPDX sidecar, and runs the packaged suite only from the
independent installation directory. An explicit DMG may be supplied as the
first argument or with `AXTERM_DMG_PATH`; every exit path detaches and removes
its temporary directories. The sidecar defaults to the DMG's directory and
can be supplied explicitly through `AXTERM_PACKAGED_SIDECAR`.

To rebuild a local candidate, first make a new empty directory under `release/`, then run
`node scripts/package-desktop.mjs --output /absolute/path/to/that/directory`
after `bun run build`. The wrapper accepts only an existing, empty, non-symlink
absolute output directory. Pass the resulting DMG explicitly to
`sh scripts/test-macos-dmg.sh /absolute/path/to/candidate.dmg` and generate
the release-hash manifest and packaged SPDX sidecar inside that same candidate
directory. For a pure repack, do not repeat these installation tests unless separately
requested. Once packaging succeeds, retain the newest set and remove older installer/archive
files, their superseded package-output directories and obsolete test `.app` copies; preserve
dated evidence and user-data backups. Never delete the preceding usable package before the
replacement has been generated successfully. An unsigned local candidate is not a signed release.

`sbom:packaged:check` recomputes the deterministic sidecar from the concrete
packaged resources and requires byte-for-byte equality with the retained SPDX
file. CI runs it after installed-app journeys and before artifact upload on
macOS, Windows and Linux. It detects stale or modified resources within the
inventory's scope; it does not prove that every binary in the installer has
been mapped to source or legally reviewed.

`test:appimage:linux` separately opens the actual Linux AppImage as SquashFS
without executing its embedded runtime. It requires `unsquashfs` on the release
host, locates one valid bounded SquashFS superblock, extracts to an owned
temporary directory, requires the app's legal files and licenses directory,
then regenerates `sbom:packaged:check` from those extracted resources. CI runs
this before artifact upload and again against the downloaded AppImage and
downloaded sidecar. This checks the AppImage payload rather than assuming
`linux-unpacked` and the AppImage contain identical files. It does not launch
the AppImage or replace a native Linux desktop smoke test.

`test:appimage:linux:runtime` is a separate Linux x64 execution gate after
that static audit. It selects exactly one regular AppImage, copies it outside
the checkout and restores its executable bit on the temporary copy (artifact
upload/download does not preserve file modes). Under Xvfb it launches the
AppImage itself with `APPIMAGE_EXTRACT_AND_RUN=1`, verifies the running
Electron product version, waits for Desktop Runtime `ready`, and opens a
second local terminal tab. Before launch, it checks the copied image's size
and SHA-256 against the matching entry in the platform release-hash manifest;
after clean shutdown it rechecks those bytes before writing the receipt. It
runs before upload and again after downloaded
artifact hashes and the AppImage payload are rechecked. The downloaded run
writes `AXTERM_APPIMAGE_RUNTIME.linux-x64.json` with the exact AppImage SHA-256
and observed startup facts, which CI retains with the upload-roundtrip
receipts. This uses AppImage's documented extract-and-run path so CI does not
need FUSE privileges; it does not establish ordinary FUSE launching, desktop
integration, signing, external SSH or a historical-package upgrade. A
successful native Linux x64 runner log and receipt are still required before
claiming this gate has passed. See the [AppImage FUSE guidance](https://github.com/AppImage/appimagekit/wiki/fuse).

`test:deb:linux` is the Linux x64 installation gate. It refuses to replace a
pre-existing `axterm` package, requires exactly one `axterm_*_amd64.deb` unless
an explicit path is supplied, installs it with the operating-system package
manager, compares the installed package and binary versions, verifies the
installed `/opt/Axterm/resources` against the matching packaged SPDX sidecar,
and runs the full packaged suite from `/opt/Axterm` under Xvfb. Its exit trap removes only the
newly installed `axterm` package. `test:nsis:windows` performs the corresponding
silent NSIS installation into a newly generated, validated runner-temporary
directory, checks the installed executable/version, uninstaller and packaged
SPDX sidecar match, runs the
packaged suite from that installation, and then invokes the uninstaller and
removes only that validated temporary directory. These are CI-capable gates;
their presence is not Windows/Linux evidence until the respective runners pass
and retain logs and artifact hashes.

The 2026-09-22 Linux x64 result and its 2026-09-23 source refresh are historical
candidate evidence recorded in
[IR-13 Linux x64 installed-package evidence](evidence/IR13-LINUX-X64-INSTALL-ATTEMPT-2026-09-22.md).
A digest-pinned Debian `linux/amd64` container under macOS arm64 emulation
completed frozen installation, production build, AppImage/DEB packaging and the
real APT installation gate. The installed `/opt/Axterm` package matched version
`0.10.0`; that run passed 19 Linux-applicable packaged journeys with eight
declared platform/fixture skips. Its AppImage and DEB SHA-256
values are
`5344b22216905c6e02e30d9ef6056389b0949b641f3ba60e0592b7c59b755a4d`
and
`784940945bbf84708a19cbd395465c07564b3418ab1d4508a67bded277894479`.
The installed resources matched the 296,430-byte packaged SPDX sidecar with
SHA-256 `27f80994aa6260c98fdc5e2cfb4affa4427003b1d0a29559c99fd334de281047`.
The same sidecar also matched the statically extracted AppImage payload from that candidate;
the embedded SquashFS begins at byte 188,392 and contains the same `app.asar`
SHA-256 `a09ab63bbcf4e4e099612fd70b45e39099d4bc900758a245aa997995992a7764`.
The earlier 2026-09-22 AppImage SHA-256 was
`18f6391c5af758d07a636714d2d8f2d6ca7f4acc3b24b8b04185c69202bd8cd4`;
it describes different bytes and is not that 2026-09-23 candidate.

The latest 2026-09-24 DEB candidate uses the corrected FTP read-handle
identity check. An audited 832-file independent source snapshot was built and
the DEB installed under emulated `linux/amd64`; the installed resources matched
its packaged SPDX sidecar and **all 23 applicable journeys passed** with eight
platform/fixture skips. The retained unsigned DEB SHA-256 is
`46b367054ef986c4b00e548766799ad7927deba7bc20bd0ae76b713634ec51cb`.
Exact source, sidecar, manifest and installation evidence is in the
[IR-04 FTP read-handle Linux DEB record](evidence/IR04-FTP-READ-HANDLE-LINUX-DEB-2026-09-24.md).
The DEB run itself did not produce an AppImage. A separate build from the
**same audited source snapshot** subsequently produced an unsigned AppImage;
its static SquashFS payload matches the DEB's packaged SPDX resources. The
[current AppImage record](evidence/IR13-LINUX-X64-APPIMAGE-READ-HANDLE-2026-09-24.md)
gives its distinct hash and the failed emulated runtime probe. The 2026-09-23
AppImage hashes above must not be presented as matching this source. These results close the
earlier prerequisite-fetch attempt, but emulation plus Xvfb is
not native Linux desktop/AppImage runtime/launcher/deep-link, packaged external-SSH, signed
distribution or binary-to-binary upgrade evidence; IR-13 remains Open.

`test:ssh:packaged` requires Docker and an existing current-platform unpacked app.
It starts the digest-pinned OpenSSH fixture, runs the headless SSH/SFTP/tunnel suite,
then tests Host Key approval and SSH PTY output through the packaged UI. The script
always removes its fixture container.

`sbom:packaged` creates a deterministic SPDX 2.3 **sidecar** from one concrete
electron-builder Resources directory. It records the `app.asar` hash, packaged
manifest identities, renderer assets, unpacked files, Axterm-provided legal
documents and Electron/Chromium legal-file hashes. Pass a release-specific
platform label such as `macos-arm64`, `windows-x64` or `linux-x64`; preserve the
result with that artifact's release hashes. It is intentionally produced after
packaging rather than inserted into a signed app, so it cannot create a
self-referential artifact hash. It is evidence for one artifact, not a complete
source-to-binary map, a file-level license conclusion, or legal clearance.
For macOS arm64, `AXTERM_FS_SAFE_MACOS_CARGO_SOURCE.spdx.json` separately lists
the 61 pinned Cargo source-package identities behind the published
`fs-safe-native.node`. `bun run sbom:native:macos:check` guards that source
inventory in the routine check; `bun run sbom:native:macos:artifact-check --
<Resources> <packaged SPDX sidecar>` compares one concrete app's native binding,
installed npm package identity and five native legal supplements against the
source-scope target and verifies the complete packaged sidecar. Neither check
claims exact crate linkage or license clearance; see the
[macOS source-SBOM evidence](evidence/IR11-FS-SAFE-MACOS-SOURCE-SBOM-2026-09-24.md).
The fs-safe macOS source graph also has a bounded
[copyright/SPDX header-candidate record](evidence/IR11-FS-SAFE-SOURCE-HEADER-CANDIDATES-2026-09-24.md):
156 matching source lines in nine packages are preserved as
`licenses/fs-safe-SOURCE-HEADER-ATTRIBUTIONS.txt` and guarded by
`licenses:native:headers:check`. The macOS artifact comparison requires the
exact external text. This is a reviewer lead, not a complete source-to-native
binary rights conclusion.
IronRDP's embedded WASM has a second, separate target-rooted Cargo source
inventory and SPDX, with its 470 available root legal texts in
`licenses/IronRDP-RUST-ROOT-LICENSES.txt`. Six published crates without their
own root text have a separate, publisher-commit-pinned 12-text supplement in
`licenses/IronRDP-MISSING-CRATE-ROOT-LICENSES.txt`; the routine
`bun run licenses:ironrdp:missing:check` checks its provenance record and bytes.
The `tracing-core` nested spin MIT text is separately preserved as
`licenses/tracing-core-spin-LICENSE.txt`; `licenses:ironrdp:nested:check` pins
the crate identity and text, with an opt-in archive/target-tree source sweep.
An additional source-header candidate record preserves 798 copyright/SPDX
lines from 719 files in 51 target-graph packages as
`licenses/IronRDP-SOURCE-HEADER-ATTRIBUTIONS.txt`.
`licenses:ironrdp:headers:check` guards the record and exact text offline;
`licenses:ironrdp:headers:source-check -- <IronRDP tagged checkout>`
verifies matching source files against published archives/upstream. It is a
candidate handoff, not an exhaustive file-level rights conclusion.
Run
`bun run licenses:ironrdp:source:artifact-check -- <Resources> <packaged SPDX
sidecar>` for a concrete macOS arm64 app; it checks the actual ASAR-embedded
WASM bytes and the four supplemental packaged legal files against the pinned source scope and
complete sidecar. See the
[IronRDP WASM source record](evidence/IR11-IRONRDP-WASM-SOURCE-SCOPE-2026-09-24.md).
The three-platform CI job runs `sbom:packaged` after every package build and uploads
the generated sidecar as `packaged-sbom-<runner OS>`; a release owner must still
preserve the sidecar with the final signed/notarized installer hashes and inspect
the actual installed product.

`release:hashes` records every platform-appropriate top-level Axterm
distributable in a deterministic byte-count/SHA-256 manifest. After the real
DMG, DEB or NSIS installation gate—and the Linux packaged SSH fixture—the CI
job runs `release:hashes:check` against that manifest before any artifact
upload. The verifier regenerates the expected platform/product manifest from
the current files and rejects changed bytes, a changed byte count, an added or
removed artifact, duplicate manifest paths, policy/product/platform changes or
extra/missing fields. This closes the build-to-upload mutation gap.

After uploading the installers, hash manifest and packaged SPDX sidecar, the
same matrix job downloads all three exact named GitHub Actions artifacts into
`downloaded-release/` with the commit-pinned `download-artifact` action. It
rechecks the downloaded installers against the downloaded hash manifest and
the downloaded SPDX bytes against the concrete packaged Resources. Only
successful checks write `AXTERM_UPLOAD_ROUNDTRIP.<platform>.json` and
`AXTERM_SPDX_UPLOAD_ROUNDTRIP.<platform>.json`; the former records installer
and manifest hashes, while the latter records the sidecar byte count/hash and
the observed `app.asar` hash. Both are uploaded as
`packaged-upload-roundtrip-<runner OS>`. Receipts explicitly cannot prove their
own transport origin, so workflow ordering and pinned actions are part of the
evidence. This round trip does not make unsigned bytes signed, verify a public
Release/CDN download, or replace the release owner's final signed-download/hash
verification.

On Linux, run Electron smoke tests in a graphical session or under `xvfb-run`.
The CI matrix in `.github/workflows/check.yml` now routes Linux through the real
DEB installation gate and Windows through the real NSIS installation gate,
rather than treating `linux-unpacked` or `win-unpacked` as installed-product
proof. A workflow definition is not acceptance evidence until that runner
passes and its generated installer, SBOM, hashes and diagnostics are retained.

## Signing boundary

electron-builder owns platform signing. The repository contains the macOS hardened
runtime entitlements and Windows executable-signing configuration, while identities
remain external secrets supplied by the release environment. Standard
electron-builder signing inputs such as `CSC_LINK` and `CSC_KEY_PASSWORD` may be set
by a protected release job. No certificate, password, Apple credential or private
key belongs in this repository.

The package wrapper always sets `CSC_IDENTITY_AUTO_DISCOVERY=false`, so a local
build never scans the developer's login keychain for a signing identity. A release
job can still provide an explicit certificate file through `CSC_LINK`; it must also
perform notarization and platform installation checks before it can become Desktop
1.0 evidence.

## Updater boundary

The default package has no update publisher/server, so Desktop Host reports
`state: disabled` and the Settings UI accurately shows that state. A controlled
release job can configure `AXTERM_UPDATE_MANIFEST_URL` and
`AXTERM_UPDATE_PUBLIC_KEY_BASE64`; the Desktop Host then owns signed manifest
checks, bounded streaming download, progress, cancellation, SHA-256/Ed25519
verification, private temporary files and OS installer handoff. Runtime and Renderer
only receive safe status metadata and actions through the authenticated Host boundary;
they never receive the feed URL or installer path. The exact manifest and signing
record are defined in [SIGNED_UPDATE_FEED](SIGNED_UPDATE_FEED.md) and the architecture
decision is [ADR-015](../adr/ADR-015-signed-desktop-update-provider.md).

Production Electron already passes a signed loopback check/download/cancel/retry/install
journey. The freshly copied macOS arm64 package also passes its equivalent
check/download/ready/install flow and proves the local installer path does not cross into Renderer.
The same journey is present for every platform. Official HTTPS publishing, production signing
identity, rollback metadata and installed binary-to-binary upgrade evidence remain release requirements.

## Ubuntu 22.04 x64 build record

Version `0.10.0` produced `release/axterm_0.10.0_amd64.deb` on Ubuntu 22.04 x64.
SHA-256: `1c1aad7148fcce105480d84a97f0a9da78ff336b0bbf99a10130d959444f3a06`.
This archive includes the balanced neutral-gray selected-tab background and underline.
The Linux CI job is pinned to `ubuntu-22.04` and uses a 1920×1080 Xvfb screen
for desktop and package journeys, matching this minimum supported baseline.
[GitHub plans to retire that hosted runner on 2027-04-17](https://github.com/actions/runner-images/issues/14254);
the baseline build will need an equivalent pinned Ubuntu 22.04 environment before then.
The Debian metadata declares package `axterm`, architecture `amd64`, Apache-2.0,
the repository homepage, a maintainer and explicit Electron GTK/GBM/ALSA dependencies.
The installed `axterm.desktop` uses `StartupWMClass=axterm`, matching Electron's
`desktopName` so the running window associates with its launcher entry.
The running Linux window now loads an icon from the packaged resources and
publishes a 128×128 copy to X11. An extracted-deb Playwright journey compares
the packaged resource with the source PNG and confirms the window's `_NET_WM_ICON`
property. The Ubuntu desktop still showed a gear after that change: the launcher
icon was installed only under `hicolor/1024x1024`, a directory absent from Ubuntu
22.04's icon-theme index. The revised archive installs the launcher icon under
`hicolor/512x512/apps`; the old archive fails and the new archive passes a GTK
icon-theme lookup for `axterm` at 48 px.
The Linux terminal tab strip now reserves the measured right-side window-control
width, as the Windows title bar already did. An 800 px source Electron journey
reproduced the overlapping tab scroll strip before the fix and passes after it;
an extracted-deb journey verifies the close button receives hover/click and opens
the multiple-tab confirmation.
The ALSA alternative accepts Ubuntu 22.04's `libasound2` and newer systems'
`libasound2t64`. `apt-get -s install` resolves the package on this host.
A preceding `.deb` with the same dependency metadata installed in clean Ubuntu
22.04, 24.04 and 26.04 containers with `apt-get install --no-install-recommends`,
resolved the native dependencies and ran `/opt/Axterm/axterm --no-sandbox --version`
successfully (`0.10.0`).

`dpkg-deb -x` placed the archive in an independent temporary directory. Under
1920×1080 Xvfb, all five applicable packaged Playwright journeys passed from
that directory with application PATH restricted to `/usr/bin:/bin`. They cover
first launch, local PTY and search, native SerialPort enumeration, SQLite state,
four-pane named workspace loading, localization, updater handoff and
old-profile/local-Vault migration. A 1280-pixel virtual screen clips the required
1440×900 first window, so package UI tests use a display wider than 1440 pixels.
The separate packaged OpenSSH journey passes password authentication, Host Key
approval, SSH PTY/search and SFTP `/tmp` browsing with a temporary Docker fixture.
The aggregate `test:ssh:packaged` wrapper stops earlier at its 256 MiB concurrent
transfer integration test on this host: only 66 MiB transferred before its
35-second deadline. That timeout is still open reliability evidence.
An installed graphical-desktop golden journey still needs a privileged Linux
runner; the current host shell has no passwordless sudo, and the container
install checks do not exercise launcher/deep-link integration.

## Acceptance record

On macOS arm64, version `0.10.0` produced:

- `Axterm-0.10.0-arm64.dmg`;
- `Axterm-0.10.0-arm64-mac.zip`;
- `mac-arm64/Axterm.app`.

The 2026-09-14 artifacts have these SHA-256 digests:

- DMG: `496bf7e712639d1dc265db28ac0065a57535318410e335b3b2c290311813aa99`;
- ZIP: `fca121500f70b18eda5cd88d8f9fef0d0d685e88237b417e516d151bd5e74d25`.

`hdiutil verify` accepts the DMG and `unzip -tq` reports no ZIP error. The DMG was then mounted read-only;
its `.app` was copied into an independent temporary installation directory and passed all five runnable
package journeys: checkout-independent Runtime/local PTY/SQLite/native SerialPort, Phase 12 shell/workspace
behavior, H-11 localization plus cold restart, old-schema/local-Vault upgrade, and the signed updater flow.
The mount and installation directory were removed after the run. The SSH package journey is conditionally
separated and its earlier macOS OpenSSH terminal/SFTP evidence remains valid. A post-package Node ABI smoke
confirms that native-build snapshot restoration leaves development node-pty usable. Windows x64, Linux x64
and installed binary-to-binary upgrade checks remain pending, so Phase 10 and the Desktop 1.0 Definition of
Done remain open.

## Current unsigned macOS arm64 candidate

After the four-language catalog reduction, a new local unsigned `0.10.0`
macOS arm64 candidate was produced on 2026-09-21. Its artifacts are local
development outputs, not published downloads or signed release artifacts:

- DMG SHA-256: `e6cf5b448fa1c29405876330408d38fe8b423d116bfb2936f27674146831694c`;
- ZIP SHA-256: `fca349b7046ca7947cd7f08a61b7d518c00e923f9fab6d02c5597f36e41f7f60`;
- DMG blockmap SHA-256: `daee050fff9de26ce4da3d103d504aa2056c3269936ada37a32b8993a60091c3`;
- ZIP blockmap SHA-256: `2bcad7ea8dba9002de521d513cf7fbeaccbf06cfb44d64a9785e0ff07b8470ae`.

`hdiutil verify` accepted the DMG; `test:dmg:macos` mounted it read-only,
copied `Axterm.app` to an independent temporary directory, detached the image,
then passed all 15 applicable packaged journeys. They include exact
license/About text, independent FTP with system `curl` forced-PASV
list/upload/download and active `--ftp-port -` byte-exact `STOR`/`RETR`,
XMODEM/ZMODEM/TRZSZ transfers, official IronRDP initialization, migration
warnings, signed-updater boundary, isolated startup, Shell/workspace behavior,
four-language H-11 switching/cold restart, and prior-schema/Vault preservation.
Nine Windows/Linux or optional-fixture journeys were skipped by their explicit
platform conditions.

The same DMG test confirms electron-builder retained only the selected runtime
locale families (`en`, `ja`, `zh-CN`, `zh-TW`): macOS contains 20 compatible
`.lproj` variants totalling 3,160 KiB, not additional product language choices.
The package also carries the refreshed mint-only AX PNG/ICO/ICNS set; the
packaged macOS ICNS bytes match the product-asset inventory. Windows and Linux
package inspection remains a separate open release task.

The matching macOS packaged SPDX sidecar is
`release/AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json` with SHA-256
`fae6092a590c00f5cfebbdecbca2ee5560d2e8653cdfff14dc9d2b6928a5febf`.
The separate distributable-byte manifest is
`release/AXTERM_RELEASE_ARTIFACTS.macos-arm64.json` with SHA-256
`96efc899adef36eb5b142c32124bbd1914f20924f1950324db7f68796fb17fd3`;
it binds the ZIP (136,220,869 bytes) and DMG (141,551,782 bytes) to the hashes
above without treating the resource-sidecar inventory as an installer hash.
The packaged inventory observed an `app.asar` SHA-256 of
`b179802b59e1a597fdf94dbeaead18e9f6c818bcb2b35c2d0e878f2bbea55d02`, 87
package records and 233 hashed artifact files. This ties current local bytes to
their inventory but is not a file-level rights conclusion, notarization,
Windows/Linux artifact evidence or IR-11/IR-13 acceptance.

### 2026-09-22 packaged-brand revalidation

That earlier unsigned macOS arm64 candidate was rebuilt after the product-blue
guard and packaged Shell assertions were added. Its DMG is 141,628,390 bytes
with SHA-256
`a452ae54e27f887f81e097920824df2087ff6a46cd02d48ddf55189031da260e`;
the 136,299,791-byte ZIP has SHA-256
`215d1e4ea5a482951b47f0914675ef8fa43d15a0276a26972d4f02b6ee599b4d`.
`hdiutil verify`, the read-only mount/copy/detach installation gate and
`unzip -tq` pass. All 15 macOS-applicable packaged journeys pass, including a
new installed-app assertion that the activity brand slot is empty and the tab
number uses mint `rgb(47, 199, 161)` rather than the retired blue mark/badge.
Nine Windows/Linux or optional SSH-fixture cases remain conditionally skipped.

The regenerated release-byte manifest SHA-256 is
`6d9f5e1a30684ac6fbd7d84490ac101134657f1e74a08f5e79ae4ef6b19cc5ab`.
The packaged SPDX 2.3 sidecar SHA-256 is
`e433846401849fe7ca542ef60a2baa7c0b9fe3e80011b9d987865b42a3967b68`;
it records 87 packages, 233 files and 319 relationships for `app.asar`
`ecc1aa6ee4f949e4ace0bf3e852ffe5e2576706eef04c6c486f3c534d0dca8a1`.
Exact procedure, blockmap hashes and limitations are preserved in
[IR-13 macOS DMG evidence](evidence/IR13-MACOS-DMG-2026-09-21.md). This remains
unsigned local evidence, not notarization, public distribution, a historical
binary-to-binary upgrade or IR-13 acceptance.
