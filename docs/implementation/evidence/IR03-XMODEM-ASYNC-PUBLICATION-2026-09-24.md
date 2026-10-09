# IR-03 XMODEM asynchronous publication lifecycle — 2026-09-24

Status: **implementation prerequisite completed; IR-03 remains In progress**.

XMODEM previously published its receive staging file synchronously inside
the EOT handler. The candidate atomic no-replace API in
[ADR-019](../../adr/ADR-019-atomic-no-replace-transfer-publication.md) is
publicly asynchronous, so the receive lifecycle now has an explicit
`publishing` state. After `fsync` and close of the private staging file, the
session waits for `publishStagedFile()` and staging-name cleanup before sending
the EOT ACK, `file-complete` and `session-end`. A rejected publication sends
CAN, reports `session-error` and cleans the private staging name. Retransmitted
EOT bytes are consumed without a duplicate publication or ACK.

Publication is the commit boundary: once EOT starts an uncancellable
filesystem operation, a user cancel or another start request does not pretend
to roll it back. `destroy()` invalidates the session generation and suppresses
late events; the pending operation retains responsibility for removing its own
staging name. A transfer already committing can still create its complete
final file after Runtime session destruction; the caller must not interpret
`destroy()` as an atomic rollback. A later receive on the same session is not
reset or completed by the old operation's settlement.

The focused XMODEM protocol, real local PTY and SSH PTY suites pass **22/22**.
New deferred-publisher tests check no early EOT ACK/completion, repeated EOT,
cancel/start during commit, delayed failure cleanup and CAN, and
destroy/restart generation isolation. The existing hostile-name, collision,
long-name, partial-write, timeout, local-PTY and SSH-PTY regressions remain
passing. The full `bun run check` then passed 222 test files (1,131 passed,
33 skipped), 359 architecture modules / 1,310 dependencies, 267 Contract
operations, build/package layout and 11 visual/accessibility journeys.

This record captured the lifecycle prerequisite **before** native-provider
adoption. The subsequent worktree implementation replaces the `COPYFILE_EXCL`
fallback and handles the public post-rename failure receipt; its macOS arm64
packaged evidence is in
[IR-03 native publication](IR03-MACOS-ARM64-NATIVE-PUBLICATION-2026-09-24.md).
Source rights, qualified attribution, a real hard-link-limited filesystem and
Windows/native-Linux package tests remain open. An error after rename still
cannot be treated as proof that no final file exists.
