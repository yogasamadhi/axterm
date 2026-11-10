# @axterm/engine-api

Pure Engine descriptors, bounded visible input/event schemas, outcomes and consumer
handles are public. Host plugins opt into `/host` to register providers through
`ctx.engines`. Keep this package and Cordis external; declare compatible peers.
External Engine code runs in the Host with the same process and OS privileges.

Select an exact Engine id. Missing engines and unsupported cancellation, tools or
resume reject explicitly. Registration and session handles belong to their calling
fiber and registry/provider. Await disposers and `close()`; these join actual work,
including late session opens. Do not treat an abort request as proof of settlement.
A failed drain remains owned and blocks replacement.

Before `run`, the application persists the visible input under its own Session/Run
facts and fresh command identity. Awaited `observer.event` acknowledges the durable
visible result. `observer.tool` owns approval, budgets, target binding and audit;
a missing callback denies execution. Hidden reasoning has no event in this API.
The registry does not persist content, create an Agent loop or replay commands.
Engine session/resume handles are execution details, never application facts.

Providers validate their Config with Schemastery, resolve Vault references per
operation and keep secrets inside Host execution. Never emit provider causes,
credentials or private reasoning. Do not discover ambient auth/settings/resources.
This SDK is locally distributable; public npm publication and complete AI migration
acceptance are separate work.

`session.run(input, observer, options)` accepts optional Host execution metadata.
`options.configuration` is a JSON snapshot of references and non-secret settings,
separate from visible input/events; the registry never persists it. Before admission
it copies and freezes the snapshot, rejects non-JSON values, and bounds options to
128 KiB, 32 nesting levels and 8,192 values. The selected provider validates its own
format. Invalid supplied configuration never requests an implicit fallback.

Pi currently accepts `{kind: 'pi-provider-v1', providerId, provider}` where `provider`
uses its existing strict Profile provider shape (including credential references).
The id must equal the run's selected `providerId`; resolve the active model's
necessary configuration before creating a binding. Omission preserves explicit
Profile lookup. This seam does not complete application provider/model migration,
legacy proxy/endpoint compatibility or durable AI workflow acceptance.

Host `engines.openSession(id, input, signal?)` binds an optional caller cancellation
signal to allocation and the complete session lifetime. An aborted opening is not
settled until any late handle has actually closed. Early abort never calls the
provider. Failed drain remains owned; applications must still await `close()`.

The first-party Pi provider also accepts an optional strict `legacy` gateway
projection (`apiPath`, `auth`) and reference-only `proxy`. HTTP/SOCKS routing uses
Connections' owned stream leases, with normal TLS certificate/hostname verification,
no redirect fallback and no ambient proxy credentials. These are transport options;
application discovery/testing, durable facts, approvals and UI still own their
separate migration acceptance.

`EngineRunInput.toolNames` optionally names selected application tools. The Engine
transports requests through `observer.tool`; it cannot authorize them. Pi exposes
`plugins.manage` as `plugin_manager`, with a separate application approval per call.
An admitted self-uninstall returns its receipt before removal completes, allowing
the manager to cancel and join the Engine before deleting its package files.
