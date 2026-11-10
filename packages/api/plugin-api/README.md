# @axterm/plugin-api

Selected pure DTOs are available from `@axterm/plugin-api/catalog`,
`@axterm/plugin-api/configuration`, `@axterm/plugin-api/terminals` and
`@axterm/plugin-api/desktop`. Storage ownership, transaction participants and
command-journal contracts use `@axterm/plugin-api/storage`. These contracts do not
expose private application repositories or establish final Level 3 acceptance.

Upstream adapted portions retain the MIT notice in `LICENSE`; Axterm additions
and migrated first-party DTOs retain Apache-2.0 in `LICENSE.AXTERM`. See `SOURCE.json`.

The canonical public Remote and branded identity definitions for Axterm Level 3.
This initial surface exports Remote declarations, wire/reflection types, and brand
helpers, generated-artifact reflection types and the `ctx.typert` service contract.
Face-neutral Gateway/access contracts and the stream protocol share this identity;
Host-only service merges are available through `@axterm/plugin-api/host`.
The registry implementation stays private and shares these public definitions on
Host and Client. Engine, UI and further capability interfaces are still being migrated.

Host infrastructure and extension code import these same declarations. Keep this
package and Cordis external in extension bundles and declare compatible peers;
the Axterm installation supplies their runtime identities. API compatibility is
separate from the Axterm application version.

The package contains built JavaScript, declarations, the included license texts and pinned source
provenance. This is local engineering distribution work; no npm publication or
complete Level 3 SDK/ecosystem acceptance is implied.

Storage declarations and backend/domain contracts are also exported from `/storage`.
Host consumers opt into `/host` for Context service declarations and the revocable
schema-bootstrap port. Record declarations require a package owner and reject skip
policies for authoritative data. Relational domains declare owned tables and forward
migrations; their participant handles admit shared transactions without exposing a
native database or prepared statement. Providers and product schemas remain private.

Pure file contracts are available from `/files`, including native grant metadata,
local/remote directory metadata, bounded text results and compact command receipts.
Text bodies are explicit results and must not enter directory or workspace state.
Host consumers use `ctx.connections.openFiles({ protocol: 'sftp' | 'ftp', connectionId }, signal)` from `/host`.
Its lease exposes transport-independent filesystem operations and bounded Node
stream facades. Always close it in `finally` and pass the caller/plugin lifetime.
The connection owner cancels and drains leases on close, reconnect and unload;
no ssh2/basic-ftp channel or native constructor crosses this interface. A canceled stalled
subsystem open can require termination of the owning connection. External code
still runs in the same process with the same OS privileges; a lease is an ownership
contract, not a process security boundary.

FTP creates a separately authenticated channel for each lease; concurrent streaming
copy requires independent source and destination leases. Bounded ranges close the
FTP channel after the requested bytes. FTP has no portable atomic exclusive-create
command: `wx` checks for an existing name before STOR, but another FTP client can
race that check. Atomic replacement is a separate capability and never deletes an
original destination as a fallback.

Selected Host file IO is `ctx.files.open(grantId, 'read' | 'write', signal)`.
Always close the returned lease in `finally`. Its `path` is the selected file name
or the empty directory root; every argument is a portable relative path. A file or
save-target grant admits only that selected name. Consumers get bounded Node
streams and metadata; physical paths, native handles and fs-safe objects stay in
Files. Reads join actual descriptor close; writes stage privately and publish only
after EOF, preserving originals on cancellation or failed replacement. The workflow
owner remains responsible for command reservations and durable outcomes.

Bulk HTTP paths and schemas are exported from `/files`. `GET /api/files/read`
accepts `grantId`, `path` and optional inclusive decimal `start`/`end`; it returns a
binary stream (206 for ranges, 416 for an unsatisfiable range).
`POST /api/files/write` accepts `grantId`, `path`, optional `overwrite=true|false`
and decimal `mode`. Required headers are `Idempotency-Key`, `X-Axterm-File-Bytes`
and lowercase `X-Axterm-File-Sha256`. The 4 GiB upload bound preserves the existing
bulk import limit. Count and hash are checked before publication; retries return
compact durable receipts without repeating IO. Bytes never enter model state or
receipts. These owner-only routes use the same generation-bound authenticated
Connection carrier; credentials never enter the URL.

