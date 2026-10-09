# IR-13 current Linux x64 packaged FTP ASCII revalidation — 2026-09-24

Status: **emulated installed-package and AppImage checks passed; IR-13 remains Open**

## Source and build environment

The input was an independent temporary snapshot of the current working tree,
prepared with `node scripts/commercialization/prepare-independent-snapshot.mjs
--check --keep`. Its audit passed with 817 source files, 18,435,511 bytes and
source-tree SHA-256
`5665246b59af862d46e5cc343c61c118c13008a4f4bf58b8e1f64bea1cfa0627`.
The repository's `release/` directory was not used.

The builder ran under Docker Desktop on macOS arm64 as emulated Debian Trixie
`linux/amd64`, using the local image
`sha256:1e1de458eae85757064659d2a525e12391701a6792b785edac12ce65decfaff1`.
It reported Bun 1.4.0 and Node 24.18.0. The official Electron 44.3.0 Linux
x64 ZIP was downloaded on the host and seeded into the container's temporary
Electron cache. Its SHA-256
`8b49b9efdd73c0f467edc3c1cd5678392c384ccf224f34ff54179f736e2f384b`
matched both the official release `SHASUMS256.txt` and the installed Electron
package's `checksums.json` before packaging.

In the snapshot, `bun install --frozen-lockfile` installed 613 packages. The
production build, Runtime packaging-layout check and `bun run package`
produced the Linux x64 DEB and AppImage. The packaged SPDX generator/checker
verified the unpacked app Resources, and the release hash generator/checker
verified both distributable files.

## Artifacts

| Artifact                                        |       Bytes | SHA-256                                                            |
| ----------------------------------------------- | ----------: | ------------------------------------------------------------------ |
| `axterm_0.10.0_amd64.deb`                       | 114,031,680 | `76fcfa2d544ea07a1c60b6f35565723846cae1316e0331c37a21dc76a0a12ef5` |
| `Axterm-0.10.0.AppImage`                        | 145,979,132 | `567b030ba3852005b720edc3a031c1034bfa9055af7a3e2c49a46b4a5f6cd8bc` |
| `AXTERM_PACKAGED_ARTIFACTS.linux-x64.spdx.json` |     307,314 | `85a7b382a1e3cd8664ddc385b592f716a5fc7b7c48a7afd435213edc48b545d6` |
| `AXTERM_RELEASE_ARTIFACTS.linux-x64.json`       |         791 | `6ca26beb26bbe2bcf5fa78287632a9ba4839f0702a73bcd942a9225cc9793c1d` |

The unpacked and installed `app.asar` SHA-256 was
`c21ec93bb24d73de6102eacb6125618bae6e74817828b74af2cb304061dce74b`.
The release manifest's DEB/AppImage hashes were also reproduced independently
with `shasum -a 256` on the host. Copies of these four unsigned verification
artifacts are retained in the ignored local directory
`release/axterm-linux-ftp-ascii-20260924/`; `bun run release:hashes:check`
passed again against that copy. This directory is not part of the independent
source snapshot or a public release.

## Installed DEB and AppImage result

The local test image contained an older installed `axterm 0.10.0`, so the
first `scripts/test-linux-deb.sh` invocation correctly refused to replace it.
In a fresh disposable container, that image-owned package was removed before
installing the newly built DEB. The first installed suite then found missing
test-host `python3-gi`; the GTK icon lookup test could not import `gi`. After
installing the same `python3-gi`, `gir1.2-gtk-3.0` and `squashfs-tools`
prerequisites used by the Linux CI workflow in another fresh container, the
full gate passed:

```text
sh scripts/test-linux-deb.sh release/axterm_0.10.0_amd64.deb
23 passed, 8 skipped, 0 failed
bun run test:appimage:linux
Verified Linux AppImage: 145979132 bytes; SquashFS offset 188392;
SPDX 85a7b382a1e3cd8664ddc385b592f716a5fc7b7c48a7afd435213edc48b545d6;
app.asar c21ec93bb24d73de6102eacb6125618bae6e74817828b74af2cb304061dce74b
```

The DEB gate checked the installed version, launcher protocol registrations,
installed Resources against the sidecar and all Linux-applicable packaged
journeys. These include the current FTP Widget's binary and curl ASCII
upload/download paths, TRZSZ/ZMODEM/XMODEM, Legal/About, migration and
recovery, four-locale switching, GTK launcher icon lookup, window behavior,
independent startup and prior-schema/Vault upgrade. The eight skips were six
Windows-only journeys, one historical-packaged-release journey without its
optional artifact, and one opt-in SSH fixture. The gate removed the newly
installed DEB on exit. AppImage verification extracted its SquashFS payload
without executing the runtime, found the required legal files and matched
its Resources to the same sidecar.

## Limits

The test used emulated Linux x64 in Docker Desktop, not native Linux hardware
or a logged-in desktop. The local image ID is not a registry-pinned public
build environment. The historical binary upgrade and external SSH fixture
were not exercised in this run. This evidence does not establish Windows
packaging, signing, a public updater feed, a released migration window,
independent protocol/security or source-rights review, or owner release
approval. IR-04 remains In progress and IR-13 remains Open.
