# AI application owner

The AI plugin owns its relational storage domain, generated Remote controller,
Client baseline/log models and Slots UI. It runs in the default Desktop/Web
Profiles; model execution goes through `ctx.engines`.

The fixed Pi source owns the Agent loop, provider catalog, model composition,
API protocols, API-key/OAuth/subscription login and token refresh. The desktop
renders Pi prompts and notifications. Grants and rotated tokens remain in the
application-local Vault; only references and public model metadata enter business
facts. Login tasks are bounded, canceled and joined on owner shutdown. Pi file
sessions, auth.json and system credential services are not used.

Chat advertises no executable tools. Work mode executes commands directly through
the selected local/SSH workspace Application Service and continues the Pi loop
from actual results. Command review and per-command approval are suspended by the
owner's current product decision. Full access is the execution account's existing
permissions. Reply-only skills remain text-only, and other MCP/plugin-management
approval paths retain their separate behavior.

The assistant can follow the active terminal tab or select any open terminal tab.
Local workspace and execution directories follow that terminal's live directory.
SSH keeps its application-local workspace while commands follow the selected
remote terminal's directory. Tasks retain their terminal/connection generation;
each command records the live directory captured at dispatch. A foreground tab
change does not retarget an explicitly selected terminal or an existing task.

Run admission atomically records input, intent, outbox and receipt. Retry never
replays execution. Tools and results remain durable facts; they are not falsely
labeled human or automatic-review approvals. Target/generation binding, visible
output redaction, cancellation, bounded queues/output and deterministic cleanup
remain enforced. Model-private reasoning is never exposed or persisted.

`OwnedAiApplication` retains its Profile lease and storage until accepted work and
resources drain. `EngineModelProvider` selects an exact Engine and uses one
rendezvous event slot; it does not implement an Agent loop or provider parser.