Transfer DTOs are exported from `/transfers`. Host callers use `ctx.transfers`
with a fresh UUID per explicit command. The Transfers owner reserves create
commands durably before any IO; the same nonce never repeats file or network
activity. Generation-local pause/resume/cancel/conflict/retry controls retain
failed outcomes too. Progress is a separate coalesced realtime stream; durable
history has its own recoverable cursor. A restarted Profile interrupts its former
work without replaying grants, commands or stage cleanup.

Selected write leases can populate a private directory using `writeDirectory`;
its callback receives only a virtual subtree writer. Population failure preserves
the prior destination. Portable directory publication uses a destination-name
preflight and pinned native rename: another OS actor can race the preflight.
Directory modes and timestamps are applied through the same pinned owner.

Connections also provides `listSerialPorts()` and
`openBookmarkTerminal({ kind: 'serial' | 'telnet', bookmarkId, cols, rows, ... }, signal)`
to Host consumers. Only the Connections owner resolves protocol configuration and
Vault credentials; it registers channels with Terminals without exposing native
ports/sockets. Browser consumers keep using `terminals.createTerminal` for these
kinds, and generated `connections.listSerialPorts` for bounded metadata. A canceled
late native open remains owned through its actual close. Physical hardware support
requires actual hardware evidence in addition to mock bindings and enumeration.

Connections exposes tunnel profile CRUD with durable command receipts and
optimistic `"vN"` revisions, plus live `startTunnel`/`stopTunnel` operations.
Profiles and live tunnels are complete Connections model collections, with
durable cursors separate from live revisions. Each native forwarding listener,
SOCKS handshake and stream stays with Connections. A stalled forward/unregister
that cannot be canceled independently revokes its owning SSH connection;
reconnection never replays forwarding. Forwarding bytes stay outside Client state.

Remote desktop metadata and transient credential DTOs use `./remote-desktop`.
The selected Host `ctx.connections.openStream` returns a cancellable stream lease
for approved proxy/SSH-hop routing; callers must await `close()`. Vendor handles
stay private. Credential claims use an authenticated one-time Binary WS protocol, never Remote
results, and must not enter Client
models, durable events or replay journals. Binary streams are generation-bound.

Automation DTOs and typed trigger notifications use `./automation`. Selected Host
owner operations expose an opaque participant for configuration transactions;
terminal output observers stay Host-only and return a disposer. Batch receipts
confirm durable commands, while metadata projections wait for the corresponding
committed cursor. Terminal bytes and command output never enter those models.

Credential brands, constructors, metadata/record types and typed update events use
`/credentials`. Host consumers opt into `/host` for `ctx.credentials` and the
`CredentialsService` interface. Resolve per operation and keep values in Host
execution scope. References never authorize environment/OS secret discovery;
there is only the application-local encrypted Vault provider. No Remote method
returns a resolved secret. Events contain identifiers only. Private providers
re-export the same contracts and retain their lifecycle and contained dispatch.

Saved credential DTOs use `/saved-credentials`; selected Host consumers may use
`CredentialsService.saved` (`SavedCredentialsService` from `/host`). The capability
is optional and absence is unavailable. List/inspect contain metadata only. Managed
create/replace accept a preallocated reference and a non-secret generation/command
marker; physical Vault writes remain owned by the local/shell provider.
Configuration exposes generated credential commands and a metadata-only Client
model. Each UI action creates a fresh UUID and submits its secret once. A duplicate
id is rejected even if its secret differs; query `getCredentialOutcome` after an
uncertain response. Do not retry a secret write, persist its input/hash, or infer
success from an absent item. Readonly reconciliation can confirm an exact existing
mutation marker; deletion without proof stays uncertain. Unload drains accepted
operations before storage, and restart interrupts old running intents without IO
replay. No secret-resolving Remote exists.

