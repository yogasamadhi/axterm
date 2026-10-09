# IR-04 Linux arm64/x64 FTP Widget source smoke — 2026-09-21

## Result

The optional commands below passed in local Docker Linux runtimes. The script
accepts only explicit `linux/arm64` and `linux/amd64` targets, passes the
matching expected Node architecture into the container, and fails if the
container reports a different architecture.

```text
bun run test:ftp:linux-container
linux-arm64-ftp-rename-overwrite=pass
linux-arm64-ftp-pasv-lifecycle-smoke=pass bytes=8196

AXTERM_LINUX_FTP_TEST_PLATFORM=linux/amd64 bun run test:ftp:linux-container
linux-x64-ftp-rename-overwrite=pass
linux-x64-ftp-pasv-lifecycle-smoke=pass bytes=8196
```

`scripts/test-linux-ftp-widget-container.sh` defaults to the locally cached
official multi-architecture Bun image pinned at
`oven/bun@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6`.
That digest was inspected for both requested Linux architectures. The script
runs a bind-mounted working tree as read-only with a read-only container root,
no Docker network, no-new-privileges, a bounded PID limit and a 64 MiB
temporary filesystem. The protocol script creates and removes only exact
`/tmp` directories in the container.

The source smoke loads `NodeLocalFtpServer`, binds loopback and uses the
existing separately published `basic-ftp` client to verify authenticated PASV
listing, 8,196-byte binary upload, byte-exact download and wrong-password
rejection. It then uses raw local TCP control/data sockets to cover the two
PASV lifecycle regressions that must also survive the Linux runtime boundary:

- `PASV` → `RETR` without a data connection → `ABOR` returns transfer `426`
  and command `226` within five seconds, releases the passive listener for a
  fresh `PASV`, and leaves the authenticated control session usable for `NOOP`.
- Four simultaneous same-peer connections against one announced PASV port
  leave exactly one retained data socket; that socket completes a real `RETR`.

Both selected container architectures completed that extended path on
2026-09-22. It has no production dependency addition and does not access an
external network, repository write path or user file.

On 2026-09-23 both architectures also exercised the actual FTP `RNFR`/`RNTO`
rename-overwrite path through `basic-ftp` and `NodeLocalFtpServer`: a staged
regular file replaced an existing regular file with the expected new bytes,
and the staged pathname disappeared. A second staged file could not replace
an in-root symlink pointing to the existing file (`550`); the existing bytes
and rejected stage remained unchanged until the client explicitly removed the
stage. The focused script unit test passed `1/1` before both container runs.

## Current worktree recheck — 2026-09-24

Both pinned-container commands were rerun from the current working tree after
the latest migration and localization changes. The arm64 run reported
`linux-arm64-ftp-rename-overwrite=pass` and
`linux-arm64-ftp-pasv-lifecycle-smoke=pass bytes=8196`; the explicit amd64 run
reported `linux-x64-ftp-rename-overwrite=pass` and
`linux-x64-ftp-pasv-lifecycle-smoke=pass bytes=8196`. These runs revalidate the
source FTP implementation for this worktree; they are not a clean-clone or
packaged-app run and do not expand the scope limits below.

## Scope limit

This is Linux **arm64 and x64 source-runtime** evidence only. `basic-ftp` is a
retained test client, not the independent system client proven by the separate
macOS `curl` journey. It is not an Electron package build, installed
AppImage/DEB smoke, native-module rebuild, updater/signature verification or
independent security/source-rights review. It also does not prove replacement
atomicity on third-party FTP servers, Windows filesystems or native Linux
hardware. Accordingly P-03/IR-04 remains
**In progress**, and IR-13 remains **Open**.
