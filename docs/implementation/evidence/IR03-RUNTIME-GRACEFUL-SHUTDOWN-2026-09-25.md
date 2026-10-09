# IR-03 Runtime graceful-shutdown transfer cleanup — 2026-09-25

Scope: **W-03-02 engineering progress, not W-03-02 or IR-03 acceptance**.
The earlier unsigned macOS DMG was built before these source changes. A new,
isolated unsigned directory app was built from the current source below. Its
protocol roundtrips and an active-receive graceful-quit journey passed.

## Defect and correction

`startRuntime().close()` previously awaited `terminals.closeAll()` but called
`terminalTransfers.closeAll()` without awaiting it. A terminal-close callback
removed its adapter context immediately while ZMODEM `finish()` and TRZSZ
`run()` could still be awaiting staged-file cleanup. Runtime shutdown could
therefore reach database/logger closure and process exit before those `.part`
files were removed.

The transfer boundary now retains cleanup promises even after an individual
terminal context has been deleted. `TerminalTransferService.closeAll()` and
Runtime shutdown await them. ZMODEM `destroy()` returns its memoized in-flight
`finish()` promise, including cleanup already started by a cancel/error;
TRZSZ `destroy()` waits for cancellation and the `run()` finalizer. Cleanup
failures are collected rather than becoming unhandled rejections; Runtime
still closes its remaining resources and then reports the failure. This does
not use Electron business IPC or change the file-grant boundary.

## Verification

```sh
bunx vitest run \
  packages/runtime/src/application/terminal-transfer-service.test.ts \
  packages/runtime/src/adapters/terminal-transfer/terminal-transfer-adapter.test.ts \
  packages/runtime/src/adapters/terminal-transfer/zmodem-protocol.test.ts \
  packages/runtime/src/adapters/terminal-transfer/trzsz-protocol.test.ts
# 4 files: 40 passed, 2 skipped

bun run typecheck
# passed

bun run check
# 1,200 unit/integration tests passed; 38 skipped; 11 visual/a11y passed

AXTERM_PACKAGED_APP=/tmp/axterm-w03-current-package.rcx0j5/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  -g 'packaged app roundtrips (TRZSZ|ZMODEM|XMODEM)'
# 3/3 passed through real local PTYs

AXTERM_PACKAGED_APP=/tmp/axterm-w03-current-package.rcx0j5/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  -g 'removes an active TRZSZ receive stage on graceful quit'
# 1/1 passed

AXTERM_PACKAGED_APP=/tmp/axterm-w03-current-package.rcx0j5/mac-arm64/Axterm.app \
AXTERM_PACKAGED_TRANSFER_CRASH_PROBE=1 \
  bunx playwright test --project=packaged \
  -g 'active TRZSZ receive survives a hard-kill/restart'
# 1/1 diagnostic passed; one staged file remained after restart
```

The new regressions hold cleanup behind a controllable promise and assert that
adapter-wide and Application-wide shutdown cannot resolve early. Real protocol
tests await `destroy()` after nonempty receive staging for both ZMODEM and
TRZSZ, then require the destination directory to contain no partial file.
Additional delayed-cleanup tests exercise already-running ZMODEM cancellation
and TRZSZ `run()` finalization, proving that the destruction promise remains
pending until staged cleanup is released.

The isolated package was created with
`node scripts/package-desktop.mjs --dir --output /tmp/axterm-w03-current-package.rcx0j5`
after the full build; packaging did not overwrite `release/`. Its `app.asar`
SHA-256 is `6c824a22e75192305d9b226d6f1efc218e0fa98c5963b4b2ea0a96bf74fcbc22`.
The three roundtrip journeys each copied that app outside the checkout and
completed binary send/receive through a real local PTY. The additional
journey used a peer that deliberately stopped after its first file chunk. It
first observed a **nonempty** `.part` receive stage, then closed the packaged
app through its normal quit path. After exit, the granted directory was empty
and the final file had not been published. This is an unsigned directory
package, not a signed DMG or hard-crash recovery proof.

