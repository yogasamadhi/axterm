# ADR-025: Bounded AI context review

Date: 2026-10-03
Status: Accepted; local acceptance and new Mac candidate verification passed under OP-09.

## Context

The composer previews individual redacted attachments, while Runtime independently assembles
conversation history, explicit context and attachment bodies at send time. A file preview is
limited to 8 Ki characters and does not describe all content sent to a model. The composer can
also retain draft attachments when the user switches conversations. Approval already uses a
persisted exact-argument hash, but review of a model request must remain distinct from approval
to execute a tool.

The existing history query returns up to 1,000 messages before context is joined, redacted and
trimmed. Long model responses can therefore allocate much more than the actual context budget.
Review must share the actual Runtime builder and expose the chosen sources and truncation.

## Decision

- Keep Level 1, Runtime-owned AI, REST/OpenAPI, fetch SSE and application-local Credential Vault.
  Renderer never reads raw files or invokes Provider SDKs. No business IPC or new dependency.
- Add an authenticated read-only POST context-preview operation in a static HTTP feature module.
  It calls the AI Application Service and creates no run, tool, conversation or persistent receipt.
- Runtime uses one builder for preview and sending. It returns the redacted system instructions,
  prompt and bounded context, with source sizes, truncation and redaction metadata. Terminal ID
  identifies the target; it does not implicitly collect terminal history, environment or files.
- Redact common credential, cloud-key and incomplete private-key patterns, and exact known AI
  Provider/proxy secrets resolved through the existing Host Vault capability. The resolver has
  at most 32 distinct credential scopes, four concurrent calls per preparation and 32 active
  preparations, retains no secret cache, and
  fails closed when a scope cannot be resolved. Apply this before returning attachment previews,
  context previews or model payloads; credential values never enter source metadata or receipts.
- Read at most 32 recent conversation messages for model context, in chronological order, with
  total count metadata. Each persisted message already has a 2 Mi character maximum. Redact
  before retaining its bounded contribution. Keep the 24,576-character history/explicit-context
  budget, 50 KiB per file, eight attachments / 100 KiB total and 131,072-character assembled cap.
  These are character and raw file-byte limits, not token estimates or promises of model quality.
- User can remove attachments, omit conversation history and edit the prompt before sending.
  Conversation changes clear owned drafts. Preparing/reviewing a request does not execute it.
  The composer explicitly confirms the actual reviewed request before creating a model run.
- Bind the optional review receipt to the exact redacted request, model/provider identity and
  versions, source selection, terminal/conversation target and a five-minute expiry. Sign it with
  an in-memory per-service HMAC key. Rebuild and compare before starting the run; source/config,
  expiry or Runtime generation changes require a fresh preview. No body/receipt cache grows in
  Runtime, and receipts do not enter URLs, logs or persistent browser storage.
- A receipt validates the review snapshot. It grants no Runtime authentication, file access or
  execution permission. Existing authenticated headless callers can retain their prior start
  behavior without a receipt; all tools still use the independent risk/approval/audit policy.
- Tighten approval consistency around persisted run/call state, target, tool identity and canonical
  arguments. Mutation, destructive and privileged execution remain explicit Run once actions;
  cancellation, expiry, replay and Runtime restart cannot revive approval.

## Validation

OP-07 must demonstrate preview/send agreement, history/attachment bounds, redaction, source and
target changes, receipt expiry/restart, draft disposal, approval tampering/replay/cancellation and
OpenAI Chat, Responses and Anthropic stream/error/cancel paths using loopback fixtures. Renderer
must separate review, generated-command insertion and execution approval. No hidden reasoning is
stored or displayed. The local acceptance record is [OP-07](../implementation/evidence/local-optimization/OP-07-2026-10-03.md): 64 focused tests, four final-build desktop journeys and the full 1,328-test / 23-visual-accessibility gate passed. New Mac package verification passed; see [OP-09](../implementation/evidence/local-optimization/OP-09-2026-10-03.md).

## Compatibility and rollback

New request fields are optional; existing raw/headless model callers preserve the REST boundary.
Interrupted pending approvals already expire during Runtime recovery. Receipt HMAC keys are never
persisted, so reopening a Runtime invalidates old review receipts without a database migration.
The existing conversation history UI remains its own paginated/bounded read; model-context
selection is explicit in the new preview. Rollback removes the new preview UI and optional fields
without altering stored conversations, credentials, tool results or prior audit evidence.
