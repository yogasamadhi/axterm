# IR-13 Linux x64 installed-package evidence — 2026-09-22

Status: **Emulated Linux x64 DEB install gate passed; IR-13 remains Open**  
Scope: current-source Linux x64 build, APT installation, installed-app
Playwright gate and reproducible artifact hashes

This record supersedes the earlier bounded attempt in the same evidence file.
That attempt stopped during slow Debian prerequisite acquisition before any
Axterm build. The later run reused a provisioned, digest-pinned container and
produced the package/install result below.

## Source input

The successful run used a disposable independent source snapshot created with
the repository's snapshot preparation command. Before it entered the builder,
the snapshot audit reported:

- 748 files;
- 15,631,699 bytes;
- source-tree SHA-256
  `78729c8a949c223363dc71fcb43685b4fe729250993837b814b3f622d81c3dcc`;
- no finding in any snapshot-audit category.

The snapshot contained no `.git`, `.gitmodules`, `vendor/legacy-prototype`, generated
OpenAPI file, installed dependency tree or release output. It is an audited
source input, not an accepted owner-created repository or IR-12 sign-off.

## Build environment

- Physical host: macOS arm64.
- Builder/test environment: Debian Trixie `linux/amd64` container running under
  Docker Desktop emulation; this was not native Linux hardware or a real Linux
  desktop login session.
- Image:
  `oven/bun@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6`.
- Bun: `1.4.0`.
- Node: official `v24.18.0` Linux x64 archive, SHA-256
  `55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742`.
- Electron: `v44.3.0` Linux x64 archive, verified against the official
  `SHASUMS256.txt`; archive size 122,830,582 bytes and SHA-256
  `8b49b9efdd73c0f467edc3c1cd5678392c384ccf224f34ff54179f736e2f384b`.

`bun install --frozen-lockfile` installed 612 packages. Production build,
packaging layout checks and Linux x64 electron-builder packaging completed.
The DEB declares package `axterm`, version `0.10.0`, architecture `amd64`, and
the Electron runtime dependencies including `udev`, which SerialPort device
enumeration uses through `udevadm`.

## Produced artifacts

| Artifact                                        |              Bytes | SHA-256                                                            |
| ----------------------------------------------- | -----------------: | ------------------------------------------------------------------ |
| `Axterm-0.10.0.AppImage`                        |        145,609,742 | `18f6391c5af758d07a636714d2d8f2d6ca7f4acc3b24b8b04185c69202bd8cd4` |
| `axterm_0.10.0_amd64.deb`                       |        113,798,200 | `b265b30ba7ecb590a8dd58ab56b5e7400e5334b777f6d360418b6399d674943c` |
| `AXTERM_PACKAGED_ARTIFACTS.linux-x64.spdx.json` |  generated sidecar | `eb57a3991ac89ac56874620a8dfd692d9ff725cdadbf1962eb40fa1d150bb957` |
| `AXTERM_RELEASE_ARTIFACTS.linux-x64.json`       | generated manifest | `27cbb270ae4f1cbf0d6a6f55719a78b91eb60669b02976e21c30574964c3e164` |

The SPDX sidecar records 87 package entries and 232 hashed artifact files. The
release manifest contains the two distributable artifacts and reproduces their
byte counts and SHA-256 values above. These are unsigned local candidate bytes,
not public release artifacts.

## Installed-package gate

The committed gate ran as:

```sh
bun run test:deb:linux
```

It installed the exact DEB with APT, verified `/opt/Axterm/axterm` was
executable, and checked that its reported version matched DEB version `0.10.0`.
It then ran the complete packaged Playwright project from `/opt/Axterm` under a
1920×1080 Xvfb display. Result:

```text
18 passed
7 skipped
exit code 0
```

The 18 applicable Linux journeys covered exact packaged license/About content,
Electron-ABI native modules, the four retained runtime locale families, the
independent FTP server, TRZSZ/ZMODEM/XMODEM through real local PTYs, IronRDP
initialization, legacy-to-Axterm migration and recovery, Gist/custom migration,
GTK launcher-icon lookup, Linux window controls, updater path isolation,
checkout/system-Node-independent startup, Phase 12 shell/workspace persistence,
four-language restart persistence, and prior-schema/local-Vault upgrade. Six
Windows-only journeys and the opt-in packaged SSH fixture were skipped by their
declared conditions.

