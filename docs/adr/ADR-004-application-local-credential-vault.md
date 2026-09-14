# ADR-004: Application-local credential vault

Status: Accepted  
Date: 2026-09-12

## Context

The initial desktop implementation encrypted saved credentials with Electron
`safeStorage`. Depending on the operating system, this delegates key protection
to macOS Keychain, Windows DPAPI/Credential infrastructure or a Linux secret
service. The product requirement is now to avoid those system credential stores
and keep saved connection and AI credentials inside Axterm's own local data.

The existing process boundary still matters: the Renderer must never persist a
secret and the business database must only store a `credentialRef`. The Runtime
also must not acquire direct filesystem access to Desktop Host data.

## Decision

Desktop Host owns an application-local vault below Electron's Axterm
`userData/vault` directory. It creates a random 256-bit local master key and
stores it in `master.key`; each credential is encrypted separately with
AES-256-GCM, a fresh 96-bit nonce and the credential reference as authenticated
additional data. The directory uses owner-only `0700` permissions and the key,
metadata and credential blobs use `0600` permissions where the platform
supports POSIX modes. Writes use a temporary file followed by rename.

The Host Capability API continues to expose only metadata and opaque references
to the Runtime. Secret resolution stays on the authenticated loopback Host API.
The Renderer clears form input after submission and receives no secret value
back from business APIs.

Credential metadata has exactly one storage value: `storage: local`. The Contract
does not advertise or accept a system-backed, basic or session storage mode.
Metadata from an older `safeStorage` implementation is ignored at startup and its
blob is never resolved. Entering and saving the credential again creates a new
local AES-GCM blob.

This is a fixed product policy. Startup, Settings, credential entry, import,
migration and recovery flows do not probe for a system credential backend, offer
a storage-backend selector, or ask the user to enable one.

The local key and encrypted blobs move together during a complete Axterm data
backup. Encryption prevents plaintext disclosure through an isolated credential
blob or casual file inspection. It does not protect credentials from an attacker
who can read every file as the same operating-system user. Diagnostics must state
this accurately.

## Consequences

Saving a credential no longer opens, depends on or modifies a system keychain.
The behavior is consistent on macOS, Windows and Linux and remains available
without a desktop secret-service backend. Removing `master.key` makes existing
local credential blobs unrecoverable, so backup and diagnostic export must treat
the key as sensitive and must never include it in diagnostics.

Tests verify restart persistence, lack of plaintext in vault files, POSIX modes,
replacement, authenticated-tamper failure and deletion. Distribution smoke tests
must verify the same behavior in packaged builds on each supported platform.

## Alternatives considered

- Store plaintext JSON in the Axterm directory: rejected because incidental
  disclosure and ordinary backup inspection would reveal all passwords and keys.
- Continue using Electron `safeStorage`: rejected by the product requirement to
  avoid system credential stores.
- Put credentials in the Runtime SQLite database: rejected because it breaks
  Host ownership and mixes secret material with business data and backups.
