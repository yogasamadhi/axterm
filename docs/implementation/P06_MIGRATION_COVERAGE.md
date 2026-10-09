# P-06 migration coverage and removal gate

> **Historical audit, superseded by [ADR-021](../adr/ADR-021-immediate-legacy-prototype-compatibility-removal.md).**
> The owner cancelled the public migration window and approved immediate removal
> before the first public release. The legacy import/link/sync capabilities and
> future-work statements below describe the former proposal, not current
> product behavior or an executable work queue. Old local and remote data are
> preserved; current Axterm configuration and sync behavior is tracked in
> [STATUS](STATUS.md).

Updated: 2026-09-24  
Status: implementation audit, **not** an accepted migration path  
Authority: [ADR-016](../adr/ADR-016-independent-open-source-product.md), [independent release matrix](INDEPENDENT_RELEASE_MATRIX.md), [execution plan](COMMERCIALIZATION_CLEANUP_PLAN.md)

This record distinguishes a user's existing local database and Vault from the
portable export, and distinguishes a remote sync document from a complete local
backup. It is a code-level inventory; it does not start the public migration
window or authorize removal of compatibility features.

The [D1 Mac engineering record](evidence/IR08-MACOS-D1-SQLITE-VAULT-FAILURE-2026-09-25.md)
adds a controlled risky-migration failure to the existing local-upgrade
success evidence: the database/automatic pre-migration copy and application-local
Vault are preserved, then the same unsigned Mac app starts after the synthetic
failure trigger is removed. This verifies a bounded rollback/recovery case,
not a preserved public old installer or every old user-data shape.

The [D2 Mac engineering record](evidence/IR08-MACOS-D2-BOOKMARK-USER-THEME-2026-09-25.md)
reruns the historical-source package upgrade against the current Mac artifact:
Bookmark/Host/Profile links and the user-created theme remain intact, the
removed built-in selection falls back, and the pre-migration database retains
the old state. The historical producer remains a source rebuild, not a
verifiable old public installer.

The exact temporary production-source boundary was documented in the
controlled historical evidence archive. The remaining executable guard is
`scripts/commercialization/audit-legacy-prototype-transition-boundaries.mjs`. It is a
containment check for this former migration period, not evidence that the public
release, migration window, or final P-06 removal gate has completed.

During the migration period, legacy Legacy Prototype config import accepts the former
15 locale IDs and their recorded upstream aliases: English, Japanese,
Simplified Chinese and Traditional Chinese map to Axterm's four retained IDs;
the other 11 former locales map to English with an explicit preview reason.
Unknown locale values remain visibly omitted rather than being silently
coerced. SQLite migration 38 likewise preserves the four retained persisted IDs,
maps each of the 11 retired IDs to English, and verifies the pre-migration
database backup retains the original value. These are migration behaviors, not
additional Axterm languages. The focused Runtime tests use the historical
`657b3cc` catalog's IDs and `upstreamId` aliases and pass 67/67.

A fresh unsigned macOS arm64 directory package also passes two focused
language-migration journeys: its legacy-import preview explicitly explains the
retired-locale-to-English fallback and passes an axe scan, while its persisted
`de` upgrade path selects English, exposes exactly the four supported locales,
and retains a pre-migration database backup. The package hash, commands and
synthetic-fixture limits are recorded in the
[IR-05 packaged locale-migration evidence](evidence/IR05-PACKAGED-LOCALE-MIGRATION-2026-09-24.md).
This is not translation/rights review or Windows/native-Linux evidence.
The same current package's full Playwright run passed its legacy migration,
Axterm-format recovery, frozen historical Axterm portable import, prior
schema/Vault upgrade, and sanitized custom-theme import/reselection journeys.
The custom-theme test confirms that the preview redacts palette values, skips
the two automatic built-in rows, remaps the selected theme, and leaves exactly
one target user-theme row after commit. Reimporting the same file through the
packaged UI previews the theme and selected setting as unchanged and disables
the zero-item commit. Exact artifact hashes and the ten
platform or fixture skips are recorded in the [current macOS packaged-suite
evidence](evidence/PACKAGED-MACOS-ARM64-SUITE-2026-09-24.md); this does not
supply a preserved public old binary or cross-platform migration release proof.