The exit trap removed the installed product payload. Debian retained only its
normal `config-files` dpkg state inside the disposable container. The exact
container was then removed and the exact source snapshot was moved to Trash;
no package was installed on the macOS host.

## Product defects exposed and fixed by this run

The first package attempts were useful failures rather than accepted evidence.
They exposed and the current candidate fixes:

1. Linux/Windows `extraFiles` legal documents live at the packaged application
   root, while application resources live below `resources`; inventory and the
   runtime Legal/About loader now use the platform-correct roots.
2. Linux SerialPort enumeration invokes `udevadm`; the DEB now declares `udev`.
3. The installed FTP journey requires `curl`, so the gate and CI now declare it
   as a runner prerequisite.
4. The migration journey now waits for debounced workspace persistence and
   writes deterministic source state immediately before upload, removing the
   preview/upload race.
5. The source-root packaging audit now matches rooted path prefixes rather than
   rejecting harmless terminal text such as `~/workspace`.

Focused unit tests, TypeScript, packaging layout checks and the installed gate
passed after these corrections.

## Limits and remaining IR-13 work

This is meaningful Linux installed-package evidence, but it does **not** accept
IR-13. The run used an emulated container and Xvfb, so it does not prove a real
Linux desktop session, launcher/deep-link integration, native-hardware behavior
or an installed binary-to-binary upgrade. The optional packaged SSH fixture was
not run in the container. The artifacts were unsigned and unnotarized, and no
authenticated production update service or public download was exercised.

IR-13 still requires, at minimum:

1. native Windows x64 NSIS installation and upgrade evidence;
2. native Linux x64 desktop installation, launcher/deep-link and external SSH
   evidence for the final candidate;
3. final macOS/Windows signing and macOS notarization where applicable;
4. authenticated updater-feed and old-binary-to-new-binary upgrade evidence;
5. final platform artifact hashes, SBOM/license review and release-owner sign-off.

Consequently the independent-release matrix remains 1 Accepted, 10 In progress
and 3 Open; IR-13 remains **Open**.

## Current-source refresh — 2026-09-23

The earlier run above remains historical evidence for its exact bytes. A new
disposable, source-only snapshot was audited before installation/build: 763
files, 16,527,282 bytes, SHA-256
`1d176a870a728b2d33d2d58e2ac0731a81b05abbf6c8f2b190ee1908aa5fba3e`,
with no snapshot-audit findings. The same digest-pinned `linux/amd64` Bun image,
official Node 24.18.0 archive and SHA-verified Electron 44.3.0 archive were
used under macOS arm64 Docker emulation. Frozen dependency installation,
native `node-pty` rebuild, production build and electron-builder AppImage/DEB
packaging completed. The Electron download transport used a mirror documented
by Electron; the archive bytes were checked against the official
`SHASUMS256.txt` digest recorded above. The four artifacts below are retained
in the ignored local candidate directory
`release/axterm-linux-candidate-hQGbuTZQ/`:

| Artifact                                        |       Bytes | SHA-256                                                            |
| ----------------------------------------------- | ----------: | ------------------------------------------------------------------ |
| `Axterm-0.10.0.AppImage`                        | 145,613,816 | `5344b22216905c6e02e30d9ef6056389b0949b641f3ba60e0592b7c59b755a4d` |
| `axterm_0.10.0_amd64.deb`                       | 113,799,396 | `784940945bbf84708a19cbd395465c07564b3418ab1d4508a67bded277894479` |
| `AXTERM_PACKAGED_ARTIFACTS.linux-x64.spdx.json` |     296,430 | `27f80994aa6260c98fdc5e2cfb4affa4427003b1d0a29559c99fd334de281047` |
| `AXTERM_RELEASE_ARTIFACTS.linux-x64.json`       |         791 | `f80e04cff9b378ae6e20e9b3810eafef7c2cd75d5cf71798e375c6412e949813` |

The 101,556,187-byte unpacked `app.asar` has SHA-256
`a09ab63bbcf4e4e099612fd70b45e39099d4bc900758a245aa997995992a7764`.
The SPDX namespace binds that ASAR and the `linux-x64` label; it contains 87
package records, 232 file records and 318 relationships. Generation followed
by `sbom:packaged:check` passed on the unpacked resources.
`release:hashes:check` passed both inside the builder and against the four
retained candidate files on the macOS host.

