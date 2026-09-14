# ADR-005: Bookmark aggregate and ordered tree

Status: Accepted  
Date: 2026-09-12

## Context

Axterm's first desktop phases model a saved SSH destination directly as a
`Host`. A `HostGroup` is flat and a Host owns both its connection data and its
place in that flat list. Electerm parity requires a nested, ordered bookmark
tree which can later contain SSH, local, Telnet, Serial, FTP, RDP, VNC, SPICE
and Web sessions. It also requires bookmark-specific presentation, profiles,
history conversion and import/export.

Putting every protocol and tree concern into `Host` would make SSH connection
state the persistence model for unrelated protocols. Copying SSH hostname,
authentication or private-key data into a second bookmark record would instead
create two competing sources of truth and increase the chance that a secret is
written to the product database.

Tree moves also need an aggregate-level concurrency boundary. Entity ETags do
not detect a concurrent sibling reorder, and accepting a Renderer-provided
ancestry path would allow stale or malicious input to create a cycle.

## Decision

`Host` remains the authoritative saved SSH connection target. It owns hostname,
port, username, authentication mode, jump-host relationships and opaque
`credentialRef` values. It also owns bounded connection timeout, keepalive,
compression and reconnect policy settings. Live reconnect attempt counters,
next-attempt timestamps, timers and transport handles belong to the Runtime
`Connection` and are never persisted with the Host. Secret values remain exclusively in the
application-local Desktop Host Credential Vault established by ADR-004.

`Bookmark` is a separate saved-session aggregate. It owns protocol identity,
tree placement and user-facing metadata. An SSH bookmark references a Host by
`hostId`; it does not copy hostname, username, authentication data, passwords,
private keys or passphrases. Later protocol phases may add protocol-specific
safe settings through validated Contract variants. Unvalidated JSON is not a
secret-storage escape hatch.

`BookmarkGroup` is the authoritative nested category model. Every group has at
most one parent and every bookmark has at most one group. Groups and bookmarks
carry stable integer positions within a parent. A tree snapshot includes a
monotonic `treeRevision` and its ETag. A structural mutation verifies that
revision, runs under one SQLite `BEGIN IMMEDIATE` transaction, updates affected
sibling positions, advances the revision once and appends one persistent domain
event in the same transaction.

The Runtime computes ancestry from authoritative database rows before moving a
group. It rejects a destination which is the group itself or any descendant.
Renderer drag paths and expanded state are hints for presentation only and are
never trusted for integrity. Expanded groups, the current search term and the
selected search result are workspace UI state and do not belong in the product
database.

Existing `host_groups` and `hosts` are migration inputs. The forward migration
copies each existing group into the nested BookmarkGroup store and creates one
SSH Bookmark for each existing Host, preserving its group and deterministic
order. The new Bookmark references the existing Host; connection facts and
credential references are not copied. Compatibility Host APIs may remain while
callers move to Bookmark APIs, but they must not become a second writer for
bookmark placement.

Saving a new SSH destination is one Application workflow over the Host and
Bookmark repositories. The workflow writes a Host with a null legacy
`groupId`, writes its SSH Bookmark at the requested BookmarkGroup position,
advances the tree revision and appends both aggregate events inside one SQLite
Unit of Work. Nested repository transactions use SQLite savepoints, so a stale
tree ETag, invalid group or later constraint rolls the Host and all events back.

Deleting a saved SSH destination is also explicit. The caller supplies the
Host ETag through `If-Match` and the independent tree ETag through
`X-Bookmark-Tree-If-Match`. The workflow removes every Bookmark which references
that Host, compacts each affected sibling list, advances the tree revision once,
appends one tree event and then deletes the Host in the same Unit of Work. The
legacy Host delete operation returns a conflict while Bookmarks still reference
the Host, so a foreign-key failure cannot surface as an untyped server error.