The opt-in hard-kill probe used the same package and a fresh isolated profile.
It observed a nonempty TRZSZ `.part` file, sent `SIGKILL` to the copied app's
main process, and relaunched that copy with the same profile. Runtime returned
to `ready`; the final destination remained absent, while **one** staged file
still existed after restart. The probe removed its own temporary directory
only after the observation. This is evidence of a recovery gap, not a passing
cleanup result. It does not identify the orphan as safe to delete merely from
the filename prefix.

| Source file                    | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `terminal-transfer-adapter.ts` | `5182f18dbf8988a2400fc87ad7fa91853cadec2669672b98d7d0ac09625683d2` |
| `zmodem.ts`                    | `a5fa0e8a48655f64991ae9008e698d2485ba735850720a993df26e46c3d4ab38` |
| `trzsz.ts`                     | `b7edb62a0b2a09dac6c2a3b4fc04ecdb1cb1ca73d8ea4cddf1097eac9ae0691e` |
| `bootstrap/runtime.ts`         | `addfb177065ce4289738d87dc83dd9251414422c88f94b5bd0edd9c46c26ab27` |

## Still open

Graceful close is not a hard kill, power loss or OS crash. The controlled hard
kill confirms that a same-directory `.part` can remain. Deleting arbitrary
matching names in a user-granted directory would risk another process's data.
An explicit ownership/renewed-Grant policy and a passing cleanup/recovery test
remain W-03-02 work. No NFS volume is currently mounted
on this Mac, and FAT16/ExFAT/SMB findings are not extrapolated to NFS.
Windows/Linux native packaged verification and independent protocol/security
review remain W-03-03/W-03-01/04. IR-03 stays **In progress**.

## Same-day TRZSZ removal-failure follow-up

A later source correction makes cancellation and post-publication cleanup retry
only the writer's own staged name. An injected `EACCES` no longer disappears
from the cleanup result: the error reaching Runtime is path-redacted, and a
second cleanup attempt can remove the same stage. If publication succeeded,
the final destination bytes are preserved even when stage-name removal fails.
`TrzszSession.run()` also reports a rejected finalizer rather than treating it
as a successful destruction. This is **T2 partial progress**, not T1 policy
approval, T2/T3 acceptance, or hard-kill recovery.

After this follow-up, `bun run check` passed **1,213 unit/integration tests**
with 38 skipped and **21/21 visual/accessibility tests**. A fresh unsigned
macOS arm64 directory app was built with
`node scripts/package-desktop.mjs --dir --output /tmp/axterm-trzsz-cleanup.HWtFnC`.
With `AXTERM_PACKAGED_APP` pointing at that app, two focused packaged journeys
passed: a TRZSZ binary roundtrip through a real local PTY and cleanup of a
nonempty receive stage on graceful quit (**2/2**). The `app.asar` SHA-256 is
`20dab39dbdac3cab06331b5770fde419099034b8ac34da188b1864d73bf11c97`;
the corrected `trzsz.ts` SHA-256 is
`ad0db8ef34088f08508fb83c616a1f79fd6c2225424d2c7384517918e42abdd4`.
The package is isolated under `/tmp`, unsigned, and does not replace a release
artifact. The injection tests establish error handling; they do not prove a
filesystem actually produced `EACCES` on this Mac. The existing hard-kill
probe's one surviving `.part` remains an open gap.

## Declared-size boundary follow-up

An actual TRZSZ peer can report a file size smaller than the bytes it sends.
The first new handshake regression failed against the previous source: Axterm
accepted the extra bytes and reported `session-complete`. `TrzszSession` now
rejects a non-integer, negative or greater-than-announced progress step. In
the same protocol regression, it reports `session-error`, publishes no final
file, removes its own stage and exposes no filesystem path. The focused TRZSZ
protocol/writer suites then passed **22 tests** with one conditional skip.