| Surface                                 | Current behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Migration gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local upgrade                           | Existing Axterm SQLite and application-local Vault remain the live sources. Theme migration 34 has a pre-migration database backup. The copied-outside-checkout macOS packaged prior-schema fixture crosses migrations 32, 34, 36 and 37 while preserving a password Host, Quick Command, legacy WebDAV profile and three local-Vault secrets; the rebuilt profile remains `legacy-legacy-prototype-v1`. A separate packaged journey now builds exact historical commit `657b3cc` (the 2026-09-14 `Initial open-source release`) in a detached worktree, uses that old package's real UI to create a password Host/Bookmark, Quick Command, the removed `3024 Day` (`…0003`) global theme selection and a WebDAV profile with Vault-backed access/encryption passwords, and uploads both encrypted and plaintext old-format documents to a controlled loopback WebDAV service before launching the current package on the same user-data directory. Migrations 34–38 complete; the current UI exposes the data, four-entry catalog with mint Axterm `Default` selected and the profile under the explicit legacy format; SQLite records both the `…0003` → `…0001` fallback and `legacy-legacy-prototype-v1`; all three Vault credentials remain byte-identical and decryptable; and the automatic pre-migration-34 rollback database is byte-identical to the database produced by the historical package and retains the old theme/profile. In separate encrypted and plaintext recovery passes, the test deletes the local Quick Command and changes the local appearance setting; the current package presents the legacy preview and restores both values only after explicit commit, while both remote objects remain byte-identical.                                                                                                                                                                                                                                                                                                                         | The historical package was rebuilt now from source, is unsigned and reports the same `0.10.0` version as current; it is not an archived binary proven to have been publicly distributed. Preserve a genuinely distributed old installer and sanitized representative artifacts if available, then add Windows and native-Linux installed-package upgrades, a real version-number transition, live-provider evidence and other historical document shapes. A portable file must not be described as a Vault backup. See [historical package evidence](evidence/IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23.md). |
| Legacy Prototype-compatible data export | `Legacy PrototypeDataService.buildPortableExport()` writes the legacy top-level `bookmarks`, `bookmarkGroups`, `profiles`, `quickCommands`, `config` fields with an `_axterm` version-2 extension. It exports SSH bookmarks with resolvable hosts, groups, profile usernames, quick commands, selected settings, desktop preferences and credential _metadata_. File size is capped at 16 MiB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | It is not an independent Axterm format or a complete backup. The separately versioned `axterm-configuration` v1 path covers portable collections and an opt-in settings restore; this legacy file remains only for the public migration period. A 2026-09-14 historical-source package export and current-package import are now recorded; broader historical file shapes and preserved public installers remain unverified.                                                                                                                                                                                  |
| Legacy Prototype-compatible data import | A preview and explicit commit apply selected legacy fields. The importer caps the input at 16 MiB and tests self-export round-trip, oversized rejection, and transactional rollback. SSH plus the documented Legacy Prototype Local, Telnet, Serial, RDP, VNC, FTP, SPICE and Web bookmark shapes convert into Axterm bookmarks; referenced Connection Profiles are remapped, inline protocol passwords and authenticated proxies enter the application-local Vault, and Legacy Prototype `runScripts` are reported as omitted rather than executed. Generic bookmark mappings use SQLite migration 39, which preserves the prior SSH mappings and creates a pre-migration backup. Group/Profile/Quick Command and bookmark field reports show mapped and omitted fields; secrets stay redacted. Version-controlled synthetic field fixtures cover all eight non-SSH protocols, with a historical Axterm package artifact separately proving its own SSH-only export handoff. A sanitized derivative of an official Legacy Prototype v1.101.16 UI export exercises seven non-SSH shapes; six import while a blank-username RDP record is explicitly skipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Keep for the announced migration period. This one published-app version does not cover every Legacy Prototype release or data collection. IR-08 still requires the public migration release/date/window, preserved public installer, Windows/native-Linux migration/recovery and other release evidence.                                                                                                                                                                                                                                                                                                      |
| Legacy sync                             | `SyncDataDocument` version 1 uses eight selectable categories: settings, bookmarks, terminal themes, quick commands, profiles, address bookmarks, workspaces and triggers. The `bookmarks`, `profiles` and `settings` categories are built through the legacy portable document; preview/commit also pass through the legacy importer. Secret values are excluded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `axterm-sync` v1 now provides a separately versioned remote envelope and explicit preview/commit path. Verify representative old documents, category parity, recovery and cross-platform provider/package behavior before treating it as a migration exit. Sync is not a substitute for a complete local/Vault backup.                                                                                                                                                                                                                                                                                        |
| Remote objects                          | WebDAV reads/writes under `/legacy-prototype/` with the configured remote filename. GitHub/Gitee Gist and named-file Custom containers retain the legacy `axterm-sync.json`; raw Custom sync may expose one object at the configured endpoint. Settings offers a read-only backup through a save File Grant without parsing, decrypting or mutating the remote object; the local write is atomic with mode `0600`, capped at 24 MiB and reports SHA-256. WebDAV and raw Custom response bytes are preserved exactly, including invalid UTF-8. Gist/Gitee and named-file Custom expose file bodies as JSON text fields, so their saved backup is UTF-8 encoding of the provider-returned string rather than an inaccessible underlying storage stream. Unknown or malformed raw Custom bodies remain byte-for-byte recoverable, while normal sync loading rejects invalid UTF-8. Runtime tests drive all four built-in HTTP adapters through the boundary. A copied macOS directory app and the current APT-installed emulated Linux x64 package each back up all four controlled providers, create the independent WebDAV path or `axterm-sync-v1.json` named file, and leave the legacy payload exact. Their GitHub, Gitee and named-file Custom cases also diverge a local setting after upload, use packaged preview plus explicit commit to restore it, and prove that download/recovery performs no additional remote write. The historical-source macOS package now uploads an 8,869-byte AES-256-GCM+scrypt document and a 6,568-byte plaintext version-1 document to a controlled loopback WebDAV service; after migration, the current package recovers the deleted Quick Command and changed appearance setting from each object through preview and explicit commit. The encrypted SHA-256 `a43d5bc9dbcbde23c66123f3a066e75483348f5a6ca278d0006e0cdcc0347a58` and plaintext SHA-256 `1a7ef3993f6a8a0764a18e3a27930bae48e3cf1d8fc764b724b1da1dcb136008` remain unchanged; each object records three reads and only the historical package's single write. | Verify live-provider plus packaged Windows and native-Linux desktop backup paths and additional representative old-provider/document shapes. The controlled HTTP fixtures are not real cloud-account evidence. Provider APIs that expose file contents only as text do not reveal underlying storage bytes. A raw single-object Custom endpoint cannot safely host both formats and is rejected before `PUT`; it must expose a named-file container or use a separate endpoint. Never delete or overwrite an old remote object as a side effect of migration.                                                 |
| Deep links                              | Desktop Main registers and accepts `legacy-prototype://` alongside `axterm://` and other connection schemes. Parsing the legacy scheme creates only an in-memory `legacyScheme` marker; Renderer shows a dismissible migration notice and never sends that marker to REST, SQLite, logs or browser storage. Source Electron, copied-outside-checkout macOS arm64 and APT-installed emulated Linux x64 packaged journeys send the same FTP URL through both schemes as a second-instance launch, verify equivalent prefilled form values and confirm that only the legacy form shows the notice; the source journey also confirms no secret reaches browser storage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Keep the old scheme during the public window, add Windows and native-Linux desktop-registration evidence, and then remove the registration/parser only in a later release.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Command-line workflow import            | `--batch-op` accepts Axterm's native bounded JSON, the migration-period Legacy Prototype workflow array and the CSV shape shipped in Legacy Prototype v1.101.16. CSV rows must name the same saved SSH Bookmark; `command` and `commandAfter` become ordered Axterm steps, inline passwords are discarded, and source field names only are reported in the migration notice. Upload/download actions are rejected because this boundary has no File Grant. The migration notice explains that old CSV rows become one Axterm operation rather than separate old-version sessions. Unit, source-Electron and copied macOS packaged journeys cover both legacy formats, secret redaction and transfer rejection. The CSV fixture is a sanitized, independently authored derivative of the released app's bundled example shape, not user data or a byte-identical app export.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Keep both legacy parsers only for the announced migration period. Preserve a genuine user-created old-version workflow if available, then add Windows/native-Linux installed-package evidence and remove the parsers and warnings only in the removal release. The published app's bundled example proves its CSV format, not real-user workflow coverage; current unsigned macOS tests are not signed installation or public migration release evidence.                                                                                                                                                     |