Portable configuration DTOs use `/configuration-portable`; format version 1 and
credential/history/authority omissions are retained. Catalog and Automation expose
optional, owner-validated synchronous `configurationImport` participation; a
Connections participant and Terminal facts complete the shared Configuration
transaction. A caller must use the Configuration workflow for cross-owner imports.
It may not write another domain's tables or refresh live rules before commit.
A repeated import command id queries its durable receipt without reapplying an
expired preview. Previews are bounded and generation-local; reconnect replaces the
complete metadata baseline. File bodies use dedicated authenticated streaming HTTP
or the Files owner's pinned leases, with a 16 MiB bound and deterministic cleanup.
`FileGrantActions` is the selected Client create/revoke facade; the Files owner
retains its generated Remote model and native authority. These additive ports do
not certify sync providers, the full SDK/ecosystem or migration cutover.

Sync DTOs use `/configuration-sync`. Configuration owns profiles, the four existing
providers, version-one encryption/category semantics and durable run intents.
`runSync` reserves a fresh command UUID and current generation before provider IO;
`getSyncOutcome` reads its compact outcome without retrying writes. Reconnect
replaces the complete profile/run metadata baseline. Uncertain uploads suspend
automatic work until the user explicitly enables it again. Activation schedules
future intervals; finite headless Profiles start no timer and never replay old work.
Profile update/delete retain globally shared Vault records. Download confirmation
commits all participating owners, sync facts, receipt and outbox atomically, retaining
the same preview on rollback. Native backups use Files leases and preserve raw,
including empty, remote objects up to 24 MiB. Provider implementations and secret
resolution remain private Host behavior; these contracts grant no new authority.

The Host face exposes `ctx.subprocess` as selected structural contracts. Use explicit
argv, an absolute working directory, stdio limits and cancellation; application
approvals remain the caller's responsibility. Always await `handle.dispose()` to
join the managed range and delete temporary output spills. Terminal allocation is
asynchronous; await `terminate()` before unloading. POSIX binary mode preserves
raw bytes; unsupported modes fail explicitly. Platform containment limitations are
reported by the mounted provider. The framework-free `/subprocess` leaf supplies
the canonical executable-lookup error and environment prefix; Client imports do
not expose the Host service. No native implementation is distributed in this SDK.

Selected browser owners expose `ConnectionClientActions` from `/connections` and
`TerminalFactsView` from `/terminals`. Their common `ClientFactsView<T>` definition
is available from `/types`. `ctx.connectionActions` delegates to the live
Connections model; `ctx.terminalFactsView` exposes readonly terminal preference
facts. These definitions add no cache, transport or persistence owner. Inject the
capability before use. Baselines contain public domain DTOs, while temporary
answers/passwords remain command inputs. Retrying a fact view never replays a
mutation. Host plugins continue to use their selected Host contracts instead.

Catalog's `CatalogImportChunk` streams a bounded SSH Config preview or committed
report; `CatalogImportReceipt` is a compact durable outcome with report identity.
The owning model validates complete chunks before exposing a result. Each Include
needs explicit authorization, confirmation imports Host/Bookmark facts and report
atomically, and retrying an accepted command never rereads its granted files.
Full reports retain the last eight outcomes; expired report reads fail explicitly
while the compact command receipt remains replayable under its retention policy.

Catalog owns `promoteConnectionHistoryToBookmark`: optimistic history/tree revisions,
Host reuse, Bookmark creation, history link and durable receipt share one transaction.
Connections owns `reconnectConnectionHistory`, resolving current Host facts for saved
destinations. Temporary authentication remains a transient command input. Generation-local
`getConnectionCommandOutcome` is a readonly reconciliation query; missing or pending
metadata never proves a delayed creation cannot still allocate. Closing a connection
carries its accepted Host generation and rejects stale cleanup before touching resources.

`ConfigurationClientActions` from `/configuration` exposes accepted settings facts
and the keyed `setConnectionHistoryEnabled(key, enabled, ifMatch)` command. The owning
Configuration service retains privacy purge transactions. Catalog contributes history
UI through these selected facts and `ConnectionWorkspaceUi`; it imports no foreign
Client implementation. Generation-local terminal creation receipts and outcome DTOs
use `/terminals`. Neither reconciliation query executes or replays a command.

