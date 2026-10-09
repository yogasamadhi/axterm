# ADR-019: Atomic no-replace publication on hard-link-limited filesystems

Status: Proposed — macOS arm64 implementation trial verified; release adoption pending

Date: 2026-09-24

Relates to: ADR-016, ADR-018, P-02 / IR-03

## Context

Axterm receives terminal-transfer bytes into a private same-directory staging
file. The normal `link(staging, destination)` publication is atomic and cannot
replace an existing destination. The previously used fallback for filesystems
rejecting hard links was `copyFile(..., COPYFILE_EXCL)`. That preserved the
no-overwrite property but was **not atomic**: the destination could be observed
before copying finished, and an interrupted copy could leave an incomplete
destination. The current worktree uses a native no-replace rename trial in
place of that fallback. A check-then-`rename()` sequence is not an acceptable
substitute, because the final rename can replace a file created after the check.

This gap affects XMODEM, ZMODEM and TRZSZ on removable, networked or otherwise
hard-link-limited destinations. It does not make the current hard-link path
unsafe, but it prevents claiming the fallback has the same staged-publication
guarantee. IR-03 remains unaccepted until the actual target filesystems and
packaged platforms are tested.

## Proposed decision

1. Keep the same-directory hard-link path when it succeeds. Replace the
   direct-to-final `COPYFILE_EXCL` fallback with a **native atomic no-replace
   rename** of the already complete staging file. On a platform or filesystem
   where the required native primitive is unavailable, fail explicitly and
   clean the private staging file; never silently fall back to a non-atomic
   visible copy or check-then-rename.
2. Evaluate pinned `@openclaw/fs-safe@0.13.1` as the candidate native provider.
   Prefer its public `@openclaw/fs-safe/durability` `publishFileExclusive()`
   with `strategy: 'rename-noreplace'` over reaching into the native binding:
   this interface returns a publication/directory-sync receipt and preserves
   the final file after a post-rename verification or sync failure. A local
   macOS arm64 Node 24.18.0 proof of concept is recorded separately. A normal
   collision is raw `EEXIST`; missing native support is `helper-unavailable`.
   The exact package is now pinned in the worktree's production graph and an
   unsigned macOS arm64 DMG has passed local tests. This is an implementation
   trial, **not** authorization to publish a commercial release before the
   remaining rights, filesystem and platform review gates pass.
3. Preserve the Runtime ownership and Host File Grant boundary. The native
   operation, if adopted, belongs only in the Runtime Adapter and must not
   introduce Renderer Node access, Electron Business IPC, unbounded buffering,
   or any dependency on Legacy Prototype source.
4. Because the public publication API is **asynchronous**, XMODEM's EOT path
   has an explicit pending-publication state, with cancellation, destroy
   and new-session generation fenced against late completion. This lifecycle
   and the native fallback are now implemented in the worktree; ZMODEM and
   TRZSZ already have async commit paths. A
   successful rename **consumes** the staging pathname while a hard link does
   not, so adapt all three callers' completion and cleanup paths under tests.
   They must emit completion only after publication is established, preserve
   an existing destination on collision, avoid stale `.part` files, and avoid
   treating a post-rename verification or directory-sync error as proof that
   no final file exists. Inspect the public failure receipt's `targetCreated`,
   `cleanup` and `phase` before mapping the error to existing transfer semantics;
   do not expose paths to Renderer or logs. Do not import the library's private
   native binding or substitute a check-then-rename for the missing sync API.
5. Before release adoption, review the exact library and seven optional native package
   artifacts, license/copyright texts, source-to-binary provenance and platform
   support; pin exact versions and integrity in `bun.lock`; include only the
   selected native binary and applicable notice in each installer and SPDX
   sidecar. Verify Electron embedded Node, Headless Node, macOS arm64,
   Windows x64 and native Linux x64 package behavior, including a real
   hard-link-limited filesystem or equivalent syscall-level fixture. An
   optional-package omission must fail closed, not silently weaken guarantees.
   The current [macOS source/binary and Rust dependency handoff](../implementation/evidence/IR11-FS-SAFE-NATIVE-SOURCE-2026-09-24.md)
   finds a successful local build but nonidentical published bytes and 61
   target-normal source package identities requiring notice review. The
   final-public gate therefore requires a separate reviewed native-dependency
   ledger; this proposed ADR does not treat a passing package test as rights
   or reproducible-build clearance.

## Alternatives considered

- Keep direct `COPYFILE_EXCL`: rejects existing files but may expose a partial
  destination; does not satisfy staged-publication semantics.
- Copy to another hidden name, then `fs.rename()`: hides incomplete bytes but
  Node's rename has no no-replace option, so a concurrent destination can be
  overwritten.
- Remove fallback and accept only hard-link-capable volumes: safe as an
  interim containment policy, but not the desired three-platform/filesystem
  capability. This is not treated as IR-03 completion.
- Add a project-owned N-API binding: possible, but substantially increases
  platform implementation and maintenance work. It remains an alternative if
  the candidate dependency fails provenance, packaging or behavior review.

## Acceptance and rollback

Do not mark this ADR accepted for release adoption until the native provider
choice and release dependency/notice review are recorded. Do not mark IR-03
Accepted until full protocol, collision, interruption, cleanup, real-filesystem
and installed-platform tests pass. If the provider fails these gates, retain
the previous product behavior only as a documented migration-period limitation,
or use the implemented fail-closed policy with explicit user-facing errors;
neither path is a commercial-release acceptance claim.
