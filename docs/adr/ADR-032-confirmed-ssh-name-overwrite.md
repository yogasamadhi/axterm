# ADR-032: Confirmed replacement of a saved SSH destination with the same name

Date: 2026-10-11
Status: Implementation decision requested by the owner; evidence is recorded in STATUS.
Amends: ADR-005 and ADR-031 for explicitly confirmed same-name creation.

## Decision

Adding an SSH destination whose display name already exists asks the user to cancel
or overwrite. Cancellation preserves the draft and performs no credential or saved
destination write. Overwrite continues the selected save, save-and-new or
save-and-connect action with the new form's complete settings. Blank new credentials
do not retain the old destination's credentials. Ordinary editing of an existing
destination retains its established partial-update semantics.

Extend the existing REST create command with an optional explicit `overwrite`
target containing a Host ID and the version reviewed by the user. An ordinary create
still rejects duplicate names. The Runtime validates the target version, exact name
and Bookmark tree ETag before writing either aggregate, then updates that Host in
the same SQLite Unit of Work as its Bookmark. Keep the Host ID and existing first
SSH Bookmark ID; if no Bookmark exists, create one. Other Bookmarks and jump/tunnel
references continue to reference that Host and therefore use the new connection
configuration. Explain shared-reference behavior in the confirmation. Historical
snapshots remain unchanged. No schema migration or new IPC is introduced.

The create schema supplies all defaults so replacement resets omitted optional
settings and credential references. The first existing Bookmark in tree order gets
the submitted complete presentation and placement; other Bookmark presentation
remains independently owned. The returned Host/tree versions advance normally.
Stale versions fail without replay; the next save fetches fresh metadata and asks
again. A concurrent duplicate appearing after preflight causes one fresh preflight
and confirmation, never an implicit overwrite.

Vault writes start only after confirmation. Failed aggregate writes clean up newly
created credentials; successful replacement cleans up superseded references through
the existing shared-reference-aware Vault path. Secrets stay in the form and local
async scope, never in confirmation state or metadata caches.

## Acceptance

Verify cancel/Escape, all three submit actions, new authoritative values and cleared
optional settings/credentials, a retained Host without a Bookmark, shared references,
stale Host/tree versions, unconfirmed conflict and complete rollback on a late
Bookmark write failure. Exercise isolated Electron and packaged Mac journeys and
record full-check results without relaxing existing gates.
