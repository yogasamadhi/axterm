# IR-04 current macOS packaged FTP ASCII interoperability evidence

Date: 2026-09-24  
Scope: Current working-tree source packaged as an unsigned macOS arm64 directory
app, then exercised by the packaged Playwright FTP Widget journey outside the
checkout.

## Build and verification

The repository's standard `bun run check` passed immediately before packaging.
The application was built into a newly created empty temporary output directory
with the repository packaging wrapper; the existing `release/` directory was
not used:

```sh
node scripts/package-desktop.mjs --dir --output <empty-absolute-temp-directory>
```

The current `app.asar` SHA-256 is
`799337ec867670e7fe03ca2eea8c8efa85a552219e8899a88f79f63a0e0f628d`.
A packaged SPDX sidecar was generated and compared against the app's actual
Resources directory. The comparison passed with sidecar SHA-256
`885e9ec091fc798266bbebe55f3bffd907d8fddd11700c042844bbb33c940956`.

The focused packaged journey passed **1/1**:

```sh
AXTERM_PACKAGED_APP=<Axterm.app> bunx playwright test --project=packaged \
  --grep 'packaged FTP Widget runs the independent server outside the source checkout' \
  --output <isolated-absolute-temp-directory>
```

It starts the packaged app outside the repository, grants a temporary test
directory, starts the loopback FTP Widget and checks login/list, binary
upload/download, rename, passive and active data connections, ASCII upload and
download through curl, and clean Widget shutdown. The ASCII fixture verifies
host-newline conversion; the upload uses curl `--crlf --use-ascii`, and the
download uses `--use-ascii`.

## Limits

This verifies the current unsigned macOS arm64 **directory package** only. It
does not establish a signed/notarized DMG, Windows or Linux installed package,
upgrader behavior, an independent protocol/security or source-rights review, or
IR-04 acceptance. See also the [Linux source-runtime container evidence](IR04-FTP-LINUX-CONTAINER-2026-09-24.md).
