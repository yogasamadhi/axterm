# Axterm theme catalog and legacy-reference migration

Updated: 2026-09-23  
Authority: [ADR-016](../adr/ADR-016-independent-open-source-product.md)  
Status: Implemented in the development tree; public migration/release evidence remains open

## Independent catalog

The four built-in palettes in `packages/shared/src/terminal-theme-presets.ts` were authored for Axterm in this cleanup work: Default (grove dark), Default light (paper), Tidal and Copper. They are plain platform-neutral data shared by Runtime and Renderer. No palette values are generated from the upstream theme package, and the former 310-entry generated snapshot and generator are removed from product source. The first two IDs remain stable (`…0001`, `…0002`); the new palettes use `…1001` and `…1002` to avoid colliding with old built-in IDs. The source is Axterm-owned under the root Apache-2.0 license, subject to the final human rights/design review. Unit tests validate schema and foreground/background contrast for every built-in.

## Upgrade behavior

Old built-in IDs `00000000-0000-4000-8000-000000000003` through `…0312` no longer refer to shipped palettes. Database migration 34 maps those IDs to the Axterm Default (`…0001`) in the global terminal visual, current workspace layout tabs and every saved named-workspace tab. It does **not** alter user-created theme rows, including an intentionally colliding ID in the user theme table; visual backgrounds and all other settings remain unchanged. An old `Default light` selection keeps its stable ID but displays Axterm's new light palette. The old palette colors are not silently copied into a custom theme.

For an existing database, migration 34 checkpoints WAL, creates a non-overwriting `axterm.sqlite.pre-migration-34.bak` (or a UUID-suffixed backup if that name exists), then updates settings transactionally. It increments only changed section versions and records a migration checksum; a repeat startup does not rewrite settings. Fresh databases do not create an unnecessary pre-migration backup. A failed migration rolls back and leaves the backup available. Do not replace an active database while Axterm is running.

Users who require the exact colors of an old built-in should clone it to a user-created theme or export it **in the older version before upgrading**. User-created themes and their IDs are retained. This guidance must appear in the public migration release notes before a final independent release; no public migration date or window is claimed here. If a user has already upgraded without cloning, the pre-migration backup and an older Axterm build may be needed to export the prior theme safely; the current catalog cannot reconstruct the removed palette from an ID alone.

## Legacy Prototype portable-data migration

During the announced migration period, the Legacy Prototype-compatible data importer
also recognizes saved `terminalThemes` rows. It reads the row's saved terminal
and UI palettes, previews mapped/omitted field names without showing color
values, and creates Axterm user themes as part of the same explicit import
transaction. A stable source-ID mapping makes repeat imports idempotent; a
selected imported custom theme is remapped in terminal settings without
replacing the existing Axterm terminal background. Incomplete
palettes use Axterm Default values for missing fields, and malformed rows with
no valid colors are skipped with a visible reason. When a selected legacy
theme cannot be mapped, settings use Axterm Default instead of retaining a
dead upstream ID. Duplicate source IDs are treated as ambiguous and the import
is capped at 256 user themes per file; skipped rows report no mapped fields.
These conversions preserve usable user-created palette data;
they do not grant rights to upstream source code or copied assets and do not
replace the separate source/asset review.

## Verification and remaining gates

- `packages/runtime/src/adapters/sqlite/theme-catalog-migration.test.ts` checks global/current/saved layouts, colliding user-owned IDs, exact pre-migration backup content and idempotent reopen.
- `packages/runtime/src/application/terminal-theme-service.test.ts` checks the four immutable built-ins, contrast, custom clone/edit/delete, restart persistence and guarded file round trip.
- The H-03/H-04 desktop journeys exercise the explicitly labeled migration-period
  legacy theme-file import/export, its visible deprecation notice, live terminal
  theme application, image/text backgrounds and restart persistence. The notice
  directs durable backup and transfer to the independently versioned Axterm
  configuration export rather than presenting the legacy text layout as a new
  Axterm interchange format.
- The new-theme editor no longer opens `theme.legacy-prototype.org`; Axterm's curated
  built-ins, clone, import and explicit AI-draft workflow are the available
  creation paths. `product-copy-provenance.test.ts` guards that upstream URL
  from re-entering the Renderer.
- A copied-outside-checkout macOS arm64 `package:dir` upgrade fixture starts
  with an old `…0312` selection and an older schema, then checks the Runtime
  migration, visible new palette, pre-migration backup, preservation of a host,
  Quick Command and Vault secret, and the visible legacy theme-file notice in
  the packaged Theme workspace. It is **not** an installed
  old-binary-to-new-binary upgrade.
- A separate conditional journey rebuilds exact historical commit `657b3cc`,
  uses that old package's real UI to select its first removed upstream built-in
  `3024 Day` (`…0003`), and then opens the same user-data directory with the
  current package. Read-only inspection proves the old database stored `…0003`,
  migration 34 changed the live setting to the stable mint Axterm `Default`
  (`…0001`), the current UI rendered that selection and the automatic rollback
  database retained `…0003`. This is real historical-source package evidence
  on macOS arm64, but the package was rebuilt now and is neither an archived
  signed/public installer nor Windows/native-Linux evidence.
- P-05 remains open for real installed macOS/Windows/Linux upgrade evidence, visual/accessibility review, final rights sign-off and migration-release communication. The legacy Legacy Prototype text import/export format remains available during the transition and is **not** the final independent interchange format.
