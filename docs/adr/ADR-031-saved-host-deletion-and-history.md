# ADR-031: Deleted saved SSH targets release their names while preserving history

Date: 2026-10-10
Status: Implementation decision for the reported deletion defect; validation is recorded in STATUS.
Amends: ADR-005's retention rule for a recent connection's primary `hostId`.

## Decision

A user can delete a saved SSH destination and create a new destination with the same
display name. A recent connection's primary `hostId` is an optional link to a saved
target, not a reason to retain that target after its last Bookmark is deleted.
History already owns a bounded, secret-free target snapshot. Keep that snapshot and
detach its saved-host link in the same SQLite transaction as Host deletion.

Other Bookmarks, saved jump chains, tunnel profiles and a history item's actual
`jumpHostId` dependency still retain a Host during single-row Bookmark deletion.
Explicit Host deletion continues to remove all its Bookmarks and sever references,
including historical jump references, under the existing aggregate preconditions.

Detaching history advances affected entity versions and the collection revision,
and emits a persistent `connection-history.unlinked` event so stale ETags and
cursors are rejected and Renderer history queries refresh. Any late deletion
failure rolls back links, versions, revisions and events with the Host and tree.

History never gains credential references or secret material. Reconnecting an
unlinked item follows the existing transient-target path and requests credentials
as needed. Deletion continues through REST and the Runtime Unit of Work; no process,
IPC, database-schema or Credential Vault boundary changes are introduced.

Existing retained Hosts are not silently purged at startup or overwritten during
creation. Users may explicitly delete them through the Host aggregate operation.
They may also choose the confirmed same-name overwrite defined by
[ADR-032](ADR-032-confirmed-ssh-name-overwrite.md).

## Acceptance

Verify single-row and explicit Host deletion after successful connection history,
same-name recreation, preserved historical target/count, history version and revision
changes, stale ETag rejection, genuine shared/jump retention, and complete rollback
after a late Host deletion failure. Exercise both UI deletion paths and the packaged
Mac application with isolated data. Record full-gate failures without relaxing tests.
