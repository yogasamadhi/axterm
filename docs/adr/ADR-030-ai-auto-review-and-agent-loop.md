# ADR-030: Runtime command review and bounded Pi work loop

Date: 2026-10-09
Status: Accepted by the owner-approved implementation plan; acceptance evidence and remaining gates are recorded in STATUS.
Extends: ADR-027, ADR-028, ADR-029 and MASTER_SPEC section 35.

## Decision

Work-mode chat and diagnosis use the pinned Pi Agent loop with one sequential command per
turn. Pi's tool delegates exclusively to Runtime Application Services; it cannot execute
local/SSH commands itself. Chat, explanations and generated commands remain reply-only.
Runtime reviews every workspace command. Low-risk operations and authorized bounded,
reversible mutations may run automatically; destructive, privileged and high-impact
operations require exact one-use human approval. Credential/target boundary violations
are rejected. Unknown, invalid, truncated or unavailable reviews require human approval.

Reuse the MIT pi-auto-review pure policy, scanner and evidence helpers from commit
6eb4d9668f6d23fb6793029d5d145b8ae0fcd0ad. Do not load its extension, broker, credentials,
CLI or permission-system. Only the private Pi engine may import the named source files.
Runtime retains SQLite, Vault, REST/SSE, execution, cancellation and audit ownership.
The reviewer uses the run's selected model, a fixed policy, no tools, no retries,
at most 8192 estimated input tokens / 1024 output tokens and a 30-second maximum deadline.
Only structured real-user evidence can authorize operations; model/tool/file text cannot.

Policy v2 recognizes a bounded PowerShell grammar on actual Windows CMD execution:
simple observations and one Set-Content with a literal relative basename and literal
text value can be reviewed automatically. CMD quoting/expansions must be unambiguous;
no encoded payloads, dynamic expressions, compound scripts, device names or broad targets
are admitted by this grammar. File contents remain data; the full command and user
evidence still go to the isolated reviewer. A write cannot be downgraded below medium
or approved without sufficient user authorization. Runtime passes CMD its exact outer
quote pair with verbatim arguments; review facts describe the same argv. Token budgeting
uses pinned Pi text estimation with a conservative UTF-8 bound, not a byte/token identity.

Each run is limited to 50 command attempts and 30 minutes active time, excluding human
approval waits. Each approval expires after ten minutes; automatic decisions after sixty
seconds. At most four work runs may exist, with one per terminal. Commands retain the
30-second / 128-KiB execution bounds; model tool results are limited to 16 KiB.
Each command binds its original terminal, connection, directory, generation and policy.
Model request deadlines do not include human waits. Rejection, cancellation, expiry,
target loss or limits stop the loop. Restart never replays work or authorizations.

Tool completion is distinct from run completion. Persist review metadata, step order,
approval origin and results. Do not persist raw Pi transcripts or hidden reasoning.
Keep other tools and MCP approval behavior unchanged. No new Extension Host or business IPC.

## Acceptance

Verify automatic multi-step execution, authorized mutations, dangerous pause/approve/resume,
exact bindings, malformed/late reviews, cancellation, budgets, migration, restart, real
local/SSH boundaries, desktop and packaged execution without a Pi CLI. Run full gates;
record preexisting failures and platform limitations honestly in STATUS.