`bun run test:deb:linux` then installed the exact current DEB through APT,
verified package/binary version `0.10.0`, regenerated the SPDX inventory from
**installed** `/opt/Axterm/resources` and matched the sidecar byte-for-byte.
The installed-app Playwright result was **19 passed, 8 skipped, exit 0**. The
installed SPDX comparison was a separate prerequisite to those journeys; the
skips remain platform- or fixture-conditioned. The gate removed the installed product
payload on exit, leaving only Debian's `config-files` package state inside
the disposable container. This is still an emulated Xvfb session, not native
Linux hardware or a signed public release.

For source-check diagnostics, the standard `bun run check` was attempted in
the x64-emulated container. Lint and typecheck passed, but the test phase was
not green: the image initially lacked `git` and `ssh-keygen`, and the XMODEM
SSH upload exceeded Vitest's default 10-second timeout under emulation. After
installing those two prerequisites, their focused tests passed. The same
XMODEM SSH test passed with diagnostic `--testTimeout=30000` (upload about
12.3 seconds), and the unmodified default-timeout test passed on native
macOS (both cases in 433 ms). A **diagnostic**, not acceptance-equivalent,
full Vitest run at 30 seconds passed 217 files (five skipped), 983 tests (34
skipped). The separate Level 1 architecture gate passed 368 modules and 1,314
dependencies. No source test or timeout was weakened to make the emulated
check appear green; standard Linux `bun run check` remains unproven here.

Both `linux/amd64` and `linux/arm64` container FTP PASV lifecycle smokes passed
with byte-exact 8,196-byte transfers. The remaining IR-13 native-platform,
signing, updater and binary-upgrade limits listed above still apply; the row
remains **Open**.

The current AppImage received an additional static payload gate after the DEB
result. The embedded SquashFS superblock was independently validated at byte
188,392, then extracted without executing the x64 AppImage runtime. Required
Axterm and Electron/Chromium legal files were present. The extracted
`resources/app.asar` SHA-256 was
`a09ab63bbcf4e4e099612fd70b45e39099d4bc900758a245aa997995992a7764`;
`bun run test:appimage:linux -- --artifact-dir release/axterm-linux-candidate-hQGbuTZQ`
regenerated and matched the retained SPDX sidecar SHA-256
`27f80994aa6260c98fdc5e2cfb4affa4427003b1d0a29559c99fd334de281047`.
The static AppImage check is now a local and CI gate, including a post-download
comparison. It does not prove that the AppImage launches on native Linux,
installs desktop integration or upgrades a prior binary; IR-13 remains Open.

## SPDX extraction-boundary revalidation — 2026-09-24

The retained DEB itself was rechecked after the packaged SPDX generator gained
additional legal-material coverage. The first macOS-side audit attempt had
extracted only the `resources/` subtree, omitting legal files stored beside it
at `/opt/Axterm/`. That incomplete temporary tree generated a different
inventory; this was a test-harness extraction error, not evidence of
macOS/Linux sort instability or package corruption.

The complete `data.tar.xz` was then extracted on macOS. Its generated sidecar
matched a fresh generation inside `node:24.18.0-bookworm` `linux/amd64` byte
for byte. The candidate's `.deb` remains SHA-256
`784940945bbf84708a19cbd395465c07564b3418ab1d4508a67bded277894479`, and its
`app.asar` remains SHA-256
`a09ab63bbcf4e4e099612fd70b45e39099d4bc900758a245aa997995992a7764`. The
candidate sidecar was regenerated from the complete package contents and now
hashes to
`de01ba85cd04e8e3b06dd9705ce4c7ebdf1113e912100540132b4afc3e0fbafb`
(296,398 bytes; 87 package records, 232 file records and 318 relationships).
The Linux Node verifier successfully extracted that exact DEB with `dpkg-deb`
and accepted the retained sidecar. The static AppImage payload verifier also
passed against the same refreshed sidecar, as did the two-artifact installer
hash-manifest check.

The full `test:deb:linux` installed Playwright journey was **not rerun** in this
revalidation. A disposable Debian container's APT/Xvfb setup was still
downloading `libllvm15` after IPv4 was enabled, and was stopped before the
application tests began. This is an environment setup timeout, not a product
test failure. The earlier 19-pass installed journey above remains evidence
for the unchanged DEB bytes but predates this sidecar refresh; no new packaged
journey result is claimed. This update does not change the emulated-container,
unsigned-artifact, native Linux, Windows, upgrade or release-approval limits.
