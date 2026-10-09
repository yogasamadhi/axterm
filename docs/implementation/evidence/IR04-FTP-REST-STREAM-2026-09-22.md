# IR-04 FTP REST STREAM conformance — 2026-09-22

Status: source-level protocol evidence; IR-04 remains **In progress**.

## Normative behavior

The implementation was checked against the RFC Editor copies of
[RFC 959 REST](https://www.rfc-editor.org/rfc/rfc959.html) and
[RFC 3659 section 5](https://www.rfc-editor.org/rfc/rfc3659.html#section-5).
RFC 3659 requires a STREAM-mode restart implementation to advertise the exact
`REST STREAM` feature line. It also makes `REST` the last command before the
transfer that consumes it and tells a client to send a new `REST` when that
following transfer command was not successfully transmitted.

## Implemented behavior

- `FEAT` now includes the exact one-space-indented `REST STREAM` line.
- A valid decimal `REST` marker is consumed by the immediately following
  `RETR` or `STOR` attempt before pathname, offset or data-connection
  validation. A failed attempt therefore cannot leak its offset into a later
  transfer. Invalid syntax clears any earlier marker.
- An intervening non-transfer command clears the marker. This deliberately
  chooses RFC 3659's permitted “silently ignore the inappropriate restart”
  behavior for a badly positioned `REST`.
- Resumed `RETR` starts at the requested octet and still uses an
  `O_NOFOLLOW` regular-file handle.
- Resumed `STOR` opens the existing regular file without following its final
  component, streams only the prefix before the restart offset into the
  private root-anchored staging file, appends the new data stream, and then
  atomically publishes it. It rejects a missing/non-regular source, an offset
  beyond the current size, a symlinked source, a changed source identity or a
  changed destination parent.
- `REST 0` retains ordinary complete-transfer behavior. The server does not
  perform a non-atomic copy fallback when the final rename crosses a mounted
  filesystem.

## Verification

The focused command:

```text
bunx vitest run packages/runtime/src/adapters/widget/widget-server-adapters.test.ts
```

passes one file and 17 tests on macOS arm64. The new raw TCP control/data
fixture verifies the exact `FEAT` line, full data after a failed `RETR`, full
data after an intervening `NOOP`, a byte-exact resumed `RETR`, rejection and
consumption of an out-of-range resumed `STOR`, an ordinary full `STOR` after
that rejection, and a byte-exact resumed `STOR` that preserves the old prefix
and truncates the obsolete tail. A separate POSIX fixture holds resumed
`STOR` open, replaces its source pathname, resumes the data socket and requires
`426`, unchanged original/replacement bytes, no staging file and a usable
authenticated control connection.

## Deliberate limits and remaining gates

These fixtures use local raw sockets and the current macOS filesystem. They do
not prove interoperability with an independently operated server/client,
Windows rename behavior, native-Linux installed-app behavior, disk-full or
permission-loss handling. The final identity check and publication use Node's
path-based APIs rather than an OS-specific `openat`/`renameat` transaction, so
the residual final-operation interval remains an explicit independent-security-
review item. This evidence is not source-rights approval, signed distribution,
remote CI or IR-04 acceptance.

## Deterministic partial-write failure cleanup — 2026-09-23

The production FTP staging stream still defaults to Node's `createWriteStream`.
A narrow constructor-supplied stream factory lets the test replace only that
filesystem boundary. For each of `ENOSPC`, `EACCES` and `EIO`, both ordinary
`STOR` and `REST 4` followed by `STOR` write exactly 64 real bytes to the
private `.part` file before the injected write failure. The resumed case first
copies the old four-byte prefix through the production writer, then fails its
append writer while the data and control connections are open.

All six raw TCP regressions receive `150` followed by `426`, find no `.part`
file, and successfully issue `NOOP` on the same authenticated control
connection. Ordinary `STOR` publishes no target. Resumed `STOR` leaves the
original target byte-for-byte unchanged. The focused server suite passes 24
tests on macOS arm64.

A deliberate pre-evidence `bun run candidate:check` copied 762 source files
and 16,486,371 bytes with tree SHA-256
`82ed1a3de4bc2de83877c4734123fe76735a081e37e2d9be8f90ee6e8525001b`.
Its temporary commit `55a2f430810b98dc3ba8fb3201676918c1189e7f` and clean
clone each tracked the same 762 files. Frozen installation and the clone's
complete gate passed: 217 test files with five skipped files, 981 tests with
33 skips, 368 architecture modules / 1,314 dependencies, 267 Contract
operations, build/layout and seven visual plus two accessibility journeys.

This closes the deterministic source-level partial-write cleanup gap. It does
not test a physically full volume, actual ACL/quota/mount loss, Windows or
native-Linux installed behavior, or the residual path-based final-operation
interval. Independent protocol/security and source-rights review, final
cross-platform package evidence and IR-04 acceptance remain open.

## Current packaged macOS FTP default-path regression — 2026-09-23

After the partial-write fault-injection boundary was added, `bun run
package:dir` built an unsigned macOS arm64 directory app from the current
worktree. Its `app.asar` is 101,556,447 bytes with SHA-256
`339af8aa667f87d106d473d4c8e30b0fe50e1e5e671d3489fd11d6b82746875e`.
The focused packaged Playwright FTP journey passed one of one. It copied the
app outside the checkout, launched with a restricted `PATH`, used `basic-ftp`
for authenticated list and upload, then used the system `curl` client for
passive-mode list/binary upload/binary download and active-mode upload/download.
All transferred payloads matched byte-for-byte and the Widget stopped cleanly.
The complete current `bun run test:packaged` run also passed 17 macOS-applicable
journeys, with ten explicit Windows/Linux, historical-package or optional-SSH
fixture skips. It includes this FTP journey, all three terminal-transfer
protocols, licenses/About, migration, four-language switching and prior-schema
Vault upgrade.

This confirms that the production `createWriteStream` default still works in
the current local package. It is not a fault-injected installed-app test, a
signed DMG installation, or Windows/native-Linux evidence. IR-04 remains
**In progress**.

## FTP text-replacement data-loss guard — 2026-09-23

The FTP client adapter's `replace` operation previously deleted the existing
destination before sending `RNFR`/`RNTO`. A server refusal or transport error
after that deletion could remove the user's original text even though the
save failed. The adapter now attempts the server-side rename directly and
never issues `DELE` for the destination. A permanent `550`/`553` refusal is
reported as unavailable safe replacement; the higher-level text-save path
removes only its staged temporary file. Unexpected transport failures remain
distinct because the server-side outcome may be unknown.

The independent local FTP Widget server now accepts replacement **only**
when the source and existing destination are ordinary files under the granted
root. It checks source, destination and target-parent filesystem identities
before the final rename and continues to reject symlink or directory targets.
This preserves the own-server text-save workflow without restoring the
client-side delete-first behavior. A third-party FTP server that refuses
rename-overwrite may reject a text save; the original destination remains
intact instead of being deleted to force success.

The focused three-file Runtime suite passed **34/34**. It covers a mocked
rename failure with no client `remove` call, a real TCP FTP server returning
`550` for an existing target with both old and staged bytes preserved, staged
cleanup through the actual text-save service, the own-server successful
regular-file replacement, and rejection of an in-root symlink target. The
application text-save regression checks that a capability failure leaves the
original bytes and no `.tmp` file.
This is source-level macOS evidence, not a guarantee of atomic behavior on
every external FTP server or Windows/native-Linux filesystem. The server's
final path-based rename interval and concurrent changes after the editor's
revision check remain for independent security review. IR-04 stays
**In progress**.

The changed server was then packaged into a separately named, unsigned macOS
arm64 directory app without overwriting the existing `release/` evidence.
Its `app.asar` SHA-256 was
`7c5920f6bf9cad35ad3922940eeea0ca8d131ecb4cbb1cca073ef9b1c6b662f7`.
The focused copied-outside-checkout FTP Widget journey passed **1/1**: a
real FTP client uploaded a staged file, used `RNFR`/`RNTO` to replace an
existing file and observed the replacement content and absence of the staged
path. The full package suite passed **18/28**, with ten conditional
Windows/Linux/historical-package/SSH-fixture skips. This is current local
package evidence for the own-server path, not a signed installer, a third-
party-server atomicity guarantee or cross-platform acceptance.

Both optional Linux arm64 and emulated Linux x64 source-runtime container
smokes now also pass the own-server regular-file replacement and symlink
refusal cases over a real FTP control/data connection. The exact commands,
output and scope limits are recorded in the
[Linux FTP source-runtime evidence](IR04-LINUX-ARM64-CONTAINER-2026-09-21.md).
This closes a Linux source-runtime regression gap; it does not change the
installed-platform or independent-review status above.
