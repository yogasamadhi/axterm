# IR-13 Linux x64 current-source installed-package verification — 2026-09-24

Status: **Current emulated Linux x64 package smoke passed; IR-13 remains Open**  
Scope: current independent source snapshot, Linux x64 DEB/AppImage, installed DEB
journeys, migration/accessibility contrast regression

## Source input and build environment

The verified source input was a disposable independent snapshot prepared from
the current working tree. Its audit reported:

- 810 source files and 18,343,496 bytes;
- source-tree SHA-256 `b2ba44caa8bbcd2c053d73d60c82897577924518cfd4dac6b84137218f9fb599`;
- no findings in any snapshot-audit category.

The builder/test host was macOS arm64 running a digest-pinned Debian Trixie
`linux/amd64` container under Docker Desktop emulation. It was not native Linux
hardware or a logged-in Linux desktop. The container used Bun 1.4.0 and the
official Node v24.18.0 Linux x64 archive, SHA-256
`55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742`.
Frozen dependency installation succeeded with 613 packages. Production build,
Runtime packaging layout, electron-builder packaging, and release hash checks
passed. Output was isolated at `/private/tmp/axterm-linux-fixed.LfTsbv`; the
repository `release/` directory was not used or modified.

## Regression found and fixed

The first installed-DEB suite found serious axe `color-contrast` violations on
the primary actions in the legacy data migration preview and Axterm
configuration migration panel. A diagnostic packaged axe report showed that
the buttons were transitioning from disabled to enabled while their foreground
and background colors were both animated. At the sampled point their actual
foreground was `#9fb0ae`; axe measured contrast ratios as low as 2.76:1.

Primary buttons now transition only their border color. Foreground and
background changes are immediate, so changing the busy/disabled state cannot
create an interpolated low-contrast frame. A unit regression requires this
primary-button transition policy. The packaged keyboard migration journey now
brings the app window to the foreground before exercising focus, which makes
the keyboard check deterministic in the Linux Xvfb session.

## Artifacts and installed verification

| Artifact                                        |       Bytes | SHA-256                                                            |
| ----------------------------------------------- | ----------: | ------------------------------------------------------------------ |
| `Axterm-0.10.0.AppImage`                        | 145,970,915 | `5657b7136659902b9a2e3c68eee9fb8fb99ab823bf55d16d1c42d8701b3ed745` |
| `axterm_0.10.0_amd64.deb`                       | 114,026,668 | `616d15a69bc43d72d6877eb816dd234b3d28d6627fb911e96ce02b3b95021c65` |
| `AXTERM_PACKAGED_ARTIFACTS.linux-x64.spdx.json` |     307,314 | `d0d8adb766503c54a7b1470bf002b89b211cc7ee84641f10494fc88a23254f7f` |
| `AXTERM_RELEASE_ARTIFACTS.linux-x64.json`       |         791 | `6364f81e71ffa250cb94f71cd83b2929c0e18ad0dbd39c9bb44b1fcdcd5c3087` |

The SPDX sidecar bound `app.asar` SHA-256
`1ddad270b74356ca606ee3ce4cce49d133dde8bf1aefc67352b2cddab0d072de`. The
DEB gate installed version `0.10.0` at `/opt/Axterm`, verified the installed
resources byte-for-byte against the sidecar, and ran all 31 packaged journeys:

```text
22 passed
9 skipped
0 failed
```

Both previously failing migration/accessibility journeys passed. Also passing
were the installed-package independent-startup check (with `x11-utils` present),
FTP Widget, TRZSZ/ZMODEM/XMODEM PTY roundtrips, Legal/About, localization and
upgrade journeys. The nine skips were declared Windows-only, historical-package
or opt-in SSH fixtures; no Linux-applicable test was skipped due to a missing
`xprop` dependency. The gate removed the temporary DEB installation on exit.

`bun run test:appimage:linux` extracted the AppImage payload without executing
the AppImage runtime and verified its legal files and SPDX sidecar. It reported
145,970,915 bytes, a SquashFS offset of 188,392, the same SPDX SHA-256, and the
same `app.asar` SHA-256. The release hash manifest independently reproduced
both distributable hashes.

## Limits

This is fresh-snapshot-to-emulated-installed-package engineering evidence. It
does not establish native Linux desktop behavior, signing, a public updater feed,
upgrade from a public migration release, independent legal/source-rights review,
Windows evidence, or owner-created repository acceptance. IR-10, IR-11 and
IR-13 therefore remain In progress/Open as recorded in the matrix.
