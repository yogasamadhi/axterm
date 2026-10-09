# IR-04 macOS packaged FTP slow download — 2026-09-25

Status: **unsigned macOS arm64 directory package verified; IR-04 remains In
progress**.

The earlier [long-transfer record](IR04-MACOS-FTP-LONG-TRANSFER-2026-09-25.md)
verified a 32-second packaged upload and a slow source-level download. This
follow-up adds the missing packaged download direction without changing the FTP
server implementation.

With `AXTERM_PACKAGED_FTP_LONG_TRANSFER=1`, the packaged FTP Widget journey
creates a 36 MiB file inside the granted directory. System `curl` downloads it
at a 1 MiB/s limit. The test requires the transfer to exceed the production
30-second control idle timeout, compares SHA-256 of the complete source and
download, and sends `NOOP` **after** the successful transfer on the same curl
FTP control connection via `--quote -NOOP`; it requires a `200` reply. The
existing 32-second upload and all ordinary packaged FTP/curl checks remain in
the same journey.

```sh
AXTERM_PACKAGED_APP=/tmp/axterm-isarray-legal-package.Xp737O/mac-arm64/Axterm.app \
AXTERM_PACKAGED_FTP_LONG_TRANSFER=1 \
bunx playwright test --project=packaged \
  -g 'packaged FTP Widget runs the independent server'
```

Result: **1/1 passed** in 1.2 minutes. `bun run typecheck` passed. The app
was copied outside the checkout by the journey; the selected package was an
existing local unsigned build containing the corrected FTP server, not a newly
signed or publicly downloaded installer. `sbom:packaged:check` rederived its
macOS arm64 sidecar from the actual packaged Resources and passed.

| Item                           | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| FTP server source              | `4cf2c39b7a5950bc6d69690715665b876dad05683a2d7e7d9e202456469c2541` |
| Packaged journey source        | `83fd4badedde44d9b1350e5afabc2e5deb08e0a154fee6a69e63fb68f401e367` |
| macOS `app.asar`               | `b95e9b1fe2f23adde31469fdfc528d8626b65afdf0bf4ebade1a2b9660320796` |
| Verified packaged SPDX sidecar | `d1cc7a893478e2c4f0e0f498324829c0d7ab905892107fd45a55db8d999d4b4d` |

This checks continuous, rate-limited data rather than a stalled data socket.
It does not establish Windows/native-Linux installation, SMB/NFS portability,
independent protocol/security or source-rights review, signed/notarized macOS
distribution, a public update feed or a customer upgrade. IR-04 stays **In
progress** and IR-13 stays **Open**.