`bun run build` was run before creating a fresh unsigned Mac arm64 directory
package. Its `app.asar` SHA-256 is
`28d5f26d07f71e90d681ef31e3ce976bef3fdd45804b8e03edc4d4aec53e4828`;
the revised `trzsz.ts` SHA-256 is
`d1e87d3b21bbeef55db3221c1e3a62d56b8623a0fb4b8cdfe988835ec49e43ce`.
With that same package under `/tmp/axterm-trzsz-size-built.4mzWaj`, three
packaged Mac journeys passed together (**3/3**): real-PTY TRZSZ binary
roundtrip, rejection of a peer that misreports its size with no destination
or stage left, and active-receive graceful-quit cleanup. The malicious-peer
fixture source hash is
`be44d15c50e2922fbc26e491610d18c447ecf0800db914b91b22f2a92babce06`.
An earlier package attempt before `bun run build` contained stale Runtime
output and is **not** evidence for the source fix. On the rebuilt package,
the first three-test run had a transient normal-roundtrip timeout; that
roundtrip passed on an individual rerun, then all three passed together on
the subsequent run. This does not establish a zero-flake rate. T1 policy,
hard-kill recovery and T3 real-volume acceptance remain open.

## Binary chunk-header bound follow-up

The independent MIT-licensed `trzsz2@1.2.0` patch now rejects a binary
`#DATA` length that is not a positive safe integer or exceeds **16 MiB**
before `readBinary` allocates its buffer. The first direct-library regression
received `#DATA:16777217` and failed against the previous patch by timing
out; with the new patch it immediately rejects with a bounded, path-free
error. The patch retains its earlier receive-timer cleanup and TypeScript
declaration correction. Four focused TRZSZ test files passed **27 tests**
with one conditional skip.

After `bun run build`, a fresh unsigned Mac arm64 directory app was packaged
under `/tmp/axterm-trzsz-chunk.CNGRVe`; its `app.asar` SHA-256 is
`a45c28c2eb2e20ce71b311eae846f5991988a97412c3efcb83263d236ba45346`.
The applied dependency patch SHA-256 is
`0effa39f50f3bfd008dcacf0a11fadc1f02ca1f4226ce5bbadeaf3ed83dfb050`.
The actual package contains the new guard. Against this same package, four
Mac real-PTY journeys passed together (**4/4**): normal TRZSZ binary-file
roundtrip, declared-size lie rejection, oversized binary chunk-header
rejection with neither final nor staged file, and active-receive graceful
quit cleanup. The malicious peer fixture source SHA-256 is
`0d3a17aa2602e715b6e1aefcfd5e8f78af89028d9af3219f4af35e1b0cddd5dc`.
This is a **binary-header** bound, not proof that every text-mode protocol
line is bounded. T1 ownership/re-Grant policy, hard-kill recovery, remaining
text-mode bounds and T3 real-volume acceptance remain open; W-03-02 and IR-03
are not accepted.

The final `bun run check` for this source passed **1,215 unit/integration
tests** (38 skipped), the architecture/Contract/source/license/build gates,
and **21/21 visual/accessibility tests**.

## Text-mode protocol-line bound follow-up

The patched MIT `trzsz2@1.2.0` receiver now rejects POSIX newline-framed
and Windows `!`-framed protocol lines above **32 MiB** before growing the
decoded line buffer. Both direct-library regression cases first accepted an
oversized line under the previous patch and now reject with a path-free
protocol error. A 10-MiB incompressible text-mode DATA frame and a short
VT100-decorated Windows line still pass; this exercises the bound without
claiming that a Windows native package was tested. The five focused transfer
and third-party-evidence suites passed **63 tests** with one conditional skip.
`bun install --frozen-lockfile` preserved the patched CJS/ESM bytes; their
current hashes and unchanged publisher source-map scope are pinned in the
[IR-02 transfer source-map record](IR02-TRANSFER-SOURCE-MAP-2026-09-24.json).

