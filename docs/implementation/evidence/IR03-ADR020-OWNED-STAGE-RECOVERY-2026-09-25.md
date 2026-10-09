# IR-03 / W-03-02: ADR-020 owned-stage recovery, current macOS engineering candidate

Date: 2026-09-25  
Status: T1 policy approved; T2/T3 Mac engineering probes passed on the current unsigned package; independent IR-03 review and other platforms remain separate gates.

## Decision and implementation boundary

The repository owner approved every rule of [ADR-020](../../adr/ADR-020-owned-transfer-stage-crash-recovery.md)
on 2026-09-25. A private Runtime SQLite ownership store is separate from the
product database and holds an HMAC of the canonical granted directory, not an
absolute path. Each XMODEM, ZMODEM and TRZSZ receiver commits a bounded
prepared record before opening an unguessable same-directory `.part` with
exclusive/no-follow flags, then records the descriptor's filesystem identity.
The identity is refreshed after successful writes: on a real macOS FAT16 image,
an empty file's signed inode changed when the first data cluster was allocated.
Zero inode remains unsupported; a kill between a write and its durable refresh
leaves the record unverified and therefore cannot authorize deletion.
Normal publication/cancellation clears the record only after the stage is
verified absent. A hard kill intentionally leaves the partial and record.

After restart the user opens **Review interrupted downloads** from the
terminal context menu, reselects the directory through a fresh Host write
Grant and sees only matching records with protocol, safe filename, known byte
count and age. The default is leave in place. Removal and forgetting a record
each require two user actions; forgetting does not touch a file. Removal
checks the stage's device/inode, regular-file type, no-follow open and link
count immediately before unlink. Missing, changed, symlinked, multiply linked
or expired stages are not removed. No directory scan, automatic resume,
publish or final-file overwrite is performed. Review/deletion errors returned
to Renderer are path-free.

## Executed evidence

| Scope                 | Command / result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ownership store       | `bun x vitest run packages/runtime/src/adapters/terminal-transfer/owned-stage-journal.test.ts`: **9/9**; prepared-only crash, restart/reselection, inode replacement, symlink, hard link, stale post-publication record, 30-day expiry, 4096-record cap across two store instances, unsafe store symlink and path-free DB bytes.                                                                                                                                                                                                                                                                                                                                               |
| Protocol lifecycle    | `bun x vitest run packages/runtime/src/adapters/terminal-transfer/owned-stage-protocols.test.ts`: **4/4**; all three protocols create verified records and clear them after normal completion/cancellation; denied removal retains all three for user review.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Grant boundary        | `bun x vitest run packages/runtime/src/application/terminal-transfer-recovery-service.test.ts`: **1/1**; nonwrite grant rejected, fresh write grant produces path-free metadata and verified removal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Current macOS package | `AXTERM_PACKAGED_TRANSFER_CRASH_PROBE=1 bun x playwright test tests/e2e/packaged.spec.ts --project=packaged --grep 'hard-kill/restart without publishing incomplete bytes'`: **1/1 TRZSZ**. The same command with `--grep 'hard-kill recovery requires re-Grant'`: **2/2 XMODEM/ZMODEM**. Each test copied the current unsigned `.app`, used a real local PTY peer to create a nonempty stage, hard-killed the process, relaunched the same profile, verified the final file remained absent and the partial remained, reselected the directory through the packaged Host dialog, then explicitly confirmed removal. The review did not contain the absolute destination path. |

An additional `AXTERM_PACKAGED_TRANSFER_CRASH_PROBE=1 bun x playwright test
tests/e2e/packaged.spec.ts --project=packaged --grep 'stale Grant after Runtime
utility generation changes'` probe passed **1/1**: while a nonempty TRZSZ
stage existed, it killed only the Runtime `utilityProcess`, waited for a new
generation in the same desktop app, verified the partial stayed untouched,
created a new local terminal and reselected the directory before confirmed
removal. This is separate from the three full-app relaunch probes above.

The packaged candidate was built by `bun run package:dir`; its
`release/mac-arm64/Axterm.app/Contents/Resources/app.asar` SHA-256 is
`be90deb22e347751e0458be27d96985705d76a509fed2d9f47f2ddbda8c970fe`.
The package is unsigned and not a public release. The package probes use
isolated synthetic files and profiles, not user data. Existing graceful
shutdown and real-protocol source tests remain in
[the earlier IR-03 record](IR03-RUNTIME-GRACEFUL-SHUTDOWN-2026-09-25.md).

## Same-package filesystem matrix

The current package hash above was used for all packaged probes below. Every
destination was a fresh temporary directory; the FAT16 and ExFAT volumes were
real mounted disk images, not mocked filesystem calls.

| Destination                     | Hard-kill/restart TRZSZ, XMODEM, ZMODEM + Runtime utility generation                                                | Normal receive/publication                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APFS host                       | **4/4 passed**: partial retained by default, new Grant, confirmed verified removal; stale generation Grant rejected | Existing current-package local PTY roundtrips; no filesystem-specific fallback needed                                                                                                           |
| MS-DOS FAT16, 64 MiB disk image | **4/4 passed** with post-write identity refresh; no final file published after kill                                 | **3/3 passed** real PTY binary roundtrips; native no-replace rename fallback after hard-link rejection. Atomic publication/collision focused test passed                                        |
| ExFAT, 256 MB disk image        | **4/4 passed** with the same recovery boundary                                                                      | **3/3 passed safe refusal** of unsupported hard-link and native no-replace publication: no incomplete final file, owned stage cleaned. Focused atomic-publication refusal/collision test passed |

Commands: `AXTERM_PACKAGED_TRANSFER_CRASH_PROBE=1` with optional
`AXTERM_REAL_NOHARDLINK_DIRECTORY=<FAT16 or ExFAT mount>` ran
`bun x playwright test tests/e2e/packaged.spec.ts --project=packaged --grep
'hard-kill/restart without publishing incomplete bytes|hard-kill recovery
requires re-Grant|stale Grant after Runtime utility generation changes'`.
For FAT16, `AXTERM_REAL_NOHARDLINK_DIRECTORY=<FAT16 mount>` with `--grep
'roundtrips (TRZSZ|ZMODEM|XMODEM) binary data'` passed 3/3. For ExFAT,
`AXTERM_REAL_NO_REPLACE_DIRECTORY=<ExFAT mount>` with `--grep
'rejects unsafe real-volume publication'` passed 3/3. The corresponding
`staged-file-publication.test.ts` focused suite passed 8 tests and skipped the
opposite conditional case on each volume. macOS may create `._` AppleDouble
sidecars beside a `.part`; those files are not the recorded stage and this
feature deliberately does not claim authority to delete them.

## Remaining before IR-03 acceptance

After the final source and ledger update, `bun run check` passed: 1,267 unit/
integration tests passed (38 skipped), 21/21 visual/accessibility journeys
passed, and the architecture, contract, licensing, source-review, localization
and packaging gates passed. W-03-02 is the Mac engineering scope only;
Windows/Linux native results
belong to the user platform gate. An independent protocol/security reviewer
must still sign off source provenance, filesystem race assumptions and retained
bytes. The previous SMB result is from an earlier candidate; no current-package
SMB or NFS result is claimed. The real-volume matrix cannot be extrapolated to
NFS or a signed installer.
