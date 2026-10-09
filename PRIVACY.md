# Axterm privacy and data handling — pre-release technical statement

Status: **pre-release; not a public commercial privacy notice or legal approval**

Axterm is currently an unpublished desktop product candidate. This document
records the implemented technical data boundaries and the release-owner work
required before any public distribution. It does not name a data controller,
make a jurisdiction-specific legal promise, or replace a qualified privacy and
data-processing review.

## Current technical defaults

- The Desktop Runtime binds only to loopback and uses per-generation
  authentication. It is not a hosted Axterm service.
- Product configuration and metadata are stored in the product SQLite database.
  Saved secret material is held only by the application-local Desktop Host
  Credential Vault; product records retain a `credentialRef`, not a secret.
- Terminal byte history is not persisted by default. Terminal bytes do not enter
  React state, Zustand, TanStack Query, ordinary logs or persistent browser
  storage.
- Telemetry is disabled by default. This source tree does not configure an
  Axterm-operated analytics endpoint.
- Cloud synchronization is opt-in and user-configured. SSH/SFTP, remote desktop,
  web, AI-provider, sync-provider and updater connections communicate with the
  endpoint selected by the user or, for a future release updater, the endpoint
  configured by the release owner. Their operators' policies are separate from
  Axterm's future policy.
- Exports, diagnostics and migration paths have their own bounded/redaction and
  secret-exclusion rules. A portable configuration export is not a complete
  Vault or system backup.

The normative technical constraints are in
[MASTER_SPEC](docs/architecture/MASTER_SPEC.md), especially the credential,
terminal, AI and privacy-default sections. User-visible product behavior must
continue to match those constraints; this file does not weaken them.

## Public-release prerequisites

Before a public Axterm distribution, the release owner must publish an
approved privacy/data-processing notice that identifies the responsible party,
supported product versions, actual network services, data-retention choices,
contact route and applicable user rights. It must also review the product's
current data flows and all release-operated services. The first release's
manual-download page and any support system require review; a signed automatic
updater requires additional review only if it is activated later.

The non-sensitive facts are recorded in
[`RELEASE_SERVICE_RECORD.json`](compliance/RELEASE_SERVICE_RECORD.json). Its current
`pending` state means there is **no** public policy or legal approval to infer.
For the later Mac/manual-update release, publish and verify the actual policy URL
and record its approval in the external MCR-03/MCR-04 evidence. The fuller
three-platform release route additionally requires an owner-completed service
record passing `bun run release:services:active-check`. Neither record format
alone proves the published policy's contents or legal adequacy.