Deleting a group promotes its direct child groups and bookmarks into its parent
at the deleted group's position, preserving their relative order. Deleting a
Bookmark does not implicitly delete its referenced Host because another
Bookmark, history item or jump chain may still reference it. Orphan Host cleanup
is an explicit aggregate operation.

Editing one saved SSH row is a Host-and-Bookmark command. The caller supplies
both the Host ETag and tree ETag; the Runtime validates both before the first
write, updates connection facts plus Bookmark title, color, description,
profile and placement in one Unit of Work, compacts the source group when the
row moves, appends it to the target group and advances the tree revision once.
A Host-only edit also advances the tree because `connectionDisplay` is part of
the projected snapshot.

The SSH row delete command removes only the selected Bookmark. It then deletes
the Host in that same Unit of Work only when no other Bookmark, jump-host chain,
recent-connection record or tunnel profile retains it. Otherwise it returns the
remaining Bookmark IDs and explicit retention reasons. A failure during final
Host cleanup rolls back the Bookmark deletion, sibling compaction, tree revision
and events.

Connection history is a separate bounded aggregate rather than a copy of a terminal
session. It keeps at most fifty normalized SSH targets with display name, hostname,
port, username, authentication mode, jump reference, non-secret connection options,
successful connection count and last-connected time. Passwords, private-key content,
passphrases, credential references, terminal bytes and commands are never written to
history. Target identity is the normalized hostname, port and username.
Authentication, jump-host and non-secret connection options are the latest successful
snapshot and may change without splitting the aggregate. A target is updated in place
after its first successful `ready` state; automatic transport recovery for that same
live Connection does not increment count.

The history collection has its own monotonic revision for stable recent/frequency
pagination and clear operations, while each row keeps an entity version for reconnect,
delete and Bookmark conversion. Conversion validates both the history-row ETag and
Bookmark-tree ETag, then creates or reuses the authoritative Host, links a transient
history row, creates one SSH Bookmark and records the idempotency result in one Unit of
Work. The tree advances exactly once. Connection metadata history is enabled by default,
which remains distinct from terminal history: terminal output and command history are
still not persisted. Disabling connection history clears the bounded aggregate and
blocks later recording in the same Runtime-owned settings boundary.
Reconnect requires an idempotency key, but its receipt is deliberately bounded to the
current Runtime generation because the returned Connection ID is generation-scoped.
The in-memory receipt stores only a request hash and parsed result, is capped at 128
entries, rejects a changed request under the same key and disappears on Runtime restart.
Clients must not automatically replay a reconnect across a generation change.

## Consequences

- The Runtime gains BookmarkRepository and BookmarkTreeService boundaries;
  Renderer code continues to use generated REST contracts rather than database
  or Runtime implementation imports.
- Tree search can operate over one bounded tree snapshot. The Renderer derives
  visible rows, ancestor reveal and highlight ranges without putting terminal
  bytes or secrets into React/Zustand state.
- Reordering may update the versions of affected nodes. Clients must refresh the
  returned tree snapshot after a successful move and recover from a stale tree
  ETag instead of replaying the mutation automatically.
- Importers stage credential values through the application-local Host Vault and
  persist only returned references. No startup, settings, import or recovery
  flow probes or offers a system keychain.
- The application-local Host Vault and Runtime SQLite cannot share a physical
  transaction. A desktop form which creates a new credential before saving the
  SSH destination must delete that newly-created, otherwise unreferenced Vault
  entry if the Runtime workflow fails.

## Alternatives considered

- Expand `Host` into a union for every protocol: rejected because it couples the
  SSH connection aggregate to local and remote-desktop session definitions.
- Copy complete SSH connection data into Bookmark rows: rejected because it
  creates conflicting connection facts and risks duplicating secrets.
- Store parent paths or ordered child-id arrays supplied by the Renderer:
  rejected because concurrent changes are difficult to validate and cycles can
  bypass stale client-side path checks.
- Persist the tree only as JSON in AppSettings: rejected because partial updates,
  referential integrity, migration reporting and large-tree queries would be
  weaker than normalized rows.