The JSON migration report records actual unsupported/shadowed source paths
without copying their values into the UI. The second-instance queue regression
also fixed a lost-wakeup race and is covered by source and packaged journeys;
neither fix substitutes for the public migration release or cross-platform
acceptance gates above.

GitHub Gist file responses marked `truncated` now use the provider's `raw_url`
only when its HTTPS host, Gist ID, revision path and selected filename match
the expected GitHub raw-file shape. The Runtime does not forward the Gist API
credential, follows no redirects, and applies the same 24 MiB streaming bound.
This preserves raw bytes for migration backup and strictly decodes them for
normal sync. Gitee truncation remains fail-closed until its raw-file behavior
has provider-specific verification. A dedicated `SYNC_GITEE_TRUNCATED` error
now tells users in all four retained languages to keep the old profile/object
unchanged and verify a complete backup before migration; it deliberately does
not offer GitHub-specific clone instructions. Both normal load and read-only
backup reject the partial response without a raw-file request. GitHub
documents that files above 10 MB
and file lists above 300 entries need the Gist clone route. The adapter now
verifies the raw response length against the API's declared file size and
refuses to treat a missing filename in a truncated file list as an absent
remote object. When the complete object cannot be verified it returns
`SYNC_GIST_CLONE_REQUIRED` rather than silently using partial bytes or
reporting the Gist as missing. Axterm still does not implement Git transport.
The release [migration-guide draft](MIGRATION_GUIDE.md) documents a manual,
non-mutating Git-client backup fallback; the localized UI now surfaces the
recovery requirement and an expandable four-step procedure: copy the configured
Gist HTTPS clone URL, clone to a new private local directory without pushing,
copy the configured sync file to a protected backup, and record its byte size
and SHA-256 while preserving the existing remote profile until the new Axterm
profile is verified. This does not replace packaged provider coverage or close
IR-08. See
[GitHub's Gist truncation documentation](https://docs.github.com/en/rest/gists/gists#truncation).
The Application boundary regression now drives both the authenticated Gist
metadata response and the unauthenticated raw-file response through the save
File Grant, checking byte equality, SHA-256 and absence of Authorization on the
raw request.

## Released Legacy Prototype v1.101.16 CSV evidence

The official v1.101.16 macOS arm64 release package was verified from its
published SHA-256 and Apple code signature. Its bundled command-line source
describes `-bo/--batch-op` as loading and running a CSV file. The signed app's
`batch-op-1.101.16` Renderer chunk includes a nine-column example in this
order: `host`, `port`, `username`, `password`, `command`, `localPath`,
`remotePath`, `action`, `commandAfter`; its UI parser accepts `upload` and
`download`. The sanitized Axterm fixture retains the schema with a
`.example.test` host and a test-only password, while using harmless `printf`
commands. It is not represented as an actual old user's workflow or as bytes
exported by a launched Legacy Prototype process.

Axterm's separate parser uses no Legacy Prototype implementation code. It bounds and
validates CSV structure, requires one saved SSH target, never uses a password
from the file, maps command fields only, and rejects transfer actions before
creating an operation. The notice surfaces omitted field paths without source
values and warns about the old per-row-session versus new single-operation
behavior. Exact release identity, hashes, source entry names, test results and
remaining limits were recorded in the private IR-08 CSV workflow evidence archive.

The legacy-data preview reports **zero mapped fields** for any skipped
bookmark, including records rejected after dependency or identity validation.
Its omitted-field list reflects up to 64 source field names whose values are
not `undefined`, `null` or the empty string, except the source identity; names
are bounded and sanitized, while secret **values** remain out of the preview.
Synthetic Telnet, changed-identity SSH and missing-host SSH fixture assertions
cover skipped records. The published-app fixture also verifies that an
incomplete RDP record with no username is reported as `Skip` before commit,
instead of surfacing a schema error only after the user commits.

Saved Legacy Prototype `terminalThemes` records are also covered at the data-import
boundary. The preview does not expose palette values; valid rows are imported
as Axterm user themes in the same transaction, and the source-to-target ID map
makes repeat imports idempotent. A selected imported custom theme is remapped
in settings without replacing the user's existing Axterm terminal background.
If its row is missing, selection falls back to Axterm Default;
missing/invalid palette fields use Axterm-owned defaults, while rows with no
valid colors are skipped before commit. Ambiguous duplicate source IDs and
rows beyond the 256-theme import bound are also skipped with zero mapped fields.
Risky SQLite migration 40 extends the
identity-map kind constraint and retains mappings from migration 39. Focused
importer, SQLite and sync-source tests cover these code paths; this is not a
public migration-release or source-rights approval.

A source-Electron desktop journey reads the sanitized derivative at
[`legacy-prototype-v1.101.16-custom-terminal-theme-ui-export-v1.json`](../../tests/fixtures/migration/legacy-prototype-v1.101.16-custom-terminal-theme-ui-export-v1.json),
confirms the user-visible theme count and field-only preview, commits the
import, then verifies the stored Axterm theme, selected settings ID and
source-to-target mapping in SQLite. Runtime and desktop tests both pin the
derivative's SHA-256. The source row was a fictional test theme created and
saved in Legacy Prototype v1.101.16's released UI and then included in that binary's
Settings Sync export. The two auto-exported built-in rows retain only their
stable IDs and names, not their upstream palettes; Axterm previews them as
skipped and maps a selected `default` / `defaultLight` to Axterm's own Default /
Default light. The fictional custom row's exact palette and selected ID are
preserved. This is real published-app output, but not real-user data, a
byte-identical export, source-rights approval or a public migration release.

The [Legacy Prototype-maintained bookmark field
reference](https://github.com/legacy-prototype/legacy-prototype/wiki/system-prompt-you-can-use-in-any-llm-chat-to-create-legacy-prototype-bookmark-data)
documents the legacy shapes for SSH, Telnet, Serial, RDP, VNC, FTP, SPICE,
Web and Local bookmarks and informed the conversion field map. It is a field
reference, not an export. The separately archived v1.101.16 UI-export evidence
is a genuine released-binary export reduced to seven fictional, secret-free
non-SSH bookmark records; it demonstrates those seven shapes for that version
only. The other protocol-shape cases remain synthetic, and neither source
proves that every published Legacy Prototype build emits the same records.

The exact historical-package path now goes beyond preserving a saved profile.
The package rebuilt from commit `657b3cc` performs both encrypted and plaintext
old-format uploads itself; the current package later reads each byte-identical
object and restores an intentionally deleted Quick Command plus a changed
appearance setting only after the user-visible preview and explicit commit. The
controlled loopback server observed three reads and the historical package's
single write for each object, so neither recovery pass mutated the remote
object. This is reproducible transition evidence, not a claim about a live cloud
account or every historical document shape; see
[IR-08 historical package evidence](evidence/IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23.md).

The same packaged transition now has the old application create its own
user terminal theme before the upgrade. A cold-profile restore, the rollback
database and the upgraded database preserve the theme's exact row fields, and
the current packaged UI shows it. The old Legacy Prototype-compatible portable export
omits custom themes; it is not a substitute for the full-profile backup or the
current Axterm configuration export. The follow-up additionally exports the
upgraded custom theme in Axterm's independent configuration format and imports
it into a fresh packaged-app profile, checking its terminal and UI palettes
against the historical payload without carrying Vault secret values. This
narrower follow-up is recorded in the private custom-theme evidence archive.

Two version-controlled, explicitly sanitized derivatives of those old-package
WebDAV outputs now provide clean-checkout regression inputs. The raw encrypted
and plaintext outputs remain ignored because their documents contain a real
test-machine device name. The plaintext derivative changes that field; the
encrypted derivative decrypts, changes it and re-encrypts with fresh salt/IV,
so neither derivative is claimed byte-identical to the old package's remote
object. Runtime tests cover both envelope formats and remote read-only
preview/commit; a real legacy data-source test imports the plaintext document
into a fresh database and checks the Quick Command and SSH Bookmark. Exact
hashes and provenance limits are in the linked IR-08 evidence. The final
source/rights review and public migration-release gate remain open.

The same historical-source package now also exercises its own production
save-file/export action. Its 11,477-byte version-2 legacy file was opened by
the current packaged app in a **fresh** user-data directory, previewed and
explicitly imported. The preview created five records: a group, two SSH
Bookmarks, a connection Profile and the one-step Quick Command. It left
portable settings unchanged by default, skipped three credential-metadata
records and visibly reported the unmapped group `level`. In the earlier run,
the Quick Command `command` and `commands[].id` fields were also reported
unmapped; the current importer preserves a matching top-level command and
valid, non-duplicate UUID step IDs, and the updated historical-package journey
checks the old export's step ID against the imported SQLite payload. Invalid
or duplicate IDs still generate new IDs and remain reported as omitted. Both
imported Bookmarks retained the
group reference, the second kept its connection Profile reference, the
direct Host retained its address/username but no password credential
reference, and the Quick Command retained `uptime`. The old database,
automatic rollback copy and upgraded database preserve the same group/Profile
relationships. This closes one representative historical-source portable-file
handoff, not every old-format shape or a publicly distributed old binary.
The file's intentionally omitted Vault secrets still require local upgrade or
manual re-entry. See the [latest IR-08 package record](evidence/IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23.md).

The exact 11,477-byte JSON from that old package's production export action
is now a byte-frozen, secret-checked transitional fixture at
`tests/fixtures/migration/historical-axterm-portable-v2-657b3cc.json`
(SHA-256 `250a533d009e2b62ccc3723425584f9fad90efe9849b60ea41e2dcb583f3c0dc`).
Unlike the deliberately synthetic v1 shape, this v2 file was produced by the
historical Axterm package itself. Runtime, source Electron and copied macOS
packaged-app tests independently load it from a clean checkout; the file is
kept byte-identical rather than formatted. This improves reproducibility,
but its controlled test accounts and unsigned rebuilt producer cannot stand
in for a preserved public installer, real-user artifacts or other old shapes.
It remains migration-period data subject to final source/rights review.

The historical-package journey also tests a different, complete local recovery
path: with the old app closed, copy the **entire** user-data directory to a
protected backup, copy that backup into a fresh location, then launch the
current packaged app on the restored location. The test verifies byte-identical
pre-upgrade SQLite/Vault backup inputs, Runtime startup and migration 38 in the
restored copy, preserved group/Profile/Bookmark relationships, theme fallback,
saved sync profile and decryption of all three Vault credentials; both the
original profile and cold backup remain unchanged until the separate original
upgrade runs. The [migration guide](MIGRATION_GUIDE.md) now gives this manual
cold-copy boundary explicitly. This is not an in-app backup feature or proof of
real-user, cross-device, Windows or Linux restore; portable files and remote
sync still are not Vault backups.

The approved implementation boundary for the remote format is
[ADR-017](../adr/ADR-017-axterm-sync-format-migration.md). In particular, it
requires a distinct typed Axterm data source, per-format profiles and separate
remote names/paths; it forbids in-place header/path renames and remote-object
mutation during conversion.

The provider unit suite makes the four new targets independently executable:
WebDAV uses `/axterm/`, GitHub and Gitee each use their own authenticated Gist
request with `axterm-sync-v1.json` and the independent description, and Custom
uses the same distinct filename. An existing Gist or named-file Custom
container that has only `axterm-sync.json` is treated as a missing Axterm
target, not as a malformed Axterm document. Gist PATCH creates only the new
file so the service retains the old file; Custom merges the old and new files
into one conditional `PUT` using the container ETag. A raw single-object Custom
response is deliberately rejected before any Axterm `PUT` because it cannot be
updated without replacing the old object. These are controlled HTTP semantics,
not proof of a real account or public migration release.

`axterm-sync-document.ts` derives a separate `format: "axterm-sync"` /
version-1 category document from the typed `AxtermConfigurationService`
snapshot. Bookmarks include their host/group dependencies; profiles, themes,
commands, triggers, address bookmarks and workspaces retain distinct values
and deterministic hashes. It does not import `Legacy PrototypeDataService` or create a
legacy `_axterm` extension, and snapshot omissions remain declared. The
Runtime now selects this document source for an `axterm-sync-v1` profile when
comparing or uploading; that implementation step is not the remote-sync
conversion or IR-08 acceptance evidence.

SQLite migration 36 adds the immutable `format` marker to every existing
sync-profile row. Repository creation
still records `legacy-legacy-prototype-v1`. Risky SQLite migration 37 rebuilds the
profile table with a `(provider, format)` unique index, so legacy and Axterm
profiles can coexist for the same service without sharing a remote object. The
standard profile-create operation remains legacy-only; the new format is only
created through the safeguarded conversion flow below.

`DataSyncService` selects the source by immutable profile format. Without an
independent source it still fails closed, so a future-format row cannot reach
the legacy data source. The production Runtime now supplies
`AxtermConfigurationSyncDataSource`: a marked Axterm profile can compare and
upload the strict independent document, and can save a raw remote backup,
without reaching `Legacy PrototypeDataService`. The legacy download-preview,
commit/pending/cancel endpoints remain explicitly unavailable for that profile
because their public response shape is still an `Legacy PrototypeDataPreview`. Separate
`axterm-download-previews` and `axterm-download-commits` endpoints instead
return `AxtermConfigurationPreview`/import results, retain the same bounded
in-memory preview and explicit-commit behavior, and never adapt the new format
into legacy response fields.

`POST /sync/profiles/{id}/axterm-migrations` is the only current creation
path for an Axterm sync profile. It requires the legacy profile's ETag and a
writable save File Grant, writes the unmodified old remote object before
creating the new profile, preserves the old profile and starts the new profile
with automatic sync disabled. Both profiles can deliberately share their local
Vault references; updating or deleting one profile now deletes a reference
only when no other sync profile uses it. A failed backup or stale source profile
creates nothing.
Automatic Axterm download profiles remain unscheduled because remote
application requires a user review and explicit commit, so this path never
produces recurring failed sync states.

The independent document now also has its own strict Contract schema. It
requires the `axterm-sync` v1 header, at least one recognized category,
bounded counts and SHA-256-shaped hashes, and the configuration omission
metadata. Runtime parsing additionally recomputes each selected category's
count and stable content hash. Any non-null `*CredentialRef` in the document
is rejected. These validation rules identify and protect the future document;
they are now used by the Provider, remote `/axterm/` location and the separate
download-preview/import transaction.

`AxtermConfigurationSyncDataSource` now composes that format with the typed
configuration service: it creates an independent document from a fresh
configuration snapshot, and merges only the Profile-selected remote categories
into a fresh local snapshot before using the existing bounded
preview/explicit-commit transaction. Missing selected categories are rejected;
unselected local collections remain in the merged document. It does not import
or call `Legacy PrototypeDataService`, and it does not read a File Grant. It is wired
to the Runtime's profile-format source selection for independent comparison and
upload, plus the distinct Axterm remote preview/explicit-commit endpoints. The
repository and guarded REST conversion path implement the `(provider, format)`
dual profile migration. Settings now exposes the two formats as separate tabs
for each provider. When a provider has only a legacy profile, its Axterm tab
shows a single guarded action rather than an editable new-format form: the user
must choose a save target, the Runtime backs up the legacy remote object, and
only then is the separate, auto-disabled Axterm profile created. An
Axterm-only provider defaults to its independent tab and does not offer a new
legacy-profile form. Both service and format tablists now have roving focus and
Home/End/arrow-key activation; a source Electron regression creates a real
legacy WebDAV profile, switches to the migration surface by keyboard and keeps
its backup/create action horizontally bounded at 200% interface zoom. The
public conversion/recovery flow remains incomplete.

Settings serializes address bookmarks and named workspaces as part of its
general category while the sync document also offers dedicated categories for
each. Preview now applies selected dedicated categories after the broad
Settings category, so a settings snapshot cannot overwrite a selected,
independently restored collection. An Application test commits the same
controlled document with both forward and reverse category order and verifies
both dedicated values in SQLite.

The shared HTTP providers now also select their remote object from the immutable
Profile format: legacy WebDAV remains below `/legacy-prototype/`, while the reserved
Axterm format uses `/axterm/`; Gist and named-file Custom containers use
`axterm-sync-v1.json` rather than the legacy payload name. With the Runtime
source selection above, an Axterm-format profile never interprets the legacy
payload as its target. Gist PATCH retains the old sibling file; Custom includes
both exact named-file contents in its ETag-guarded update; and an unsafe raw
Custom replacement fails closed. A source Electron E2E drives
the Settings flow against a real loopback WebDAV server: it uploads the legacy
document, saves an exact backup while creating the Axterm profile, verifies the
legacy object remains unchanged, writes an independent `axterm-sync` document
only to `/axterm/`, then uses the separate preview and explicit commit path.
The fixture uploads a real SSH host/bookmark, a linked Quick Command folder and
two-step command with user-authored description and tags, a custom terminal
theme referenced by the portable terminal settings, and all three Profile
collections: connection, terminal and tunnel. The bookmark references both the
connection and terminal Profiles, the portable default-terminal setting
references the terminal Profile, and the tunnel references the SSH Host. The
fixture also adds a remote address bookmark linked to that Host, a named and
active workspace whose terminal tab references the Host, bookmark, terminal
Profile and custom theme, and a global cooldown trigger. It changes the remote
Axterm appearance setting, removes the address-bookmark and workspace copies
from the remote `settings` category, and recomputes that category hash while
leaving the dedicated `addressBookmarks` and `workspaces` categories intact.
After deleting each local record in dependency-safe order and resetting the
local settings, the reviewed commit restores all eight independent categories
into the product SQLite database. It verifies that the recreated command
references the newly mapped folder ID and preserves both steps, delays,
description, tags and input-only behavior. It also requires the recreated
custom theme to have a new ID, retain its UI/terminal palette and become the
restored terminal setting's selected theme. All three Profiles must receive new
IDs while the restored bookmark, default-terminal setting and tunnel point at
the matching new Profile/Host IDs; credential references remain null. The
address bookmark and both workspace layouts must point at the same recovered
Host/bookmark/Profile/theme IDs, the startup selection must point at the
recovered bookmark, and the trigger must retain its matching/action/cooldown
fields under a new ID. This proves those three dedicated categories restore
independently of their cleared `settings` copies. The legacy remote object and
write count remain unchanged. This is a local source recovery test, not a public
release note, old-release recovery commitment, live-provider proof or a
migration release. A separate packaged Electron E2E now runs both from an
unsigned macOS arm64 directory app copied outside the checkout and from the
current APT-installed emulated Linux x64 package. It stubs the Desktop Host
save-dialog response and runs the guarded action against a
dual-path loopback WebDAV server. It proves the packaged UI presents the
guarded action, reads the old object a second time, saves an exact migration
backup, retains the Axterm-format tab and writes an encrypted independent
document only to `/axterm/`. The converted profile inherits the locally stored
encryption credential, and the AES-256-GCM+scrypt envelope contains neither the
Host name/address, Quick Command, custom theme, workspace, trigger or the
encryption password. Before upload the fixture builds all eight categories: a
linked Host/bookmark, Quick Command tree, custom theme, connection/terminal/
tunnel Profiles, address bookmark, named/current workspace and trigger, plus
portable settings that reference those records. It then deletes every local
record in dependency-safe order, clears the address/workspace copies and changes
the local appearance from light to dark. The packaged download preview plus
explicit commit decrypts the remote object and restores all eight independent
categories. Recreated records receive new IDs; the bookmark, tunnel, terminal
setting, address bookmark, current/named workspace layouts and startup selection
all point at the matching recovered Host/bookmark/Profile/theme IDs, while
credential references remain null. The old `/legacy-prototype/` bytes remain exact,
with two reads and zero writes; the Axterm object receives one encrypted upload
and no download-side write. This is packaged macOS directory-app and emulated
Linux installed-package evidence for backup, encrypted isolated upload and
reviewed eight-category decryption/recovery, not a real native-dialog
interaction, signed/native-desktop artifact evidence, Windows package evidence, a live-provider test,
old-release recovery coverage or a public migration release/duration decision.

A second packaged journey covers the remaining controlled HTTP providers from
both the copied-outside-checkout macOS app and the APT-installed emulated Linux
x64 package. Through the production Settings UI it creates
legacy GitHub Gist, Gitee Gist and Custom profiles against a loopback service,
authenticates with the actual Bearer, token and HS256 JWT forms, saves each
legacy payload byte-for-byte through the guarded conversion, and performs the
first Axterm upload while only `axterm-sync.json` exists. GitHub and Gitee add
`axterm-sync-v1.json` through PATCH without replacing the legacy file. The
named-file Custom response sends the existing container ETag, and its PUT body
contains both the exact legacy file and the independent document. Together with
the WebDAV journey above, this provides packaged macOS controlled-provider
backup and non-overwrite coverage for all four providers. After every GitHub,
Gitee and Custom upload, the journey changes the local appearance setting,
downloads the independent named file through packaged preview plus explicit
commit, and requires the remote value to be restored. The legacy and Axterm
named files remain byte-exact and each container still has only its one upload,
so recovery is read-only. It is not live-account behavior, native-dialog
evidence, signed/native-desktop packaging, Windows or native-Linux coverage, historical-format
recovery or public migration acceptance.

The focused document/source/provider/service tests and the complete source
gate pass as of this entry: 950 tests with 33 skips, the Level 1 architecture
gate (368 modules / 1,313 dependencies), 267 Contract operations,
component/license/SBOM checks, production build and seven Axterm
visual/accessibility journeys. The separate emulated Linux installed-package
gate passed all 18 applicable journeys with seven declared skips. This is
engineering evidence only; it does not
accept IR-08 or start the public migration window.

## Axterm configuration snapshot v1

The new `AxtermConfigurationService` independently reads typed product
repositories rather than calling `Legacy PrototypeDataService`. Its
`axterm-configuration` version-1 file covers host groups/hosts, all-protocol
bookmark groups/bookmarks, connection and terminal profiles, tunnel profiles,
quick-command groups/commands, user-created terminal themes, global triggers
and settings (including named workspaces and address bookmarks). The exporter
does not read Vault values. It nulls stored credential references, disables
credential-dependent custom proxies, resets image backgrounds whose binary
assets are not in the file, and records each affected field path. It lists
excluded collections in the file, limits output to 16 MiB, writes through a
Desktop Host save grant and reports SHA-256. User-authored commands and other
free-text configuration may still contain private data, so the UI warns users
to protect the file.

This is not a full backup or a complete conversion path. A read-only inspection
action opens an Axterm file through a File Grant, strictly validates its
structure and UTF-8/16 MiB bound, and reports duplicate IDs, missing
references, reference cycles and collisions with the current profile.

The same file can now enter a bounded **preview then explicit commit** path.
The preview is held only in Runtime memory for ten minutes (at most four at a
time), has no writable File Grant, reports create/unchanged/conflict counts and
does not write product data. A commit rechecks the importable target-collection
fingerprint and runs
in one SQLite transaction. It deterministically maps newly generated target
IDs for groups, hosts (including jump chains), all bookmark protocols,
connection/terminal/tunnel profiles, quick commands, custom themes and global
triggers; a persistent fingerprint mapping makes a repeated file idempotent.
Any database constraint failure rolls back prior writes. By default, global
settings, workspaces and the application-local Vault are deliberately
preserved, so an ordinary import does not silently replace local preferences or
secrets. A user can explicitly select **restore portable settings** in the
preview. That opt-in replaces the portable appearance, workspace layout/named
workspaces/startup selection/activity rail, shortcut, terminal, file-manager
address-book and monitor values; it remaps host, bookmark, terminal-profile and
custom-theme references as part of the same transaction. The live workspace is
left open to avoid orphaning active sessions, so its imported layout is used on
the next full Axterm start. Renderer layout persistence is suspended from the
start of a setting-enabled commit through that restart, preventing the still-
open pre-import workspace from overwriting the imported settings. A response
that confirms settings were not applied releases the suspension; an uncertain
response remains protected because the Runtime commit may already have
succeeded. It applies a proxy
only when the exported proxy has no credential dependency. Privacy choices
(including history collection), the Vault and credential-dependent proxy values
always stay local; an omitted image background remains the safe non-image
fallback. A settings opt-in includes settings in the stale-preview fingerprint,
so a local setting change requires a fresh preview. The file still does not
contain Vault secrets, background image bytes, history, known-host trust, AI
history or sync profiles.

This initial importer now has an explicit settings/workspace conversion policy,
and the local dual-format WebDAV journey covers reviewed remote-setting, linked
SSH host/bookmark, linked Quick Command folder/command, cross-category custom
theme/settings, all three Profile collections, address bookmarks, named/current
workspaces and global triggers through all eight Axterm sync categories. It
still needs real old-version fixtures and historical-format recovery,
live-provider and cross-platform packaged evidence before it can be presented
as a migration exit.

A separate source-level SQLite round trip now creates all nine Bookmark
protocols in one independent portable file, previews and commits them into a
fresh database, and confirms protocol settings, group placement and RDP/VNC/
SPICE jump-host references survive new-ID mapping. Six source credential
references do not enter the file or target, and a repeated preview is
idempotent. This protects Axterm's independent format; it does not expand the
legacy Legacy Prototype-compatible importer, replace a Vault backup, or supply an old
public-binary or Windows/native-Linux package result. See the
[nine-protocol portable-file evidence](evidence/IR08-ALL-PROTOCOL-PORTABLE-2026-09-23.md).

## Required sequence

1. Freeze representative old Axterm database/Vault, data-file, encrypted and
   plaintext sync, and deep-link fixtures. Record exact versions and hashes;
   do not commit real credentials or user data.
2. Extend the implemented bounded import preview/commit with real old-version
   fixtures, field-level loss reporting, independent round-trip tests and
   platform evidence. Its current portable-collection and opt-in setting
   coverage, exclusions and local-only values are explicit; it is not a Vault
   or background-image backup.
3. Verify the implemented remote backup path against all supported providers
   and packaged platforms before a new sync location is used. Backups may
   contain sensitive metadata or plaintext when sync encryption is off; the UI
   now warns about this, and release documentation must repeat it.
4. Publish a stable migration build with tested conversion, backup instructions
   and deprecation notices. Record its **public release date** and the owner's
   chosen window (the plan recommends at least 90 days and one stable release,
   whichever is later). Internal builds do not start the clock.
5. Only after the window and all IR-08 evidence, remove old data endpoints,
   `legacy-prototype://`, the legacy command-line workflow translator and legacy sync
   paths in a subsequent release. Preserve old remote objects and provide
   release notes/recovery instructions. IR-09 stays Open until that later
   release is independently tested.

The release-record removal gate now counts **distinct subsequent stable
versions**, not `(version, date)` pairs. It rejects a milestone with the
initial migration version or a date on/before the initial public date, and
cannot count the same later version twice by assigning it two dates or different
SemVer build metadata. It also requires the removal version to follow every
milestone and the migration-window approval to predate public release. The
focused validator regression covers these chronology and identity cases. The record remains
`pending`: this is a gate correction, not evidence that any public migration
release or later milestone exists.

The [old-release fixture availability audit](evidence/IR08-OLD-RELEASE-AVAILABILITY-2026-09-21.md)
found no reachable older public Axterm release as of 2026-09-21: the current
remote had no tags or GitHub Release records, the reachable local history and
local `release/` directory only expose version `0.10.0`, and the sole tracked
migration file is deliberately synthetic. This is an evidence gap, not proof
that historical user data never existed. Before the owner deletes old history
or replaces the repository, they must preserve sanitized actual artifacts and
their hashes outside the new public source tree. Until then, IR-08 remains **In
progress** and current test fixtures must not be described as old-binary proof.

### Legacy Prototype NeDB export-tool shape (synthetic records)

An earlier format regression used the public
[legacy-prototype-data-tool](https://github.com/legacy-prototype/legacy-prototype-data-tool), version
`2.1.10`, source commit
`47716d7633bb8a360f4f237f5ab4169c7c9d5264`. Its checked-out exporter reports
the source application version as `1.101.16` and documents exporting NeDB v1
and SQLite v2 records to the legacy JSON shape. The historical fixture
`legacy-prototype-data-tool-2.1.10-neDB-export.json` is retained in the private
[W-14-01 source archive](evidence/W14-01-PROVISIONAL-HISTORY-BACKUP-2026-09-25.md),
not in the new source snapshot. It is a formatting-normalized copy of the tool's NeDB-v1 export output from a
temporary database containing only invented RFC 5737 example addresses and
`SYNTHETIC_*` passwords. The raw CLI output SHA-256 was
`a2eb2430a104bd2a6f31f5aa48130d9e367a852536ded2ed8a6ecf79c862878a`; the
committed fixture SHA-256 is
`4871e01b3f9d1d13a14eac740336934b3d8a23e279130fe0867a065d54fa00ec`.

That export exposed a real identity mismatch: NeDB emits `_id`, while the
migration path only recognized `id`. The importer now accepts `id` first and
falls back to `_id` consistently for bookmarks, groups, Profiles and Quick
Commands; field-level preview reporting marks the selected identity as mapped.
The regression commits all four protocol bookmarks, their group membership,
the SSH Profile reference, Quick Command and startup-session reference. It
also confirms that imported passwords reach only the application-local Vault,
the unused bookmark password is not stored, and preview/SQLite data do not
contain the test secrets.

This fixture proves compatibility with the published export tool's output
shape, but its database rows are synthetic and it was not produced by clicking
Export in a published Legacy Prototype application binary. No Legacy Prototype application
source or exporter dependency is included in Axterm. Its CLI needed temporary
Node-compatibility shims for removed legacy `util` predicates on the host
Node 24 runtime; those shims were not added to Axterm or the fixture. Therefore
the preserved-binary/user-generated artifact, current Legacy Prototype app-version
coverage, historical data diversity and cross-platform migration gaps remain;
IR-08 stays **In progress**.

### Published Legacy Prototype v1.101.16 binary and data-isolation boundary

GitHub publishes Legacy Prototype `v1.101.16` (2025-08-27), matching the source
application version reported by the export tool. Its official macOS arm64 DMG
[`legacy-prototype-1.101.16-mac-arm64.dmg`](https://github.com/legacy-prototype/legacy-prototype/releases/download/v1.101.16/legacy-prototype-1.101.16-mac-arm64.dmg)
is 114,939,894 bytes; the release API digest is
`7c44d79b3f45c2ffd48d3ed70c1cb0a5402335da87bf6261c3200d4377764aeb`. A local
download matched that digest, `hdiutil verify` passed, and the embedded app
passed strict/deep `codesign` verification with Developer ID team
`38ZYC7L6N5` and a stapled notarization ticket. The app bundle identifies as
arm64 and reports version `1.101.16`.

Static inspection of the verified `app.asar` shows this binary resolves its
database base from Electron `app.getPath('appData')` and writes NeDB files to
`legacy-prototype/users/default_user`; unlike the separate export CLI, the packaged
app code does not expose the CLI's `--data-path` / `LEGACY_PROTOTYPE_DATA_PATH`
override. A real UI-generated export would therefore write beneath the
current macOS user's Application Support directory.

On 2026-09-23, the verified public binary was launched with `HOME` set to a
temporary task directory. This was **not a sufficient isolation boundary**:
Electron still used the current account's existing `~/Library/Application
Support/legacy-prototype` profile. The app initialized its NeDB store and I saved one
deliberately synthetic SSH Bookmark (`migration-fixture.invalid`); no export
was created and no credentials were entered. The ten NeDB files and the
Electron `Preferences` file first created by that run were moved recoverably
to Trash after the app exited. The pre-existing `legacy-prototype.db`,
`legacy-prototype_data.db` and `storage-key.enc` modification times were unchanged,
but existing Chromium cache/session metadata was touched; without a pre-run
profile backup, this run cannot be described as leaving the entire app profile
unchanged, nor can we prove which existing data the app read. No commands were
entered in its automatically opened local terminal. Do not retry this binary
against the current account. A future production-binary fixture needs a
separate macOS account or an OS sandbox that denies access to the current
profile, plus an explicit before/after artifact and data-scope check.

The DMG remains a verified public release artifact, but this attempt generated
no migration export. The CLI-generated fixture above remains synthetic; it is
not a substitute for a sanitized production-binary export.

On 2026-09-23, a reachable 2026-09-14 source commit was built as an isolated
unsigned macOS package. Its production UI generated a real local database,
Vault, encrypted/plaintext WebDAV documents and a portable version-2 export;
the current package exercised in-place upgrade, both recovery formats and the
portable-file preview/commit. The exact package and field-level evidence is in
[IR-08 historical package upgrade](evidence/IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23.md).
This narrows, but does not close, the preserved-public-installer, broader
historical-data, other-provider and cross-platform gaps. A separate regression
now proves that a real self-export between 8 and 16 MiB can be previewed and
committed into a fresh database, while a file one byte over the shared 16 MiB
limit is refused before parsing. IR-08 remains **In progress**.

The independent `axterm-configuration` v1 exporter/importer also has a
source-level large-file round trip: 60 real Quick Commands yield an 8–16 MiB
portable file, and a fresh database previews and commits all commands and
eight steps per command. Its existing 16 MiB inspection rejection and the
new round trip exercise both sides of the final independent file path, but
do not replace packaged-platform, old-version or Vault-recovery evidence.

The current warnings, backup path and no-`vendor` macOS packages are useful
transition evidence, but they do not amount to a complete migration release.
The 2026-09-25 [D3 current Mac package record](evidence/IR08-MACOS-D3-LEGACY-LINK-IMPORT-EXPORT-2026-09-25.md)
adds a late old-format import failure with an existing Host/Vault secret,
byte-identical Vault files, zero partial database rows, successful repaired
retry and a package-produced secret-free legacy portable export. It accepts
only the bounded Mac engineering D3 cell. The subsequent
[D4 current Mac package record](evidence/IR08-MACOS-D4-REMOTE-SYNC-SAFETY-2026-09-25.md)
adds controlled old-WebDAV backup 503 and new-path PUT 412 failures,
no partial Axterm profile or changed Vault on failed backup, exact old remote
preservation, repaired retry, all four controlled HTTP providers and the
historical-source encrypted/plaintext WebDAV recovery. It closes W-08-01's
bounded Mac engineering scope, not the real old-public-installer, live-account,
Windows/native-Linux or public migration-release obligations.
The independent release matrix, updated 2026-09-23 and rechecked against
`INDEPENDENT_RELEASE_MATRIX.md` on 2026-09-24, remains at 2 Accepted / 9 In
progress / 3 Open. This count is release-evidence status, not a percentage of
implementation work complete.
