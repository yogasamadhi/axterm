# IR-04 FTP Linux container source-runtime evidence

Date: 2026-09-24  
Scope: Current uncommitted working-tree source, executed in the pinned Bun Linux
container from a Darwin arm64 host. This is a source-runtime smoke, not an
installed or packaged-app result.

## Reproduction

The script mounts the checkout read-only, disables container networking, uses a
read-only root filesystem and enables `no-new-privileges`:

```sh
AXTERM_LINUX_FTP_TEST_PLATFORM=linux/arm64 sh scripts/test-linux-ftp-widget-container.sh
AXTERM_LINUX_FTP_TEST_PLATFORM=linux/amd64 sh scripts/test-linux-ftp-widget-container.sh
```

Image: `oven/bun@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6`

Observed output:

```text
linux-ftp-nvt-ascii-rest=pass offsets=2,5
linux-arm64-ftp-rename-overwrite=pass
linux-arm64-ftp-pasv-lifecycle-smoke=pass bytes=8196
linux-ftp-nvt-ascii-rest=pass offsets=2,5
linux-x64-ftp-rename-overwrite=pass
linux-x64-ftp-pasv-lifecycle-smoke=pass bytes=8196
```

The smoke authenticates against the current `NodeLocalFtpServer`, checks
directory listing, binary upload/download, replacement/rename behavior,
wrong-password denial, pending-PASV abort cleanup and single-peer passive
socket handling. The ASCII path checks `TYPE A`, transfer-octet `SIZE`, NVT
`RETR`, Linux newline conversion on `STOR`, and `REST STOR` boundaries inside
CRLF and CR-NUL followed by byte-identical NVT re-download.

Source SHA-256 values at execution time:

| File                                                            | SHA-256                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/runtime/src/adapters/widget/node-local-ftp-server.ts` | `8015d9aff9a655dde2091ad2dae5ae1914cd967dfc6308229c2c8f3f1f71e7e2` |
| `scripts/test-linux-ftp-widget-container.mjs`                   | `16437d3cceb7efb8cfbdf7c8231804d069cb4521735a80ecf88d812966c4d598` |

## Limits

This run verifies Linux Node runtime behavior in containers only. It does not
verify a native Linux host, packaged DEB/AppImage, installer/upgrade path,
Windows, an independent protocol/security review, source rights, or IR-04
acceptance. It supplements but does not replace the separate native/package and
review evidence required by the independent-release matrix.
