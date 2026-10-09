# IR-08 Axterm configuration export and collection-import evidence

Date: 2026-09-20  
Scope: independent `axterm-configuration` version-1 export, inspection and
bounded portable-collection import with opt-in portable-settings restore  
Acceptance: partial P-06 evidence; IR-08 In progress, IR-09 Open

## Source and content

`AxtermConfigurationService` reads Product, Bookmark, Profile, Quick Command,
Theme and Trigger services directly. It does not import or call the
Legacy Prototype-compatible data service. The strict first-party Contract includes all
connection/bookmark protocols and associated host groups, connection/terminal/
tunnel profiles, commands, custom themes, triggers and settings. Output is
limited to 16 MiB and written atomically to a Host save grant with mode `0600`
on POSIX. The response reports byte count, entity count, omitted-field count
and SHA-256. Its `omissions.fields` paths identify removed credential references,
credential-dependent proxies and image backgrounds; `excludedCollections`
identifies collections not in this file. User-authored commands and environment
values can still be sensitive.

Import is deliberately not a blind file write. A File Grant first creates an
in-memory preview (maximum four, ten-minute expiry) that performs strict UTF-8,
regular-file and 16 MiB validation, graph/reference checks, existing-ID and
fingerprint-mapping conflict checks, and reports create/unchanged/conflict
counts. Explicit commit rechecks the importable target-collection fingerprint and writes a single
SQLite transaction. Host jump chains and group/profile references are remapped
to new target IDs; bookmark groups/bookmarks, tunnel profiles, quick commands,
custom themes and triggers follow the same mapping. The durable mapping makes a
repeat import idempotent. By default global settings/workspaces and the
application-local Vault are preserved. An explicit preview choice can instead
save portable appearance, workspace layout/named workspaces/startup/activity
rail, shortcuts, terminal, file-manager address-book and monitor settings;
host/bookmark/profile/theme references are remapped before the settings write.
Privacy/history choices, Vault values and credential-dependent proxy settings
remain local, and source image backgrounds use the safe non-image fallback. The
live workspace remains open to avoid orphaning active sessions; the imported
layout takes effect on the next full Axterm start. A settings-enabled preview
includes settings in its stale-target fingerprint. A later database constraint
error rolls back all earlier writes in that transaction.

## Evidence

- Final `bun run check`: 839 unit tests pass (one skipped), Level 1
  architecture gate, 262-operation Contract gate, component/license and
  localization checks, production build/layout, and three visual/accessibility
  Playwright journeys all pass.
- `bunx vitest run packages/runtime/src/application/axterm-configuration-service.test.ts`:
  eight tests pass. A real SQLite fixture with SSH, Web and Telnet bookmarks,
  password references, an authenticated proxy and an image background verifies
  category coverage, redaction, safe fallback, omission paths, mode `0600`
  (POSIX), SHA-256 and a clean directory. The strict schema rejects a forged
  Vault reference. A second source/target SQLite fixture covers preview, an
  actual collection import, default settings preservation, repeated idempotent
  import and selected-setting restoration. The opt-in fixture proves remapping
  of host/bookmark/terminal-profile/custom-theme references inside workspace,
  terminal and file-manager settings while retaining target privacy and a
  credential-dependent target proxy. A direct late database name conflict
  verifies rollback of an earlier host-group write; target fingerprints permit
  an unrelated lifecycle event and a default-mode setting change, but reject a
  changed setting when the opt-in path was selected.
- `bunx vitest run tests/unit/workspace.test.ts`: four tests pass, including
  the one-shot Renderer guard that prevents the settings-query refresh after an
  import from immediately serializing the still-open workspace over the saved
  imported layout.
- `bunx playwright test tests/e2e/desktop.spec.ts --grep 'Legacy Prototype data migration previews' --project=desktop`:
  one source Electron journey passes. It begins with the version-controlled
  synthetic legacy v1 fixture at
  `tests/fixtures/migration/legacy-legacy-prototype-data-v1.json`, so the native File
  Grant/UI, credential re-entry and redaction path is reproducible. It is not a
  historic-release fixture or installed-old-binary proof. The native save
  dialog writes both old compatible and new independent files; the latter has
  the Axterm format marker and no credential reference or old fixture secret.
  It selects that file again, selects portable-settings restore, commits a
  zero-collection settings import and verifies the next-start/current-workspace
  safety notice plus File Grant release.
- `bunx playwright test tests/e2e/desktop.spec.ts --grep 'claims Axterm and migration-period Legacy Prototype URLs' --project=desktop`:
  the source Electron journey passes after delivering one identical FTP URL as
  both a transition-period `legacy-prototype://` and a native `axterm://`
  second-instance launch. Both paths open the same prefilled form; only the
  legacy scheme carries an in-memory marker and presents a dismissible migration
  notice. The test confirms that the native scheme does not show that notice and
  that the session-only password is absent from browser storage.
- `bun run --cwd apps/desktop package:dir` followed by
  `bunx playwright test tests/e2e/packaged.spec.ts --grep 'packaged migration surfaces' --project=packaged`:
  one unsigned macOS arm64 packaged journey passes after copying the app
  outside the checkout. It validates the new file marker, omission marker and
  displayed SHA-256, first delivers the same legacy/native FTP deep-link pair,
  verifies equivalent prefilled forms and the legacy-only dismissible notice,
  selects the portable-settings option, then imports a separately constructed
  configuration host through preview/commit and verifies the packaged Runtime
  SQLite result before exercising the old remote backup.
  `app.asar` SHA-256:
  `96ad4f133e2dee02fd6f19e81a76ec6c78c0cb54792098ce68e10fe0cac1242a`.

The importer covers portable collections plus a deliberately bounded,
user-selected setting restore; it is not a full SQLite/Vault backup. Remote
sync still uses the legacy v1 document and paths. No Windows/Linux packaged
journey, real old-version fixture, public migration release, duration or final
compatibility removal is implied.
