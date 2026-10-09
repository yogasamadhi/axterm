# IR-04 macOS packaged FTP long-transfer control lifetime — 2026-09-25

Status: **source and unsigned macOS arm64 directory package verified; IR-04
remains In progress**.

## Defect and correction

The independent FTP Widget previously applied its 30-second idle timeout to
the control socket even while a healthy data connection was actively carrying
an upload or download. A transfer could therefore lose its control session
before the final `226` reply solely because it lasted longer than 30 seconds.

The server now disables the control socket's idle timeout after acquiring the
data socket. Its queued transfer command restores that timeout after data
handling, file publication and the final reply have settled. Data sockets
retain their own bounded idle timeout. An idle control session still closes.
The optional shorter control timeout is a test seam; production keeps the
existing 30-second value.

## Verification

The real-TCP source regressions use a 150 ms control idle limit. One pauses
mid-upload for 300 ms; the other injects a slow file read that pauses
mid-download for 300 ms. Both verify the final `226`, complete bytes, a
subsequent `NOOP` and eventual idle closure of the control session. The full
FTP Widget Adapter file passed **32/32** tests; `bun run build` passed.

An isolated unsigned macOS arm64 directory app was built with:

```sh
node scripts/package-desktop.mjs --dir --output /tmp/axterm-ftp-long-package.EeEQoe
```

The packaged FTP Widget journey copied that app outside the checkout and
passed **1/1** with `AXTERM_PACKAGED_FTP_LONG_TRANSFER=1`. Its separate FTP
client streamed three chunks with two 16-second gaps, proving a total control
silence greater than the production 30-second limit while each data gap stayed
below the data socket's limit. It verified exact uploaded bytes and a successful
`NOOP` on the same session. The ordinary packaged FTP and system-`curl`
regressions in that journey passed too. A first test arrangement continued
using a different, correctly expired idle control session after the long
upload; moving the long upload after that session's assertions resolved the
test-fixture error without changing the product behavior.

```sh
AXTERM_PACKAGED_FTP_LONG_TRANSFER=1 \
  AXTERM_PACKAGED_APP=/tmp/axterm-ftp-long-package.EeEQoe/mac-arm64/Axterm.app \
  bunx playwright test tests/e2e/packaged.spec.ts --project=packaged \
  --grep 'packaged FTP Widget runs the independent server outside the source checkout'
```

The generated macOS packaged SPDX sidecar was rederived from the concrete
`Contents/Resources` directory and passed `sbom:packaged:check`.

| Item                           | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| FTP server source              | `4cf2c39b7a5950bc6d69690715665b876dad05683a2d7e7d9e202456469c2541` |
| FTP Adapter test               | `1dc9fdbaa3f9d6798ea86faaa9e94a28d72895006fbe28d66a53a9c66817e01c` |
| Packaged journey source        | `11803b40e75a0eb1419df96788ef9f7842acacb24212d8bf02f93036b1ff3bd1` |
| macOS `app.asar`               | `61c5be995cdc4963a27ca201980089b805cae882675832d21f78a171c7c4f949` |
| Verified packaged SPDX sidecar | `bae0c5a0428f6d0888f56af358043562e113b6f51486679fc719339f6c419824` |

## Limits

This is a local, unsigned directory package, not a signed/notarized DMG or a
public release. The slow download is verified at source level only, not in
the packaged app. This record does not verify a stalled data socket,
Windows/native-Linux installation, independent protocol/security and
source-rights review, user upgrade, or final release services. The test
uses short data gaps rather than a large real-world payload. IR-04 stays **In
progress** and IR-13 stays **Open**.