A fresh unsigned Mac arm64 directory app was built from the patched source
under `/tmp/axterm-trzsz-line.bnyMfm`. Its `app.asar` SHA-256 is
`c876547ed865fdaccd72fde905c13e872a577057302934418809b706a7fc0817`,
and the dependency patch SHA-256 is
`40644404ae0e0bb2a74738d272a50ffa1b68148f7ad44076688055cfd906818e`.
The package contains the guard and the amended MIT modification notice. On
that same package, **6/6** journeys passed: four TRZSZ transfer/safety paths,
the packaged third-party notice check and Legal/About notice rendering. The
oversized-line rejection itself is a direct-library test, not a 32-MiB
packaged-PTY attack replay. The current changed distribution bytes have not
repeated the isolated publisher-source rebuild from the historical
[2026-09-24 record](IR02-TRANSFER-REPRODUCIBLE-BUILD-2026-09-24.md).
Queued peer-buffer limits, T1 ownership/re-Grant policy, hard-kill recovery,
T3 real-volume acceptance and independent protocol/rights review remain
open. W-03-02, IR-02 and IR-03 are not accepted.

## Queued peer-input bound follow-up

The previous `trzsz2` receive queue accepted unlimited pending chunks and kept
consumed array slots until the reader encountered an empty queue. Direct-library
regressions first failed on both facts. A further zero-byte-chunk regression
also failed after the byte-only bound, demonstrating that object overhead
needs its own cap. The local MIT patch now caps queued and partially unread
peer input at **64 MiB and 4,096 queued chunks**, rejects the next chunk
before it is stored, reclaims consumed slots, and resets accounting on drain.
The Runtime
adapter catches the resulting synchronous rejection, emits a path-free session
error, cancels that transfer and does not throw into the terminal output
callback. A session-level regression floods the queue during a real library
handshake and proves one error, no success and session cleanup. Focused library,
adapter and third-party-source-evidence suites passed **62 tests** with one
conditional skip; the direct-library regressions were red before patching.

The current patch SHA-256 is
`16d94b8ddf9558f1e2ff73d3aac254b8fb1f8e8525212d4e8bfd08bb8ccb0694`.
`bun install --frozen-lockfile` reapplied it. The patched CJS bundle is
`333600a28cfd794c0e9eca0c2d8b1b6e32830ab964775332a96382c2359e63a3`
and patched ESM buffer is
`4055e6436d76d0fdde4f388fc3d0bc65de5632a2d48a126e399499182388b065`;
the unchanged publisher maps and ESM transfer hash are pinned in the
[IR-02 source-map record](IR02-TRANSFER-SOURCE-MAP-2026-09-24.json). The
current patch has now repeated an isolated publisher-source rebuild: all 33
distribution files match the installed package after the declared patch;
see the [IR-02 repeat](IR02-TRANSFER-REPRODUCIBLE-BUILD-2026-09-24.md).
That byte match does not settle attribution/source-rights review. The
source-level overflow test is not a packaged 64-MiB PTY flood.

A fresh unsigned Mac arm64 directory app under
`/tmp/axterm-trzsz-queue-final.Vr9Zzj` has `app.asar` SHA-256
`6dae18f0c4979e8acda50943d3552611aa7fcb595d633f7819bfbca69b084325`.
Its archive contains the receive-buffer guard and revised MIT modification
notice. The same artifact passed **6/6** packaged journeys: the legal-notice
payload, real-PTY TRZSZ binary roundtrip, declared-size rejection,
oversized-binary-header rejection, graceful-quit staged-file cleanup and
About's exact license/notices rendering. The Mac package cannot prove native
Windows/Linux behavior.

This removes the known unbounded TRZSZ receive-queue gap, but **does not
accept T2**: T1 policy for trusted `.part` ownership/re-Grant and hard-kill
recovery remains undecided, and T3 real-volume acceptance is pending.

## ZMODEM peer-queue and stage-removal follow-up

