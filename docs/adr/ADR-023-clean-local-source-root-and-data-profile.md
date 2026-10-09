# ADR-023: Clean local source root and fresh data profile

Status: Accepted by repository owner 2026-09-26

For the unpublished prototype's local profile, this decision narrows
ADR-021 Decision 2's earlier in-place SQLite/Vault upgrade expectation.
Future upgrades within the fresh Axterm profile remain a separate obligation.

## Context

The first public source root must not carry the unpublished prototype's names,
compatibility identifiers, or Git history. The prototype was never publicly
distributed. Its database and credential vault may contain valuable private
data, but the owner approved ending in-place upgrade support for that profile.

## Decision

1. Build a new local Git root from a cleaned source-only snapshot. Keep the
   previous repository and frozen engineering candidate unchanged as controlled
   backups. Do not create or alter a remote repository.
2. Use a fresh versioned Desktop data directory and credential vault. Do not
   open, rewrite, delete, or automatically import the unpublished profile.
   Owners may retain a cold copy and manually import supported Axterm portable
   configuration, then re-enter saved secrets.
3. The fresh database migration chain contains only Axterm-owned schema and
   sync formats. Existing unsupported sync payloads are not translated or
   uploaded. Headless callers using an existing database must receive an
   explicit schema-generation error before migration changes any bytes.
4. Preserve applicable third-party license and copyright notices. A textual
   zero-result audit is a packaging requirement, not a source-rights finding.
   Legal/rights review and signed public distribution remain separate gates.

## Verification

Check the new source tree, all tracked paths, and unpacked macOS artifact for
the retired product name in case-insensitive ASCII and UTF-16. Validate clean
checkout, frozen dependency install, full test suite, packaged startup, and
data-profile isolation. Record results without marking public release complete.
