# IR-04 macOS packaged FTP active-mode stall — 2026-09-25

Status: **source and fresh unsigned macOS arm64 directory package verified;
IR-04 remains In progress**.

The previous [passive-stall record](IR04-MACOS-FTP-STALLED-DATA-2026-09-25.md)
checked that a partially uploaded file was not published after a passive data
socket became idle. This follow-up covers FTP `PORT` active mode and the
server's shorter 15-second active-data inactivity timeout.

The source Adapter now has a constructor-only timeout seam so a real-TCP
regression can exercise active-mode inactivity in 300 ms without changing the
production 15-second default. The test opens an active data listener, sends
partial bytes to an existing destination, observes a nonempty `.part` file,
then requires a `426` transfer-failure reply. It checks that the original
destination is unchanged, the staging file is gone and `NOOP` receives `200`
on the **same** authenticated control connection. The focused FTP Adapter
file passed **33/33** tests.

A local unsigned macOS arm64 directory package was made for the first trial:

```sh
node scripts/package-desktop.mjs --dir \
  --output /tmp/axterm-ftp-active-stall-package.wCnIqt
AXTERM_PACKAGED_APP=/tmp/axterm-ftp-active-stall-package.wCnIqt/mac-arm64/Axterm.app \
AXTERM_PACKAGED_FTP_ACTIVE_STALLED_TRANSFER=1 \
bunx playwright test --project=packaged \
  -g 'packaged FTP Widget runs the independent server'
```

The directory-package journey passed **1/1** in 19.7 seconds. Because
`package-desktop.mjs` does not rebuild the TypeScript/Electron output and this
trial preceded the next full build, that directory package is **not** used as
proof that the updated timeout-seam source entered its app archive. The later
[rebuilt DMG independent-install record](IR13-MACOS-CURRENT-DMG-INSTALL-2026-09-25.md)
supersedes its package identity for current-source evidence and passes the
same active-stall scenario from the installed copy.

System `curl` used
`--ftp-port -` to open an active data connection and streamed partial bytes
from standard input while leaving it open. The test observed a nonempty
staging file and its removal between 14 and 30 seconds, **before** terminating
the still-open curl process. The existing target stayed unchanged; a new
authenticated FTP session received `200` for `NOOP`. Curl itself waits for
standard input and was not used as the server-timeout clock: an initial test
assertion against curl's own 40-second maximum failed for that reason and was
replaced by direct observation of server cleanup. The raw source regression,
not the curl client, verifies the `426` and same-control-session semantics.

The directory journey copied the app outside the checkout. Its actual packaged
Resources matched a newly generated and verified macOS arm64 SPDX sidecar.

| Item                           | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| FTP server source              | `2e492b14abbd3b763eaf246bd55204dda9b0fcd3d76c6256b8a623e2e495d42c` |
| FTP Adapter test               | `cbe010d388871e83c3c71dd6041414863056c59d814d5eda7a39f529a1b38b2e` |
| Packaged journey source        | `c91df409b58153faa85d912a0e4bc80fa8328c8011933dd5ff9ad7d5dfc6ed16` |
| macOS `app.asar`               | `61c208e6a7b324efa2c2c8ef7ac3d2d0b8385e45d83c2a6915bdf4a4f3497360` |
| Verified packaged SPDX sidecar | `2899752e890d83f7bb636d53dc04605f4af84cc484b53c7d285775a52f0a7882` |

This is local macOS engineering evidence, not an independent protocol or
security review, a hostile-filesystem confinement proof, Windows/native-Linux
installed evidence, rights approval, signed/notarized distribution or a
public-release upgrade. IR-04 stays **In progress** and IR-13 stays **Open**.