The independent ZMODEM adapter already bounded pending peer bytes at 4 MiB,
but allowed up to four million one-byte `Buffer` objects while the user had
not yet selected a destination. It now also caps pending input at **4,096
chunks** and checks both limits before copying an active incoming chunk. A
real `zmodem2` handshake regression queues one-byte frames while selection is
pending; the next frame cancels the session and emits exactly one transfer
error. Ordinary terminal output now retains a copied 17-byte candidate header
tail, not a slice pinning the entire previous output chunk in memory. An
oversized first peer frame now cancels before emitting a start event or
arming an orphan idle timer.

ZMODEM receive-stage cleanup previously swallowed every `close` and `unlink`
failure. A failed removal of the writer's own `.part` name now reaches the
caller as a path-redacted error; a later explicit cleanup retries that same
name. Injected `EACCES` tests cover both cancellation cleanup and failure
after successful no-overwrite publication, confirming final bytes survive.
The two focused suites pass **25 tests, one conditional skip**; typecheck
passes. Current `zmodem.ts` SHA-256:
`beb0e266cfbab87ac1b20a21f7168a986f5f9973193a04b5e926e2b2a18a5b2e`.
The final-source `bun run check` passed **1,231 unit/integration tests** (38
skipped), all architecture/Contract/source/license/build gates and **21/21**
visual/accessibility journeys. The final-guard build produced
an isolated unsigned macOS arm64 directory app at
`/tmp/axterm-zmodem-final.utNsUw/mac-arm64/Axterm.app`. Its `app.asar`
SHA-256 is
`bcfe776b3e0946cec4ff8e97587cc8f364bdc3403236dc8a992cee787d7c81f5`.
Its real-local-PTY ZMODEM binary upload/download journey passed **1/1**.
The tiny-frame flood and injected unlink failures were **source-level**
regressions, not packaged adversarial PTY replays. These are T2 safety
corrections, **not** T1 approval, hard-kill recovery, native Windows/Linux
evidence or T2/T3 acceptance.

## XMODEM in-flight publication shutdown follow-up

After EOT, XMODEM publishes a complete staged file asynchronously. Its
`destroy()` previously reset synchronously and returned before an already
started publication or its stage-name cleanup settled, so Runtime-wide close
could complete early. The session now tracks its in-flight publication
promises, and `XmodemManager.destroySession()` returns the corresponding
cleanup promise to the already-awaiting transfer adapter. A controlled
publication gate proves both the session and manager cleanup remain pending
until the stage is removed; no late completion event is emitted after destroy.
The two focused suites pass **25 tests, one conditional skip**; typecheck
passes. This does not change XMODEM's no-overwrite publication behavior.

The corrected `xmodem.ts` SHA-256 is
`555289a002d4c98ba51762b8648e873f02bfaf7744ad55e45685e0faa5928eee`.
A fresh unsigned macOS arm64 directory app at
`/tmp/axterm-xmodem-shutdown.UxPAk8/mac-arm64/Axterm.app` has `app.asar`
SHA-256
`a377051356329c1d3462547ea7435ad70d811d382013674ec9d2613752786a7a`.
Its real-local-PTY XMODEM binary upload/download journey passed **1/1**.
The final `bun run check` passed **1,233 unit/integration tests** (38
skipped), all architecture/Contract/source/license/build gates, and **21/21**
visual/accessibility journeys. Its first attempt had two unrelated 8–16-MiB
configuration/import tests time out at the default 10-second threshold under
the full concurrent suite. Both files passed together **65/65** on an
unchanged-source focused rerun; the complete check then passed on the same
source without changing tests or timeouts. This is a transient-run record,
not evidence that those tests can be omitted from future release checks.
The delayed-publication shutdown assertion is a source-level regression, not
a packaged SIGKILL or real-volume replay. T1 ownership/re-Grant policy,
hard-kill recovery, T3 real-volume verification and independent protocol
review remain open; this closes **0 W, 0 IR and 0 M1 cells**.

## XMODEM stage-removal failure follow-up

