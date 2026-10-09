# ADR-017: Versioned Axterm sync format and non-destructive remote migration

Status: Accepted for implementation  
Date: 2026-09-21  
Relates to: ADR-016, P-06 / IR-08 and IR-09

## Context

The current settings-sync path uses a version-1 envelope and eight selected
categories, but its `settings`, `bookmarks` and `profiles` values are produced
by `Legacy PrototypeDataService`; WebDAV writes below `/legacy-prototype/`. It is therefore a
compatibility format, even though some provider file names already contain the
Axterm brand. Existing profiles and remote documents may contain user data and
must remain usable during the public migration period.

Changing the existing document header, renaming `/legacy-prototype/`, or treating the
old portable document as an Axterm format would make an incompatible data
change look like a cosmetic rename. It could also overwrite a user's only old
remote copy. The Runtime/Client contract and SQLite schema need an explicit
format boundary while retaining the existing REST and Host-Vault architecture.

## Decision

1. A sync profile will have an immutable `format` value:
   `legacy-legacy-prototype-v1` or `axterm-sync-v1`. Existing database rows migrate to
   `legacy-legacy-prototype-v1`. The first rollout marks every profile served by the
   current legacy data source as `legacy-legacy-prototype-v1`, including new profiles,
   and does not expose `axterm-sync-v1` creation. Only after the independent
   writer, preview/import flow and remote names are connected may new profiles
   default to `axterm-sync-v1`. Editing a profile does not silently change that
   value. Conversion creates a separate Axterm profile after the user has
   backed up and reviewed the old remote object.
2. `axterm-sync-v1` will use a distinct, strictly validated document header
   (`format: "axterm-sync"`, `formatVersion: 1`) and a data source built from
   `AxtermConfigurationService`'s typed repositories—not from
   `Legacy PrototypeDataService` or its portable `_axterm` extension. It retains the
   bounded plain/encrypted outer envelope, scrypt/AES-256-GCM, provider size
   limits, revision checks and application-local Vault references.
3. Every selected category is independently represented in the Axterm document
   and has deterministic count/hash parity coverage. Its data mapping covers
   all-protocol bookmarks plus required hosts/groups, connection/terminal/tunnel
   profiles, user themes, quick-command groups, triggers, address bookmarks,
   workspaces and selected portable settings. Vault values and references,
   background-image bytes, histories, AI state, known-host trust and sync
   profiles remain excluded and are declared in the document.
4. Download remains preview-then-explicit-commit. The Axterm source will use
   the existing bounded configuration preview/import transaction, preserving
   its stale-target fingerprint check and mapping table. The data-sync response
   will gain an Axterm preview/result variant rather than relabeling a legacy
   `Legacy PrototypeDataPreview` as independent data.
5. Providers receive the profile format in their context. New WebDAV profiles
   use `/axterm/`; legacy profiles retain `/legacy-prototype/`. New Axterm remote names
   are distinct from legacy Gist/custom payload names. Existing remote data is
   only read or copied through an explicit File Grant backup; conversion never
   deletes, moves or overwrites it.
6. One profile per provider is insufficient when the independent format is
   exposed because a user may need old and new formats concurrently. At that
   exposure, the repository uniqueness constraint must become
   `(provider, format)` as part of a recoverable SQLite migration; UI tabs
   distinguish profiles by format and show the legacy deprecation notice. The
   initial marker-only migration intentionally retains the existing one-profile
   rule because it does not yet create any Axterm-format profile.
7. The final IR-09 removal occurs only after the public stable-release window,
   documented date/duration, old-data fixtures and platform evidence. It then
   removes the legacy source, legacy profile format, `legacy-prototype://` and old
   remote path handling without contacting or deleting any remote object.

## Consequences

- This is a Contract/database evolution. Add a database migration, Zod/OpenAPI
  schemas, generated client methods, Runtime adapters, Renderer controls and
  tests together; do not route it over Electron IPC.
- Profiles must not expose Vault refs or remote secrets in the client, logs,
  events or browser storage. Provider URLs remain credential-free.
- The new format must be able to coexist with legacy rows and remote objects;
  a user has an explicit backup/recovery path before conversion.
- A synthetic legacy fixture is still not evidence of a historical release.
  IR-08 additionally requires representative old release/database/Vault and
  encrypted/plaintext remote fixtures, a public date/window and real packaged
  evidence on macOS, Windows and Linux.

## Alternatives rejected

- Rename the v1 header or `/legacy-prototype/` directory in place: rejected because it
  breaks recovery and falsely claims the legacy payload is independent.
- Make new profiles write the legacy data shape below an Axterm path: rejected
  because the data source remains Legacy Prototype-compatible.
- Auto-copy, move or delete a remote object during conversion: rejected because
  remote sync is not a full local/Vault backup and providers can retain the
  user's only data copy.
- Remove legacy sync before the migration release/window: rejected by ADR-016
  and P-06.

## Verification plan

1. Unit-test legacy-row migration, concurrent profiles, strict document
   validation, category hashes, encryption, revision conflicts, cancellation
   and cleanup.
2. Use controlled HTTP fixtures for all four providers to prove the exact old
   and new paths/names, non-overwrite behavior and explicit backup bytes/hash.
3. Run source and packaged Electron journeys for preview, cancellation, commit,
   conversion/recovery and Vault redaction. Add old-version fixtures without
   committing real secrets.
4. Retain Windows/Linux installed-app and real-account/provider evidence as
   release gates. Green source tests do not accept IR-08 or IR-09.
