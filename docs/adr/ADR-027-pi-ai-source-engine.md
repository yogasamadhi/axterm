# ADR-027: Pi source engine and provider configuration

Date: 2026-10-05
Status: Accepted, requested by the repository owner; locally implemented and verified.

## Context

The owner selected Pi as the AI assistant engine and requested Pi's provider configuration
workflow, with direct use of its vendored source. The existing assistant implements three
provider streaming protocols itself. Pi is pinned by the `vendor/pi` gitlink and `.gitmodules`.

## Decision

- Compile Pi's AI, Agent and telemetry source into a private `@workspace/pi-engine` package.
  Keep the upstream checkout unchanged. Build from the pinned source, without downloading
  published Pi binaries, running the coding-agent CLI, loading extensions or refreshing the
  model catalog over the network. Include SDK dependencies and MIT attribution in packaging.
- Only this package may import these Pi sources. Runtime's AI adapter consumes its narrow
  typed interface. Renderer, portable contracts/client and Desktop Host cannot import it.
  Keep Level 1, the utilityProcess / headless Runtime and the existing REST/OpenAPI boundary.
- Use Pi's bundled provider/model catalog, API identifiers and Agent loop for model requests.
  Custom models use the Pi `models.json` provider/model shape. Preserve the existing protocol,
  endpoint, proxy and timeout settings for stored configurations without a database rewrite.
- This work covers API-key providers and custom models. OAuth/subscription login requires a
  separately implemented Host interaction and credential lifecycle. Do not present unsupported
  authentication modes as usable or silently fall back to ambient credentials.
- Credentials, including custom header values, stay in the application-local Host Vault.
  Persist only credential references. Import literals through the Vault. Do not load Pi's
  `auth.json`, execute `!command` credential expressions, or read arbitrary process environment
  credentials. Unsupported expressions fail validation with a visible error.
- Pi receives the existing bounded, reviewed and redacted context. Hide private reasoning and
  provider error bodies. Bound HTTP response bytes, visible output, request time and event
  queues, cancel owned streams deterministically, and disable automatic SDK retries.
  The pinned Google SDK's three fetch call sites are bound at build time to an AsyncLocalStorage
  request transport because Pi's Google adapter does not expose custom fetch. Validate the exact
  injection count and test Google protocol behavior; never replace process-global fetch. The
  adapter clears only Pi's unsupported fetch option and disables Google's SDK retries explicitly.
- Retain explicit tool proposals and the persisted Application Service approval/audit path.
  This change does not introduce autonomous tools. The model Agent has no executable tools;
  unsolicited tool calls cannot execute a command or bypass approval. Command generation
  continues to produce a draft that requires a distinct user action to insert or execute.
- Independent source snapshots include the exact Pi source inputs and license as ordinary
  source, while excluding Git metadata and unrelated CLI/examples/tests. The snapshot must
  build without a live submodule checkout. Provenance records identify the source revision.

## Validation

Verify catalog fidelity, built-in and custom model resolution, old provider compatibility,
Pi-generated protocol requests, visible streaming/usage, failure/cancellation/timeout/limits,
Vault-only imports and header credentials, unchanged approval policy, and independent source
and packaged Runtime execution. Run the full repository gate. Record actual evidence in
STATUS and VERSIONS; do not claim OAuth or unrun native platform acceptance.

Local source, frozen independent snapshot and macOS packaged Runtime validation passed.
Actual scope and results are recorded in
[the implementation evidence](../implementation/evidence/pi-engine/2026-10-05.md).