`CatalogClientActions` from `/catalog` exposes accepted catalog facts and the atomic
`createSshBookmark(key, input, ifMatch)` command through `ctx.catalogActions`. The AI
bookmark dialog uses it only after explicit review and Save. It grants no credential
creation or provider access. `AiRunCommandOutcome` from `/ai` describes readonly Run
admission reconciliation: accepted supplies an opaque Run identity, while missing
or uncertain does not authorize replay or prove absence of a delayed admission.
Cancellation carries the captured generation; Host AI owns actual execution drain.

The pure `/plugins` leaf describes package inspection, installed entries, change
outcomes and exact pending build identities. The Host face exposes the selected
`PluginManagerService` through `ctx.pluginManager`; callers cannot close this shared
owner through the public capability. Its operations require the user's explicit
action, with a separate approval for every model-initiated request and dependency
build. A change may be applied, overridden by a higher composition layer, or require
a restart. CLI management shares the Profile runtime lock after Desktop exits.
The management Remote pairs these DTOs with a Profile-local command journal. A running
receipt means durable admission, not finished installation. Use readonly outcome
queries after a lost acknowledgement; never retry installation under a new identity.
A reconnect replaces the complete baseline. Removing a Client contribution cancels
its observations, while admitted Host jobs retain their owning lifecycle.

The application manager dialog supports explicit installation, upgrades, entry and
Bundle switches, exact compatibility exemptions and separately confirmed dependency
builds. Client activation failures are displayed without raw causes and can be
retried. The infrastructure graph stream updates browser contributions after Host
changes; external UI plugins continue to use only selected Slots and controls.
Native installation-only recovery and per-call model management approval have their own acceptance evidence. Market engineering validation is recorded separately.

`RuntimeMetadata.recoveryMode` identifies installation-only recovery. Its optional
`recoveryHome` is the same Profile home to use for offline CLI management, not a
credential. Recovery skips user configuration and Profile-installed code while
retaining data and packages. Clearing the marker requires explicit offline action
and never restores a patch backup automatically.

Selected `ctx.pluginCommands` Host admission and `ctx.pluginActions` Client facts/actions
are public contracts. Admission returns a durable receipt before package IO completes;
query `outcome(id)` without replaying a mutation. Caller cancellation stops waiting,
while the owning manager drains admitted work. Neither facade exposes shared close.

Pi `plugin_manager` delegates every invocation, including queries and dependency
builds, to a fresh application Tool/Approval/Audit record. It never uses the
workspace.exec automatic-review exception. Engine cancellation, expiry, rejection
and unavailable ownership cannot authorize package IO. External code retains the
same process and OS permissions. No public npm publication is implied.

`@axterm/plugin-api/market` exports selected market DTOs. Default index sources are
empty. Saving sources does not fetch them. Queries read only configured URLs;
versions carry exact npm install parameters, advisory runtime compatibility and
actual installed status. Git metadata has no npm install action. Installation uses
selected `pluginActions` with explicit trust; dependency builds remain separate.
An optional `registry` on install/inspect pins target metadata and package IO to
that source, including its npm scope. Profile manager routing owns selection;
pnpm authentication remains in its existing configuration, with no public fallback.

`RuntimeIdentity.profileName` is an optional immutable launch fact supplied by the
Profile runner. Profile package journals and market settings require it to keep
independent Profiles in the same home separate. Missing identity fails activation;
these owners never assign another Profile's records to a shared default.

Selected `savedCredentialActions.submitCreate`, `submitFromGrant` and `submitRemove`
return captured command/generation plus a result promise. Keep that identity for
readonly `outcome` reconciliation; never resend secret inputs after a lost response.
Granted import accepts only private keys/SSH certificates and delegates actual
file authority and bounded reading to Files before local Vault mutation. Client
facts and receipts contain metadata/refs, never file contents. Convenience create
and remove actions retain their previous result shape.

