# ADR-021: Remove Legacy Prototype compatibility before the first public release

Status: Accepted by repository owner 2026-09-25  
Supersedes: ADR-016 Decision 5 and ADR-017 Decision 7's public migration-window requirement

## Context

The owner confirmed that old Axoterm/Axterm packages were never publicly
distributed. On 2026-09-25 the owner changed the earlier migration-window
decision and explicitly approved immediate removal of Legacy Prototype import/export,
`legacy-prototype://` links and legacy sync format, without first publishing a
migration-period version. The earlier implementation and its tests are useful
historical evidence, but are no longer future product requirements.

## Decision

1. Remove Legacy Prototype-specific data APIs, UI, parser, sync source, profile format,
   URL scheme, legacy key/value terminal-theme file import/export, package
   declarations and associated production wiring now.
   Future Axterm releases must not read, write or advertise those formats.
2. Keep Axterm-owned configuration import/export, `axterm://`,
   `axterm-sync-v1`, custom themes inside the Axterm configuration snapshot,
   current Axterm SQLite/Vault upgrade behavior and all
   Level 1, authentication, File Grant, streaming and resource-cleanup rules.
3. Do not delete old remote objects, old local databases, saved secrets or
   user-created themes. Unsupported legacy sync profiles in an existing local
   database must become inert and remain recoverable from a cold backup; they
   must never be silently rewritten as Axterm-format profiles or uploaded to
   an Axterm remote path.
4. Remove migration-window gates from the **technical decoupling** completion
   path. Rights, notices, signing, service availability and platform checks
   remain separate commercial-release work; this ADR does not declare them
   complete or authorize deletion of the old GitHub repository.

## Consequences and verification

This is a deliberate compatibility break. `legacy-prototype://` links and old portable
or sync documents will no longer be accepted. The unpublished Axoterm
prototype's old portable file may also cease to import if it used the removed
format; retain the original profile backup and use only Axterm-owned formats
for future transfer. Update Contract/OpenAPI/client, Runtime, Renderer,
packaging, documentation and tests together. Verify that old local rows do not
trigger network activity or lose their stored bytes, and that Axterm-native
import/export/sync and current-profile upgrades still work. Do not treat a
string-replacement scan as proof of independent authorship or license rights.
