# ADR-020: Owned terminal-transfer stage recovery after an unclean exit

Status: Accepted — repository owner approved all T1 rules on 2026-09-25; T2/T3 implementation and verification remain open

Date: 2026-09-25

Relates to: ADR-013, ADR-018, ADR-019, W-03-02 / T1–T3, IR-03

## Context

XMODEM, ZMODEM and TRZSZ write received bytes to a private same-directory
`.part` file before no-replace publication. Normal cancellation and graceful
Runtime shutdown now await cleanup. A packaged macOS TRZSZ `SIGKILL` probe
nevertheless left one nonempty `.part` file after relaunch. The old process
cannot run its finalizer, and the original Host File Grant is generation-bound.
Finding a name with an Axterm-looking prefix in a user directory does not
prove that Axterm still owns that object. A crash-recovery rule must preserve
user data and the Host's authority boundary; it must not silently scan or
delete arbitrary directory entries.

This ADR defines the **approved T1 policy only**. The approval authorizes
implementation and verification; the current package has no passing
crash-recovery claim until T2/T3 evidence is complete.

## Decision

1. **Evidence of ownership.** A new receive may create a stage only after a
   bounded, durable, app-local ownership record is committed. The record must
   identify an unguessable stage basename, transfer/protocol identity, a
   non-reversible identity of the granted directory, creation time and the
   expected final safe filename. It must not put an absolute file path or
   credential into business SQLite, Renderer state, logs or Realtime events.
   After opening the stage exclusively without following a symlink, record
   its filesystem identity when the volume supplies one. A record that was
   not fully committed or cannot be matched to the actual object is **not**
   permission to delete it.
2. **Fresh authorization.** After restart or Runtime generation replacement,
   the old File Grant is invalid. Recovery begins only when the user explicitly
   selects the destination directory again through the Desktop Host. The Host
   issues a new generation-bound write Grant; Runtime matches its canonical
   root to the private ownership record. No stored path, record or filename
   creates a new Grant by itself.
3. **Default action and prompt.** The default is to leave an interrupted
   stage untouched. Once a fresh Grant and ownership match exist, show a
   path-free prompt with safe filename, protocol, known byte count and age.
   Offer **leave in place** and **remove this verified partial**. Do not
   automatically resume, publish, overwrite a final file or replay protocol
   input. Removal requires an explicit user action and a final identity check
   immediately before unlink. A mismatch, symlink, multiple hard links,
   unsupported file identity or denied access fails closed and offers manual
   guidance, not a broader scan.
4. **Expiry and bounded state.** The review window is **30 days** from
   stage creation. At expiry, mark the ownership record unusable for in-app
   deletion and tell the user on the next relevant visit that manual review
   may be needed; never delete the file merely because time elapsed. Propose
   at most **4,096 pending records**, each at most **1 KiB**, and a **4 MiB**
   encoded-record limit per profile. If the bound cannot be maintained,
   reject new receives safely and offer a user-acknowledged **forget record**
   action that leaves any file untouched; silently dropping the oldest record
   is forbidden. Prune automatically only records whose stage has been
   verified absent or whose deletion was confirmed.
5. **Existing unjournaled files.** Pre-policy orphan stages, including the
   observed `SIGKILL` leftover, are not claimed by a new journal. Do not
   enumerate user directories looking for them. Explain how a user can inspect
   and remove an old partial manually without presenting it as verified
   Axterm-owned data.
6. **Publication and shutdown ordering.** A successful no-replace publish
   consumes or removes the stage according to ADR-019; only after verifying
   that state may the ownership record be cleared. A crash between publication
   and record clearing must not cause deletion of the final file. Normal
   failure, cancellation and shutdown continue to clean only the current
   session's own stage and report failed cleanup; the journal is not a reason
   to suppress an error.

## Architecture and privacy boundary

The Desktop Host remains the sole File Grant authority. The Runtime owns the
transfer lifecycle and product SQLite; the implementation must define a
private, bounded ownership store without putting absolute paths into business
SQLite. Any Host/Runtime coordination uses the existing narrow Host capability
boundary, not Electron business IPC or process-message RPC. Renderer sees
only the allowed selected directory display root and path-free transfer or
recovery state. A journal key or token is not exposed to Renderer, URL,
localStorage, logs or terminal bytes. The proposal does not authorize a
system Keychain, `safeStorage` or any alternative saved-secret provider.

## Alternatives rejected

- Delete every `.axterm-*.part` on startup: a prefix is not ownership proof,
  and there is no fresh Grant after restart.
- Reuse the old Grant or persist it in SQLite: that crosses the
  generation-bound Host authority rule.
- Automatically resume or publish the partial: the peer protocol state and
  final-content completeness are not established after a hard kill.
- Never record ownership and leave all stages forever: safe from false
  deletion, but does not satisfy the required user-visible recovery path.

## Approval and acceptance

On 2026-09-25 the repository owner explicitly approved **all** rules in this
ADR, including ownership proof, fresh-Grant rule, default leave-in-place,
prompt choices, 30-day review window, 4,096-record/4-MiB caps and forget
behavior. This closes T1 policy approval, not T2 implementation or T3 package
and real-volume verification. Any later security-review amendments require an
ADR update before implementation changes.

After approval, T2 must prove the record/write ordering, crash windows,
identity mismatch, symlink/hard-link collision, denied cleanup, double
launch, generation change, prompt/re-Grant and error redaction in source and
current macOS package tests for all three protocols. T3 must test applicable
real Mac volumes and record their actual behavior and hashes; FAT16, ExFAT or
SMB observations must not be extrapolated to NFS. Windows/Linux native
package results and independent protocol/security review remain separate
release gates. Only those results, not this draft, can advance W-03-02 or
IR-03.
