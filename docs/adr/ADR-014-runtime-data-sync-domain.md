# ADR-014: Runtime-owned data synchronization

- Status: Accepted
- Date: 2026-09-13
- Decision scope: Phase 19 H-09/H-10

## Context

Electerm exposes selected-category upload/download, server comparison, automatic synchronization and
GitHub/Gitee gist, WebDAV and custom-server transports. Reusing its Renderer-global store, direct network
calls or plaintext credential settings would violate Axterm's Level 1 process boundary and application-local
Vault policy.

## Decision

Data synchronization is a Runtime domain with three explicit ports:

1. `SyncDataSource` creates and previews bounded, versioned category documents through Application
   Services and repositories.
2. `SyncProvider` transfers an opaque document and conditional revision metadata. GitHub/Gitee, WebDAV
   and custom-server implementations remain Runtime adapters.
3. `SyncSecretResolver` resolves application-local Vault references only for the duration of one provider
   request.

Sync profiles, category selection, automatic schedule, last result and opaque remote revision are persisted
in SQLite. Provider credentials are represented only by Vault references in the sync repository; public REST
resources expose configured/not-configured booleans rather than those references. Credential values never
enter SQLite, events, logs, browser storage, URLs or provider error text.

The Runtime owns manual and automatic runs. It permits one in-flight run per profile, bounds document size,
uses `AbortSignal` for cancellation/timeouts and persists a terminal result. Automatic download never applies
changes silently: it refreshes comparison/preview state and requires the same explicit commit path as a manual
download. Automatic upload may run after the configured interval because it only publishes the user's selected
local categories.

Provider downloads return an opaque revision. Upload uses conditional replacement when a revision exists and
reports a typed conflict instead of overwriting newer remote data. Category comparison is content-hash based,
not count-only; counts are display metadata.

The concrete provider protocol is fixed as follows:

- GitHub and Gitee use their Gist REST resources and the `axterm-sync.json` file.
- WebDAV uses an `electerm/` collection below the configured endpoint and conditional `PUT`.
- The custom server uses Electerm's GET/PUT envelope and a five-minute HS256 JWT whose subject identifier is
  the configured remote ID.

Endpoints must be credential-free HTTPS URLs; HTTP is accepted only for loopback fixtures. Query strings and
fragments are rejected. Provider responses are read as bounded streams up to 24 MiB, while decoded document
JSON is capped at 16 MiB. Optional document encryption uses AES-256-GCM with a per-document salt, IV and scrypt
derived key. The derived key is zeroed after use. Provider errors expose stable codes and never reflect response
bodies, URLs or credential values.

## Consequences

- Renderer uses generated REST clients and never imports provider SDKs or Electron.
- Headless Runtime can use the same sync service when a secret resolver is available.
- Desktop Host remains the only Vault owner; no system keychain, Credential Manager, Keyring, Secret Service
  or Electron `safeStorage` integration is introduced.
- H-09 uses a deterministic in-memory provider for scheduler, encryption, cancellation and review semantics;
  H-10 adds direct adapter tests plus a real loopback WebDAV boundary and production Electron journey.
- Sync downloads remain reviewable and cannot replay changes after a Runtime generation change.