The selected Host `LocalFileLease.append(path, input)` streams to an authorized,
pinned file and preserves existing/already-written log bytes on cancellation.
`path` is the lease's virtual path, never a browser-supplied physical pathname;
the caller owns stream completion and lease release. Recording transfers its
save grant until completion. `FileGrantActions.createInGeneration` fences native
picker admission before selection. An unknown picker outcome must not open a
second picker; recording commands retain exact generation/key/grant arguments.

`@axterm/plugin-api/shortcuts` exposes DSH-derived physical bindings, per-device
preference documents, revision/compatibility/conflict helpers and the closed
keyboard/window presentation protocol. It grants no business, filesystem or
credential capability. Configuration owns durable writes in existing storage;
Desktop owns transient native matching and rejects foreign or retired windows.

The shortcut leaf also parses retained physical/wheel preference strings. Wheel bindings remain feature-owned and never enter DSH physical arbitration. An accepted shortcut preference seat receives optional closed reset-all metadata; Configuration atomically resets the current physical profile and retained terminal gestures using the existing version/receipt transaction. The flag is command metadata, not persisted state.

`@axterm/plugin-api/desktop` exposes pure versioned window preference DTOs, complete opening/replacement frames and receipts. The native provider is declared only by the Host face. Durable writes capture reviewed version/generation/key; native application state is distinct and can fail after facts are committed. Readonly bounds observations never move another window; only an explicit native applyBounds command applies stored coordinates. DSH window zoom now uses the Desktop Remote owner, with the original 0.5–8 range.

Selected Client service keys are declared by their owning public leaf. Import the corresponding contract explicitly, for example `import type { TransferClientActions } from "@axterm/plugin-api/transfers"` before using `ctx.transferActions`; independent consumers must not rely on unrelated transitive imports to populate Context types.

Terminal file-drop consumers use the selected `/files` generation-bound import and
`prepareInputPathsInGeneration` methods. Returned paths are transient command input,
never directory/workspace facts; send them only through the owning terminal's existing
bounded binary producer and do not append Enter. Files Host retains prepared temporary
file authority until its own unload, so renderer refresh does not remove an input file.
Unprepared/failed grants must still be revoked in their captured generation. Native
original directories can release immediately after input admission without deleting them.

The selected `ctx.fileTransferActions` delegates to the existing Files grant handoff.
Call `create(generation, key, input)` once and `release(grantId, generation)` when the UI
relinquishes authority; release marks ownership for actual queue termination, rather
than deleting a source still in use. Transfers remains the queue/fact/IO owner. This
service is optional with the Files UI contribution; never import its private helper or
fall back to an unfenced command if it is unavailable.

Terminals owns the selected `terminal.files` child Slot (`@axterm/ui/workspace`).
Files contributes its existing local/SFTP pane and owns a shared bounded admission pool
with standalone file tabs. The optional `ctx.filesWorkspaceUi.prepareTerminalPane(id,
generation)` and `releaseTerminalPane(id, generation)` are UI lifetime seams: capture
the actual service, admit only an observed terminal in the same generation, and await
release before closing the terminal. Do not import private pane classes or create a
second grant/transfer owner. Hiding a prepared pane preserves its instance; unload
joins actual IO, grants and external editor observation before shared handoffs close.

`/catalog` exports the bounded `SshOperationDiagnostic` schema used by optional
Catalog/Connections failure diagnostics. It contains an allowlisted product code,
up to eight allowlisted Host/Bookmark field paths, and an optional UUID from the
existing submitted operation. It contains no exception messages, validation values,
dynamic environment keys or credentials. Consumers must validate diagnostics from
external implementations and localize their own stage/reason labels. An absent or
unknown diagnostic means the detailed cause is unknown; it does not authorize retry.

Desktop Runtime observations open with one `RuntimeBaseline`, then explicit `RuntimeReplacement` values. Optional `lifecycle` is a strict bounded native power snapshot (revision/state/lastEvent/changedAt); it contains no execution intent. A new physical generation starts with its own full baseline. Clients must not infer a new resume from their first snapshot or replay any business action while refreshing the Connection carrier.
