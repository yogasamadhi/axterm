# AI application owner

ADR-072 implementation in progress. The Host fact adapter uses only its declared
`ctx.storage` relational domain. Migration 50 preserves migrations 1–49, assigns
existing providers/runs explicitly to Pi and adds owned command receipts, run
intents and a paged visible log. Credentials remain references.

`AiRunJournal.admit` atomically records a Run, input, intent, outbox and compact
receipt. Only its first successful admission grants execution. Repeated commands
return the existing Run without granting IO. Generation changes reject admission.
Tool and Approval transitions are logged within the same transaction, remain bound
to arguments/target, and never execute effects merely by recording a decision.

Composition supplies the redaction policy. Visible logs reject private reasoning,
validate JSON before traversal, bound every record and page, and split bounded
final output without breaking surrogate pairs. Cross-owner writes fail. Recovery
requires an exclusive owner coordination lease and conservative process-exit proof;
this private storage seam does not itself acquire filesystem locks or replay IO.

This package is compiled and tested but is not yet activated in a Profile. Its
Remote/Client model,
Slots/UI, configuration participation, lifecycle coordination and source-free
product acceptance remain to be connected before replacing the existing AI entry.

`EngineModelProvider` is the execution adapter for the retained application
ModelProvider port. It selects an exact Engine, validates required capabilities,
uses one rendezvous event slot and grants no tools without the application callback.
Caller abort closes/drains a session even while the consumer is paused on a yield;
allocation and failed cleanup remain owned by the Engine registry. Only
`workspace.exec` with the exact argument shape can reach the supplied tool path.
The adapter introduces no Agent loop or model stream parser.

`AiModels` supplies fixed metadata, bounded legacy GET discovery and actual Pi
Engine probes. The private Pi discovery leaf cannot execute an Agent; its import
has an exact source/symbol gate. Probe output remains ephemeral. Owned adapters
close independently of a paused iterator and retain failed drains.

`AiHostCapabilities` uses live Files leases for bounded attachment prefixes and
keeps credential resolution owned through cancellation. `AiWorkspaceService` uses
only selected terminal/connection projections; local commands use the same managed
subprocess provider, preserve Windows verbatim quoting and cap combined output at
128 KiB. Application composition supplies controlled workspace paths; no hidden
creation of a production home occurs in the workspace service. These components
still await the complete AI Controller/Client integration.

`AiService` now owns the retained application use cases through pure repository,
fact, Tool, review and Engine ports. It snapshots requests synchronously, checks
complete original request identity before preparation, and admits Run/input/intent/
selection/attachment metadata atomically. Only the first admission starts effects.
Generic visible output streams through a bounded incremental redactor, then commits
its log before publication/ACK. Classifier text stays ephemeral; only its brief
validated decision and usage enter facts. Model/attachment preparation is registered
before callbacks can reenter shutdown. MCP sources revoke accepted work and join
actual tasks; readonly tools remain immediate and mutating tools require one-shot
human approval. Only workspace.exec uses ADR-030 automatic review.

`AiToolService` retains the existing MCP definitions and strict allowlists.
`AiToolResources` reads Catalog/Terminals, uses Files-owned SFTP reads and Connection
execution, and runs only the fixed diagnostics through ctx.subprocess. Its failed
process drains remain active. Native terminal insertion waits for startup input and
checks cancellation. No Agent/API parser, direct native transport or old business
REST endpoint was copied into the application.

These are executable private application components, not yet a Profile-mounted AI
feature. The generated Controller, Client baseline/cursors and full UI, configuration
owner participation and exclusive recovery coordination still gate M5 acceptance.

`OwnedAiApplication` combines these owners and holds an explicit per-Profile file
lease through actual resource drain and SQL shutdown. Accepted provider discovery
is included in setup cancellation. A failed Engine/resource drain retains both the
SQL facet and Profile lock, and keeps activity nonzero. `AiOwnerLease` recovers only
proven stopped PIDs while holding the relevant owner lease; live/reused processes
and a currently held foreign Profile lock win. Recovery records visible Tool and
Approval transitions, preserving uncertain-effect metadata for interrupted writes.
Pending authority and active effects use dedicated queries, independent of recent
history list limits. This composition still awaits the actual Controller/Client/UI
and Profile activation; it is not complete product cutover.