The earlier XMODEM shutdown wait exposed a separate failure path: cancellation
`reset()` and the asynchronous publication finalizer suppressed non-`ENOENT`
stage-removal errors. They could report `session-end` or publication success
while the session's own `.part` name remained. XMODEM now attempts cleanup
of only that generated name twice, reports a path-redacted `session-error`
on cancellation failure, and returns a rejected cleanup promise through
`XmodemManager` and Runtime-wide `closeAll()` on destruction failure. For a
published final file whose stage name cannot be removed, it keeps final bytes
but sends no EOT ACK or `file-complete`; the error is explicit. A transient
first removal failure followed by successful retry still completes normally.

Five new focused cases exercise cancellation, destruction, Runtime adapter
propagation, post-publication refusal and retry. The two affected suites pass
**30 tests, one conditional skip**; typecheck passes. The revised `xmodem.ts`
SHA-256 is
`e2263734c85143228e3bd9280f4a1c8a31d176c8f2c1908fb34b6baa9314ebf0`.
A fresh unsigned macOS arm64 directory app at
`/tmp/axterm-xmodem-cleanup.T6S1gw/mac-arm64/Axterm.app` has `app.asar`
SHA-256
`83150b7a65cc3707008461d95c30f531557afe6200d7f60b62a4b170b0295de5`.
Its real-local-PTY XMODEM binary upload/download journey passed **1/1**.
The final `bun run check` passed **1,238 unit/integration tests** (38
skipped), all architecture/Contract/source/license/build gates and **21/21**
visual/accessibility journeys. Two 8–16-MiB import/export fixtures now use
the existing production batch-replacement interface to construct the same
large command tree; their export-size, import/commit and over-limit rejection
assertions remain. The focused 65-test pair completed in about four seconds
instead of about nine, and the full suite passed without changing timeouts.
The injected `EACCES` cleanup cases are source-level tests, not a packaged
permission-denial or hard-kill replay. T1 ownership/re-Grant policy, crash
recovery, T3 real-volume acceptance and protocol/security review remain
open; this closes **0 W, 0 IR and 0 M1 cells**.

## ZMODEM failed-finalizer and source-close follow-up

Previously, a ZMODEM cancellation whose destination cleanup rejected left
`finish()` before it cleared pending input, direction and session state or
emitted `session-end`. The UI could remain stuck despite a failed cleanup;
`destroy()` then returned the same rejection without retrying the writer's
own staged name. The finalizer now always clears active protocol state,
emits one path-free failure when cleanup itself is the first error, emits
`session-end`, and prevents a new transfer on that terminal while a failed
writer remains. Runtime destruction retries that exact writer once; a
persistent refusal still rejects. A source upload handle that fails close is
also retained for one shutdown retry. `ZmodemReceiveFile` marks its handle
closed only after `close()` succeeds, so a failed close can actually retry.

Three new focused cases cover stage-removal failure/retry, persistent
removal denial and source-handle close retry; one output test covers failed
receive-handle close retry. The two affected suites pass **29 tests, one
conditional skip**; typecheck passes. The revised `zmodem.ts` SHA-256 is
`950b6e13a4bd8a672bf8bc1492dd74e7d7c204327ed61bb6ffaae3a3e9762a2e`.
A fresh unsigned macOS arm64 directory app at
`/tmp/axterm-zmodem-cleanup.6TLsI3/mac-arm64/Axterm.app` has `app.asar`
SHA-256
`0dee18cb2023bba9a5db9c1d43a76027c42de587d8eb369a675daf990dd831bb`.
Its real-local-PTY ZMODEM binary upload/download journey passed **1/1**.
The final `bun run check` passed **1,242 unit/integration tests** (38
skipped), all architecture/Contract/source/license/build gates and **21/21**
visual/accessibility journeys.
Injected filesystem failures remain source-level, not packaged permission
denials or SIGKILL recovery. T1 ownership/re-Grant policy, crash recovery,
T3 real-volume verification and independent rights/security review remain
open; this closes **0 W, 0 IR and 0 M1 cells**.
