# IR-04 macOS packaged FTP stalled-data cleanup — 2026-09-25

Status: **unsigned macOS arm64 directory package verified; IR-04 remains In progress**.

The [long-transfer](IR04-MACOS-FTP-LONG-TRANSFER-2026-09-25.md) and
[slow-download](IR04-MACOS-FTP-SLOW-DOWNLOAD-2026-09-25.md) records establish
that active data transfers can outlast the 30-second control idle limit. This
follow-up checks the opposite case: a client that starts a passive binary
upload, sends partial bytes and then leaves its data stream open without
progress.

The opt-in packaged journey waits until the server has created its `.part`
staging file. The server's passive data-socket inactivity timeout then closes
the stalled transfer after at least 29 seconds. The test requires the upload
to reject, the existing destination to remain byte-for-byte unchanged, and
no `.part` file to remain in the granted directory. A **new** authenticated
FTP session must connect and receive `200` for `NOOP`, proving the packaged
server continues to serve requests after cleanup.

```sh
AXTERM_PACKAGED_APP=/tmp/axterm-isarray-legal-package.Xp737O/mac-arm64/Axterm.app \
AXTERM_PACKAGED_FTP_STALLED_TRANSFER=1 \
bunx playwright test --project=packaged \
  -g 'packaged FTP Widget runs the independent server'
```

Result: **1/1 passed** in 34.4 seconds. The journey copied the unsigned app
outside the checkout. The selected app was an existing local build containing
the current FTP server, not a signed or publicly downloaded installer. Its
Resources again passed `sbom:packaged:check` against the exact macOS arm64
SPDX sidecar.

`basic-ftp` surfaces the remote data-socket closure as
`ERR_STREAM_PREMATURE_CLOSE` and closes its own control client. Two initial
test assertions that expected a direct `426` error and reuse of that client
therefore failed. The final test checks the observable server guarantees and
uses a new client for the recovery probe; it does **not** claim that the old
client remains usable or that its `426` reply was observed by that library.

| Item                           | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| FTP server source              | `4cf2c39b7a5950bc6d69690715665b876dad05683a2d7e7d9e202456469c2541` |
| Packaged journey source        | `dd7b126653b06aee5383fd07103e5e9c4461801cc360d439742ff1b831711a59` |
| macOS `app.asar`               | `b95e9b1fe2f23adde31469fdfc528d8626b65afdf0bf4ebade1a2b9660320796` |
| Verified packaged SPDX sidecar | `d1cc7a893478e2c4f0e0f498324829c0d7ab905892107fd45a55db8d999d4b4d` |

This is a local passive-upload stall, not a hostile-filesystem confinement
proof, an active-mode stall, an interrupted download, Windows/native-Linux
installation, independent protocol/security or source-rights review, or a
signed/notarized release. IR-04 stays **In progress** and IR-13 stays **Open**.
