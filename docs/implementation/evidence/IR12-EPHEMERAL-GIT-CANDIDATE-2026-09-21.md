# IR-12 ephemeral Git-candidate check — 2026-09-21

Status: passed local reproducibility evidence; **not** a new-repository or
release sign-off

## Scope

This record tests the current working-tree source snapshot without copying its
existing Git metadata. It deliberately creates an ephemeral local Git
repository, makes one synthetic commit, and clones it into a second temporary
directory. It does not create a GitHub repository, add a remote, push a commit,
change the current checkout, or authorize deletion of the historical repository.

The snapshot was prepared before this evidence record was added. Its independent
audit reported 699 files, 23,142,755 bytes and source-tree SHA-256
`6a4f342c8215dc0dff9947a23d9ad0d25699358c1433fba27790443296829587`, with no
forbidden paths, environment files, symbolic links or retired direct dependency
markers.

## Procedure and result

1. `prepare-independent-snapshot.mjs --check --keep` copied the current source
   while excluding Git/submodule metadata, `vendor`, installed dependencies,
   build/test output, non-example environment files and operating-system
   metadata.
2. The temporary source directory was initialized with `git init
--initial-branch main`; `git add -A` and one synthetic local commit produced
   exactly 699 tracked files (`e1c542488c92721f5b3e7e89ed7419b91261cc97`).
3. `git clone --no-local` produced a separate checkout. Its initial
   `git status --porcelain=v1` and `git submodule status` produced no output.
4. In the clone, `bun install --frozen-lockfile` rebuilt the macOS arm64 native
   `node-pty` module and completed successfully. The full `bun run check` then
   passed: 201 test files passed and one skipped (881 tests passed and one
   skipped), the 367-module/1,308-dependency Level 1 architecture gate, 267
   Contract operations, source legal/SBOM/asset/localization/migration-boundary
   gates, production build/layout, and five Axterm visual/accessibility flows.

## Metadata-hardening result

The first exploratory candidate uncovered a real preparation mismatch: three
macOS Finder `.DS_Store` files passed the source-copy audit but were ignored by
Git, so its audited-file count exceeded its commit-file count. The snapshot
preparer now excludes `.DS_Store`, `Thumbs.db` and `desktop.ini`; the audit
rejects any of those files if they arrive in a candidate snapshot. Unit tests
cover both behavior paths. The corrected 699-file audit count matches the
synthetic commit and clone above.

## Limits

The synthetic commit is only a reproducibility probe of an uncommitted local
source snapshot. It does not prove a final owner-created repository, a remote
CI result, three-platform installed artifacts, signing/notarization, updater
operation, source/brand/license clearance, a public migration window, or final
compatibility removal. IR-12 remains **In progress**; IR-13 and IR-14 remain
**Open** until their independent acceptance evidence exists.

## Post-candidate release-content hardening

This candidate was produced before the source snapshot enforced the later
5 MiB file limit. Its 699 tracked files included the generated 8.4 MiB
`docs/api/openapi.json`, so this evidence must not be treated as a final
new-repository candidate. The current source ignores that on-demand OpenAPI
artifact and makes generated-client checking independent of it; the snapshot
audit also rejects high-confidence complete PEM private-key and common token
formats without printing any value. A fresh candidate, clean checkout and full
evidence run are required after this control change.

## Post-large-artifact/secret-control replacement candidate

The required fresh candidate was created after the large-artifact and
high-confidence-secret controls above. Its prepared source snapshot reported
699 files, 15,139,997 bytes and tree SHA-256
`2febd8e9b2b3ea47da0c0da00dd232feab5baf76a463f86bead0ebfe17284248`, with no
forbidden entries, environment files, oversized files, symbolic links,
high-confidence secret findings or retired dependency markers.

1. A new local-only temporary Git root commit
   `010591d392883a297c9032a407a297900e4857d2` tracked exactly 699 files.
2. A separate `git clone --no-local` had empty `git status --porcelain=v1`, no
   submodule status, exactly 699 tracked files, no tracked
   `docs/api/openapi.json`, and the copied `.gitignore` ignored that generated
   path under a no-index check.
3. In the clone, `bun install --frozen-lockfile` rebuilt macOS arm64
   `node-pty` successfully. The full `bun run check` passed: 201 test files
   passed and one skipped; 881 tests passed and one skipped; the 367-module /
   1,308-dependency Level 1 architecture gate; 267 Contract operations; source
   component/license/SBOM/asset/localization/migration-boundary gates; the
   high-confidence secret/oversized-file snapshot gate; production build and
   five Axterm visual/accessibility journeys. The clone stayed clean after the
   check.

The subsequent transient-trace/HAR guard is covered by its focused unit test
and the normal source `bun run check`; this retained local clone predates that
last guard and is not presented as the final candidate after it. The temporary
paths were not made into a GitHub repository or pushed to any remote. This is
current local IR-12 reproducibility evidence only. It does not approve source
rights, trademarks, migration completion, signed installers, Windows/Linux
artifacts, remote CI, or the owner action required for IR-14.

## Current all-control candidate

On 2026-09-21, a new ephemeral candidate was produced after all current
snapshot controls, including the `.DS_Store`/OS-metadata, over-5-MiB,
high-confidence-secret, trace/HAR and generated-OpenAPI guards. Its prepared
source snapshot reported 702 files, 15,168,151 bytes and source-tree SHA-256
`bf5b0b919c4a82e4fe3b70b59ade41d799a37b24df6b7dca7c28a9a1d3bb0808`. Every
violation category was empty.

1. A local-only temporary Git root commit
   `667160341cd7e0443a94689f25f0a06a0d8240f4` tracked exactly 702 files.
2. A separate `git clone --no-local` had exactly 702 tracked files, empty
   `git status --porcelain=v1`, no submodule entries, and no tracked
   `docs/api/openapi.json`; its copied `.gitignore` ignored that generated
   path under a no-index check.
3. In that clone, `bun install --frozen-lockfile` rebuilt macOS arm64
   `node-pty` and the full `bun run check` passed: 202 test files passed and
   one skipped, with 883 tests passed and one skipped; the 367-module /
   1,308-dependency Level 1 architecture gate; 267 Contract operations;
   component/license/SBOM/asset/localization/migration-boundary and snapshot
   checks; production build/layout; and five Axterm visual/accessibility
   journeys. The clone remained clean after the check.

This supersedes the prior local candidates as the strongest current
reproducibility probe. It is still neither an owner-created remote repository
nor remote-CI, source-rights, signed-installation, public-migration or
three-platform evidence. It therefore leaves IR-12 **In progress**, IR-13
**Open** and IR-14 **Open**.

## P-06 release-record replacement candidate

On 2026-09-21, a further local-only candidate was created after the migration
release-record controls, its documentation entry points and their stricter
future-date/stable-release checks were added. The evidence document itself was
written after this candidate, so this section identifies the exact pre-evidence
source snapshot rather than claiming that a later documentation edit was in the
clone.

The prepared source snapshot contained 709 files, 15,221,711 bytes and
source-tree SHA-256
`ea1b7437db0199e99a3d2fd62e7b119efe73e01cdbdc906c0bf2bf4c373cf14c`.
Every snapshot audit category was empty: forbidden paths, environment files,
oversized files, symbolic links, transient traces/HAR, prohibited generated
OpenAPI, high-confidence secrets and retired direct dependency markers.

1. A temporary local root commit `a39d51e93846732182e6bc8d2a03e3abb0bbc389`
   tracked exactly 709 files.
2. A separate `git clone --no-local` had no `.gitmodules`, no submodule output,
   no tracked `docs/api/openapi.json`, and an empty initial porcelain status.
   The copied `.gitignore` continued to ignore the generated OpenAPI path.
3. `bun install --frozen-lockfile` succeeded in that separate clone and rebuilt
   macOS arm64 `node-pty`. The clone's full `bun run check` then passed: 204
   test files passed with one skipped (890 tests passed with one skipped), the
   367-module/1,308-dependency Level 1 architecture gate, 267 Contract
   operations, source component/license/SBOM/asset/localization/migration/
   snapshot checks, production build/layout and five Axterm visual/accessibility
   journeys. Its final porcelain status and `git diff --check` were empty.

The 860 MiB temporary source-and-clone directory was moved recoverably to
`/Users/h/.Trash/axterm-independent-snapshot-9xxVyR-20260921-p06-record`
after the check; it was not pushed or made available as a remote repository.
This is the strongest current local reproducibility probe, but still does not
prove a final owner-created remote repository/CI, source-rights or brand review,
signed installers, Windows/Linux installed applications, public migration, or
final compatibility removal. IR-12 remains **In progress**; IR-13 and IR-14
remain **Open**.

## Historical P-03 FTP interoperability and release-service candidate

On 2026-09-21, a further local-only candidate was prepared after the P-03
independent system-`curl` FTP interoperability coverage and the pending
P-08 public privacy/security/support release-service controls were added. This
evidence was written after the candidate was verified, so the figures below
identify its exact pre-evidence source snapshot; they do not imply that this
later evidence edit is part of the candidate.

The prepared source snapshot contained 716 files, 15,257,893 bytes and
source-tree SHA-256
`8f92a9636fcea5e9547fc7fecf0ec335245cacf2f93239993ea16994b2b4ed5b`.
Every snapshot-audit category was empty: forbidden paths, environment files,
oversized files, symbolic links, transient traces/HAR, prohibited generated
OpenAPI, high-confidence secrets and retired direct dependency markers.

1. A temporary local root commit `f0067ec8ab03d2578a091ba60ed528b05cf892d7`
   tracked exactly 716 files.
2. A distinct `git clone --no-local` had the same commit and tracked-file count,
   no `.gitmodules`, no submodule output, no tracked `docs/api/openapi.json`,
   and an empty porcelain status. Its copied ignore rule continued to ignore the
   generated OpenAPI path.
3. `bun install --frozen-lockfile` succeeded in the clone and rebuilt macOS
   arm64 `node-pty`. Its complete `bun run check` exited 0, covering lint,
   type checking, tests, the 367-module/1,308-dependency Level 1 architecture
   gate, 267 Contract operations, component/license/SBOM/asset/migration/
   release-service/localization/snapshot checks, production build/layout and
   the five Axterm visual/accessibility journeys. Final porcelain status,
   unstaged diff and staged diff were empty.

The 860 MiB temporary source-and-clone directory was moved recoverably to
`/Users/h/.Trash/axterm-independent-snapshot-HPEAfI-20260921-p03-ftp-service`
after verification; it was not pushed or made available as a remote repository.
This is retained historical local reproducibility evidence, but it does not
prove a final owner-created repository or remote CI, source-rights/brand
approval, signed installers, Windows/Linux installed applications,
authenticated updater, public migration, or final compatibility removal. IR-12
remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current node-pty notice and final-removal-gate candidate

On 2026-09-22, a new local-only candidate was produced after the `node-pty`
third-party-patch notice was made explicit and the removal-release record was
mechanically paired with the final public-source audit. This evidence file was
written after the candidate completed, so the following figures identify the
exact pre-evidence source snapshot rather than claiming this later record was
in the clone.

The prepared source snapshot contained 739 files, 16,049,099 bytes and
source-tree SHA-256
`a275675e8a6c2efb301c0cefb74963d39af80983a8a3b0e405a1d5ea2c9a1ce6`.
Every normal snapshot-audit category was empty: forbidden paths, environment
files, oversized files, symbolic links, transient traces/HAR, generated
OpenAPI, high-confidence secrets and retired direct dependency markers.

1. A temporary local root commit `58e77b2f0b63723776f4a97a07f49b16307f9213`
   tracked exactly 739 files.
2. A separate `git clone --no-local` tracked the same 739 files, had empty
   porcelain status and no submodule output, and contained no `.gitmodules`,
   `vendor/legacy-prototype` or tracked `docs/api/openapi.json`.
3. `bun install --frozen-lockfile` succeeded in the clone and rebuilt macOS
   arm64 `node-pty`. Its complete `bun run check` exited 0: 213 test files
   passed with five conditional skips (915 passing tests and 29 skips), the
   368-module/1,313-dependency Level 1 architecture gate, 267 Contract
   operations, component/license/SBOM/asset/migration/release-service/
   localization/snapshot checks, production build/layout and six Axterm
   visual/accessibility journeys. Final porcelain and both diff checks were
   empty.

The new `release:final-public:check` is intentionally not part of this
migration-period candidate: its first step correctly rejects the current
pending `MIGRATION_RELEASE_RECORD.json`, before a final legacy-name scan could
be misrepresented as removal approval. The candidate's temporary directory was
removed automatically; it created no remote, GitHub repository or release
artifact. This is current local reproducibility evidence only, not a public
migration, final compatibility removal, source-rights/brand conclusion,
signed installer, remote CI, Windows/Linux installed-app result or IR-12/
IR-13/IR-14 acceptance.

## Historical P-03 Linux arm64 source-runtime and P-07 migration-baseline candidate

On 2026-09-21, a fresh local-only candidate was prepared after the P-03 Linux
arm64 containerized FTP source-runtime smoke and the P-07 migration-notice
visual-baseline refresh. This evidence is written after the candidate was
verified, so the figures below identify an exact pre-evidence source snapshot;
they do not imply that later ledger and evidence edits were in the clone.

The prepared source snapshot contained 721 files, 15,276,326 bytes and
source-tree SHA-256
`cef7f8b8e858118900c5bcb8ad42afb7cbf268793650dce29dde14eea537f80e`.
Every snapshot-audit category was empty: forbidden paths, environment files,
oversized files, symbolic links, transient traces/HAR, prohibited generated
OpenAPI, high-confidence secrets and retired direct dependency markers.

1. A temporary local root commit `4bf0f74d73f6226a2447f1c2a96bfb5f52b8980d`
   tracked exactly 721 files.
2. A separate `git clone --no-local` had that same commit and tracked-file
   count, no `.gitmodules`, no submodule output, no tracked
   `docs/api/openapi.json`, and an empty porcelain status. Its copied
   `.gitignore` ignored the generated OpenAPI path under a no-index check.
3. `bun install --frozen-lockfile` succeeded in the clone and rebuilt macOS
   arm64 `node-pty`. Its complete `bun run check` exited 0: 206 test files
   passed and one skipped (894 tests passed and one skipped); the 367-module /
   1,308-dependency Level 1 architecture gate; 267 Contract operations;
   component/license/SBOM/asset/migration/release-service/localization/snapshot
   checks; production build/layout; and five Axterm visual/accessibility
   journeys. Final porcelain status, unstaged diff check and staged diff check
   were empty.

The 874 MB temporary source-and-clone directory was moved recoverably to
`/Users/h/.Trash/axterm-independent-snapshot-gIFYbq-20260921-linux-ftp-baseline`
after verification. It was not pushed, made into a remote repository, or used
to change the current checkout. The candidate establishes retained historical
local reproducibility for the tested source snapshot; it is not Linux x64
packaging or installation evidence, remote CI, source/brand rights approval,
signed installers, authenticated updater, public migration or final
compatibility removal. IR-12 remains **In progress**; IR-13 and IR-14 remain
**Open**.

## Current P-02 TRZSZ completed-session lifecycle candidate

On 2026-09-22, `bun run candidate:check` was rerun after the completed-session
TRZSZ lifecycle correction. A `TrzszManager` retains its completed object for a
later transfer marker on the same terminal, so the implementation now clears
closed upload readers, published download writers and collision-name state only
after its per-transfer cleanup. The new source regression drives two successive
real `trzsz2` handshakes through one session in both directions. The download
case requires two distinct published binary files and no staged `.part` files;
the upload case ensures that its second peer receives only the second selected
file. This record was written after the command, so its figures identify the
exact pre-evidence source state.

The prepared source snapshot contained 739 files, 16,061,536 bytes and
source-tree SHA-256
`c930c5414bce532c058f79998c62e0dd9e18ec66f3a26573acc304de4aba40e9`.
All normal snapshot-audit categories were empty: forbidden entries, environment
files, oversized files, symbolic links, transient artifacts, prohibited
generated files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `e47440f83ee4b510e148a9460cc4a216fdedc6b2` tracked exactly 739 files.
2. Its distinct `git clone --no-local` tracked the same 739 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 213 test files passed with five explicit skipped
   files (917 tests passed with twenty-nine explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus six Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set any external-peer
environment flag, so it has no Docker, network or downloaded-binary
prerequisite. This is local reproducibility and source-level session-lifecycle
evidence only. It does not prove external-peer interoperability, an independent
SSH host, alternate filesystem behavior, source/rights review, installed
cross-platform products, public migration, remote CI, signing/notarization,
an authenticated updater or final compatibility removal. IR-12 remains **In
progress**; IR-13 and IR-14 remain **Open**.

## Historical P-03 Linux arm64/x64 source-runtime candidate

On 2026-09-21, a fresh local-only candidate was prepared after the P-03 Linux
FTP source smoke was made architecture-explicit and successfully run in both
Linux arm64 and Linux x64 containers. This evidence is written after the
candidate was verified, so the figures below identify an exact pre-evidence
source snapshot; they do not imply that later IR-12 ledger edits were in the
clone.

The prepared source snapshot contained 721 files, 15,283,323 bytes and
source-tree SHA-256
`c135f2ee796077d1076aa0033c82074055bd4e15baec838c794642d6278a6257`.
Every snapshot-audit category was empty: forbidden paths, environment files,
oversized files, symbolic links, transient traces/HAR, prohibited generated
OpenAPI, high-confidence secrets and retired direct dependency markers.

1. A temporary local root commit `4bf5f2750b5ccbbd2d1418f160694cc8d7783ce2`
   tracked exactly 721 files.
2. A separate `git clone --no-local` had that same commit and tracked-file
   count, no `.gitmodules`, no submodule output, no tracked
   `docs/api/openapi.json`, and an empty porcelain status. Its copied
   `.gitignore` ignored the generated OpenAPI path under a no-index check.
3. `bun install --frozen-lockfile` succeeded in the clone and rebuilt macOS
   arm64 `node-pty`. Its complete `bun run check` exited 0: 206 test files
   passed and one skipped (894 tests passed and one skipped); the 367-module /
   1,308-dependency Level 1 architecture gate; 267 Contract operations;
   component/license/SBOM/asset/migration/release-service/localization/snapshot
   checks; production build/layout; and five Axterm visual/accessibility
   journeys. Final porcelain status, unstaged diff check and staged diff check
   were empty.

The 902 MB temporary source-and-clone directory was moved recoverably to
`/Users/h/.Trash/axterm-independent-snapshot-Z4EToc-20260921-linux-multiarch-ftp`
after verification. It was not pushed, made into a remote repository, or used
to change the current checkout. The candidate establishes retained historical
local reproducibility for the tested source snapshot; it is not Linux x64
Electron packaging or installation evidence, remote CI, source/brand rights
approval, signed installers, authenticated updater, public migration or final
compatibility removal. IR-12 remains **In progress**; IR-13 and IR-14 remain
**Open**.

## P-03 image-pinned Linux arm64/x64 and IR-03 peer-boundary candidate

On 2026-09-21, a fresh local-only candidate was prepared after the Linux FTP
source smoke pinned its official multi-architecture Bun image by digest and the
P-02 external-peer availability record gained its bounded container-discovery
evidence. This evidence is written after the candidate was verified, so the
figures below identify an exact pre-evidence source snapshot; they do not imply
that later IR-12 ledger edits were in the clone.

The prepared source snapshot contained 721 files, 15,291,010 bytes and
source-tree SHA-256
`aaebfcd1b272873b20895ff5f3c4a46a3e8f7e19a675b97c38e0b517649750ab`.
Every snapshot-audit category was empty: forbidden paths, environment files,
oversized files, symbolic links, transient traces/HAR, prohibited generated
OpenAPI, high-confidence secrets and retired direct dependency markers.

1. A temporary local root commit `2b5d622ec204dbdbe6fb01fee8ea02402958769e`
   tracked exactly 721 files.
2. A separate `git clone --no-local` had that same commit and tracked-file
   count, no `.gitmodules`, no submodule output, no tracked
   `docs/api/openapi.json`, and an empty porcelain status. Its copied
   `.gitignore` ignored the generated OpenAPI path under a no-index check.
3. `bun install --frozen-lockfile` succeeded in the clone and rebuilt macOS
   arm64 `node-pty`. Its complete `bun run check` exited 0: 206 test files
   passed and one skipped (894 tests passed and one skipped); the 367-module /
   1,308-dependency Level 1 architecture gate; 267 Contract operations;
   component/license/SBOM/asset/migration/release-service/localization/snapshot
   checks; production build/layout; and five Axterm visual/accessibility
   journeys. Final porcelain status, unstaged diff check and staged diff check
   were empty.

The 902 MB temporary source-and-clone directory was moved recoverably to
`/Users/h/.Trash/axterm-independent-snapshot-IniX5i-20260921-pinned-linux-ftp-peer-boundary`
after verification. It was not pushed, made into a remote repository, or used
to change the current checkout. The candidate establishes local reproducibility
for the tested source snapshot; it is not Linux x64 Electron packaging or
installation evidence, remote CI, source/brand rights approval, signed
installers, authenticated updater, public migration or final compatibility
removal. IR-12 remains **In progress**; IR-13 and IR-14 remain **Open**.

## P-04 four-language and P-06 Gitee-provider candidate

On 2026-09-21, a fresh local-only candidate was prepared after the supported
language catalog was reduced to English, Japanese, Simplified Chinese and
Traditional Chinese, and the P-06 provider suite gained a separate
Axterm-format Gitee request assertion. This evidence is written after the
candidate was verified, so the figures below identify its exact pre-evidence
source snapshot; the later evidence update is not claimed to have been in that
clone.

The prepared source snapshot contained 724 files, 15,214,618 bytes and
source-tree SHA-256
`5adf3d150623bf1dd98d77d302335d16014270e807767d0df270a16d8022731c`.
Every snapshot-audit category was empty: forbidden paths, environment files,
oversized files, symbolic links, transient traces/HAR, prohibited generated
OpenAPI, high-confidence secrets and retired direct dependency markers.

1. A temporary local root commit `0a766dfa81898f14feeecb6ad8cda0486989192c`
   tracked exactly 724 files.
2. A separate `git clone --no-local` had the same commit and tracked-file
   count; it had no `.gitmodules`, no `vendor/legacy-prototype`, no tracked generated
   OpenAPI document, and an empty porcelain status before and after checking.
3. `bun install --frozen-lockfile` succeeded in the clone and rebuilt macOS
   arm64 `node-pty`. Its complete `bun run check` exited 0: 208 test files
   passed and one skipped (896 tests passed and one skipped); the Level 1
   architecture gate checked 367 modules / 1,308 dependencies; Contract drift
   checked 267 operations; component/license/SBOM/asset/migration/
   release-service/localization/snapshot checks passed; the core locale ledger
   verified 2,543 keys with English fallback for Japanese and Traditional
   Chinese; and the production build/layout plus five Axterm
   visual/accessibility journeys passed. Final porcelain status, unstaged diff
   check and staged diff check were empty.

The temporary source-and-clone directory was moved recoverably to
`/Users/h/.Trash/axterm-independent-snapshot-cIxsYX-20260921-p04-language-p06-gitee`
after verification. It was not pushed, made into a remote repository or used
to change the current checkout. This is current local reproducibility evidence,
not remote CI, source-rights or brand review, signed installation,
authenticated updater, Windows/Linux installed applications, a public
migration release or final compatibility removal. IR-12 remains **In progress**;
IR-13 and IR-14 remain **Open**.

## Automated P-04 global-Shell candidate

On 2026-09-21, the manual local candidate procedure was made reproducible as
`bun run candidate:check`. The command prepares and audits a source-only
snapshot, creates a synthetic local Git root only inside that temporary
directory, makes a non-local clone, installs frozen dependencies there, runs
the complete quality gate, confirms that clone is still clean, and removes its
own temporary directory on success or failure. It neither reads the current
checkout's Git metadata nor creates or contacts a remote.

This evidence is written after the successful command, so it records the
exact pre-evidence source snapshot rather than asserting that this later
documentation change was in the candidate. After P-04 expanded the Japanese
and Traditional-Chinese core drafts to 1,652 keys each, including
terminal-workspace, behavior-settings, profile, the complete
hosts/SSH-bookmark and protocol-bookmark editor workflows, the sync-service
workflow, the Axterm-owned configuration-snapshot workflow, the SSH Config
import workflow, the batch SSH operation workflow, the trigger editor workflow
and the complete terminal-theme workflow, activity-rail ordering/fixed-tool
availability, all Widget configuration, file-renaming preview/confirmation and
desktop window preferences/restart guidance, remote-desktop connection, display
and security feedback, connection-history recording, reconnection, bookmark,
credential and recovery feedback, and the complete file-manager transfer,
FTP-capability, permission, drag-and-drop, remote-copy, primary-action,
local/remote-browsing, queue/conflict-handling and path-validation surface, and
the complete global Shell status/recovery/deep-link/connection-lifecycle/
workspace/tab-action/Runtime/AI-context/transfer-center surface, that snapshot
contained 729 files, 15,586,052 bytes and
source-tree SHA-256
`395b6e5afa45a9d3ede561a00730cfc5bc7fb0c495d0199b7a44f1301f8e4ba2`.
All independent-snapshot report categories were empty, including forbidden
entries, environment files, oversized files, symbolic links, transient
artifacts, prohibited generated files, high-confidence secrets and prohibited
dependency markers.

1. The disposable local root commit
   `7f6209df5c818b0f06226c8052a840296d07726f` tracked exactly 729 files.
2. Its separate `git clone --no-local` had the same commit and file count, an
   empty porcelain status before and after the full gate, an empty staged and
   unstaged whitespace diff, no `.gitmodules`, no submodule status, no
   `vendor/legacy-prototype`, and no generated `docs/api/openapi.json`.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's full
   `bun run check` passed: 211 test files passed and one skipped (902 tests
   passed and one skipped); the Level 1 gate covered 367 modules and 1,308
   dependencies; Contract drift checked 267 operations; source
   commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; the core locale
   ledger checked 2,543 keys; production build/layout and five Axterm
   visual/accessibility journeys passed.

The first invocation after adding the automation was correctly rejected by the
transition-boundary gate: the new checker contains the exact retired path name
only to reject it inside its disposable clone, but had not yet been declared as
a negative guard. The 30-file transition ledger now identifies that limited
role; the focused boundary and candidate tests passed before the successful
run above. This fix does not add a product compatibility feature or start the
public migration clock.

This was the strongest local IR-12 reproducibility evidence for its exact
pre-evidence snapshot, but it is
not a final owner-created remote repository or remote CI result. It also does
not establish source/brand rights clearance, signed or notarized installers,
Windows/Linux installed application results, an authenticated update service,
a public migration release, or final removal of compatibility features.
IR-12 remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-04 AI-workspace candidate

On 2026-09-22, `bun run candidate:check` was rerun after adding the complete
91-key AI workspace surface to the independently drafted Japanese and
Traditional-Chinese partial catalogs. This record was written after the run, so
the figures identify the exact pre-evidence snapshot and do not assert that this
later evidence text was in the candidate.

The prepared source snapshot contained 729 files, 15,598,384 bytes and
source-tree SHA-256
`66dc019b4540f82dfb98850b0bdedbe5880b3165f94a7258fd00f7d05c54bb96`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `4c843f9379faf717d12711f8ee9c21b8775970d0` tracked exactly 729 files.
2. Its distinct `git clone --no-local` tracked the same 729 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   porcelain status and both staged and unstaged whitespace checks were empty
   before and after the full gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed and one skipped (902 tests
   passed and one skipped); the Level 1 gate covered 367 modules and 1,308
   dependencies; Contract drift checked 267 operations; source
   commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; the core locale ledger
   checked 2,543 keys; and production build/layout plus five Axterm
   visual/accessibility journeys passed.

The candidate included 1,743 Japanese and 1,743 Traditional-Chinese AI-assisted
drafts. The additional 91 keys cover AI provider configuration, conversation and
attachment controls, bounded/redacted context, generated-command review with an
explicit Enter-to-run boundary, tool activity, risk labels and approval states.
This is local reproducibility evidence for an unreviewed draft catalog only. It
does not establish language quality or source/rights clearance, a public
migration release, remote CI, signing/notarization, installed Windows/Linux
applications, an authenticated updater or final compatibility removal. IR-12
remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-04 AI-bookmark, host-key and tunnel candidate

On 2026-09-22, `bun run candidate:check` was rerun after adding the remaining
74 independently drafted Japanese and Traditional-Chinese messages for AI SSH
bookmarking, known host keys and SSH tunnels. This evidence was recorded after
the run, so the figures describe its exact pre-evidence source snapshot.

The prepared source snapshot contained 729 files, 15,616,819 bytes and
source-tree SHA-256
`caa0dba795d657738ab105962a636c5f7bd2e704e7a4139195dae74147b2feb4`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `a3c847a4ebb321df46453ef254da39540ea34908` tracked exactly 729 files.
2. Its distinct `git clone --no-local` tracked the same 729 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   porcelain status and both staged and unstaged whitespace checks were empty
   before and after the full gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed and one skipped (902 tests
   passed and one skipped); the Level 1 gate covered 367 modules and 1,308
   dependencies; Contract drift checked 267 operations; source
   commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; the core locale ledger
   checked 2,543 keys; and production build/layout plus five Axterm
   visual/accessibility journeys passed.

The candidate included 1,817 Japanese and 1,817 Traditional-Chinese AI-assisted
drafts. Bookmark copy excludes passwords, private keys, passphrases, API keys
and tokens, requires review before saving, and says credentials are neither
generated nor saved there. Host-key revocation retains the next-connection
fingerprint recheck. Tunnel copy keeps the non-loopback binding choice explicit.
This is local reproducibility evidence for unreviewed draft content only; it is
not language quality or source/rights clearance, a public migration release,
remote CI, signing/notarization, installed Windows/Linux validation, an
authenticated updater or final compatibility removal. IR-12 remains **In
progress**; IR-13 and IR-14 remain **Open**.

## Historical P-02 selected-transfer peer-exit candidate

On 2026-09-22, `bun run candidate:check` was rerun after the external ZMODEM
SSH-PTY suite gained its selected-transfer peer-exit cleanup regression. This
record was written after the command, so its figures identify the exact
pre-evidence source state.

The prepared source snapshot contained 735 files, 15,975,600 bytes and
source-tree SHA-256
`2189b0657b06a524baf1a062f6dc34a39f83ab9000219a8613f552b1954538f7`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `2e0856496430c296b73f7d473c180cef1cf53a76` tracked exactly 735 files.
2. Its distinct `git clone --no-local` tracked the same 735 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 212 test files passed with five explicit skipped
   files (906 tests passed with twenty-seven explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus five Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set any external-peer
environment flag, so it has no Docker, network or downloaded-binary
prerequisite. Separately recorded opt-in runs passed twelve hash-pinned Debian
`lrzsz` SSH-PTY tests and five hash-pinned official `trzsz-go` tests for each
fixed `linux/arm64` and `linux/amd64` peer. The added ZMODEM case first selects
a real destination, waits for the external `sz` file offer, then terminates the
SSH fixture and external peer. The resulting terminal channel exit destroys the
product session and removes staged output without publishing a destination
file. This candidate is local reproducibility and controlled-fixture evidence
only. It does not cover malformed-frame or partial-file failure after
selection, XMODEM/TRZSZ post-selection failure, an independently operated SSH
host, host-key approval, installed cross-platform products, source/rights,
public migration, remote CI, signing/notarization, authenticated updater or
final compatibility removal. IR-12 remains **In progress**; IR-13 and IR-14
remain **Open**.

## Current P-04 productivity, approval and host-key candidate

On 2026-09-22, `bun run candidate:check` was rerun after adding all 45
independently drafted Japanese and Traditional-Chinese productivity-panel,
AI-Inspector, approval-card and changed-host-key confirmation messages. This
record was written after the run, so the figures describe the exact
pre-evidence source snapshot.

The prepared source snapshot contained 729 files, 15,644,821 bytes and
source-tree SHA-256
`e5156965481fc6bc2ddd0df9057d97df74eae3b7e0968df2e1fa86cde91db83d`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `17f176ef948e52d439d935311c3adefca0f9fdcb` tracked exactly 729 files.
2. Its distinct `git clone --no-local` tracked the same 729 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   porcelain status and both staged and unstaged whitespace checks were empty
   before and after the full gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed and one skipped (902 tests
   passed and one skipped); the Level 1 gate covered 367 modules and 1,308
   dependencies; Contract drift checked 267 operations; source
   commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; the core locale ledger
   checked 2,543 keys; and production build/layout plus five Axterm
   visual/accessibility journeys passed.

The candidate included 1,925 Japanese and 1,925 Traditional-Chinese AI-assisted
drafts. It preserves bounded/redacted AI context, an approval card distinct from
silent command execution, argument-hash/expiry labels and explicit confirmation
before replacing a changed host key. This is local reproducibility evidence for
unreviewed draft content only; it is not language quality or source/rights
clearance, a public migration release, remote CI, signing/notarization,
installed Windows/Linux validation, an authenticated updater or final
compatibility removal. IR-12 remains **In progress**; IR-13 and IR-14 remain
**Open**.

## Current P-04 quick-command candidate

On 2026-09-22, `bun run candidate:check` was rerun after adding all 63
independently drafted Japanese and Traditional-Chinese quick-command library and
multi-step command-editor messages. This record was written after the run, so
the figures describe the exact pre-evidence source snapshot.

The prepared source snapshot contained 729 files, 15,632,730 bytes and
source-tree SHA-256
`8617ada196217dc6b96ea1988b9296a3b391ee72c32453076865d60a21fd4440`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `5b545f8b2680f521496549b7928558b9bfe7e455` tracked exactly 729 files.
2. Its distinct `git clone --no-local` tracked the same 729 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   porcelain status and both staged and unstaged whitespace checks were empty
   before and after the full gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed and one skipped (902 tests
   passed and one skipped); the Level 1 gate covered 367 modules and 1,308
   dependencies; Contract drift checked 267 operations; source
   commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; the core locale ledger
   checked 2,543 keys; and production build/layout plus five Axterm
   visual/accessibility journeys passed.

The candidate included 1,880 Japanese and 1,880 Traditional-Chinese AI-assisted
drafts. Quick-command text preserves `{{clipboard}}`, says an inserted command
requires Enter to run, distinguishes explicit send-and-run behavior, and states
that a multi-step insertion generates multiline text without automatic
execution. This is local reproducibility evidence for unreviewed draft content
only; it is not language quality or source/rights clearance, a public migration
release, remote CI, signing/notarization, installed Windows/Linux validation,
an authenticated updater or final compatibility removal. IR-12 remains **In
progress**; IR-13 and IR-14 remain **Open**.

## Current P-04 credential and proxy candidate

On 2026-09-22, `bun run candidate:check` was rerun after adding all 50
independently drafted Japanese and Traditional-Chinese saved-credential and
SSH-proxy configuration messages. This record was written after the run, so the
figures describe the exact pre-evidence source snapshot.

The prepared source snapshot contained 729 files, 15,659,621 bytes and
source-tree SHA-256
`da9787de6da678c5ac6db3a205f51d25207d9103dec60d9d90d030c200c77ed1`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `b233ae71d796157de63f1d389e971f7e275f1570` tracked exactly 729 files.
2. Its distinct `git clone --no-local` tracked the same 729 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   porcelain status and both staged and unstaged whitespace checks were empty
   before and after the full gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed and one skipped (902 tests
   passed and one skipped); the Level 1 gate covered 367 modules and 1,308
   dependencies; Contract drift checked 267 operations; source
   commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; the core locale ledger
   checked 2,543 keys; and production build/layout plus five Axterm
   visual/accessibility journeys passed.

The candidate included 1,975 Japanese and 1,975 Traditional-Chinese AI-assisted
drafts. Credential and proxy copy keeps secret values out of display, preserves
the application-local Vault-only boundary, limits a supplied test password to
that request, keeps proxy command arguments out of a shell, and keeps
per-bookmark proxy passwords out of the business database. This is local
reproducibility evidence for unreviewed draft content only; it is not language
quality or source/rights clearance, a public migration release, remote CI,
signing/notarization, installed Windows/Linux validation, an authenticated
updater or final compatibility removal. IR-12 remains **In progress**; IR-13
and IR-14 remain **Open**.

## Current P-04 terminal-recovery candidate

On 2026-09-22, `bun run candidate:check` was rerun after adding all 40
independently drafted Japanese and Traditional-Chinese terminal-interaction and
recovery-settings messages. This record was written after the run, so the
figures describe the exact pre-evidence source snapshot.

The prepared source snapshot contained 729 files, 15,713,791 bytes and
source-tree SHA-256
`670f4170fe90da655c7193414ef726f2c93d57f72c0e47a4d2f3e7f52bc7abe6`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `780a79bfc52de59607faf5cad2760751e6655faa` tracked exactly 729 files.
2. Its distinct `git clone --no-local` tracked the same 729 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   porcelain status and both staged and unstaged whitespace checks were empty
   before and after the full gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed and one skipped (902 tests
   passed and one skipped); the Level 1 gate covered 367 modules and 1,308
   dependencies; Contract drift checked 267 operations; source
   commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; the core locale ledger
   checked 2,543 keys; and production build/layout plus five Axterm
   visual/accessibility journeys passed.

The candidate included 2,168 Japanese and 2,168 Traditional-Chinese AI-assisted
drafts. Terminal-recovery copy retains the restriction that automatic reconnect
only follows an unexpected disconnection of an established SSH session, the
bounded in-memory reload-recovery scope, per-bookmark profile precedence,
file-drop choices and monitor-item ordering controls. It neither reconnects a
session that was never established nor persists a screen snapshot or authorizes
file upload. Separate source and copied unsigned macOS directory-package H-11
journeys reran the retained four-language switching and asserted the localized
terminal-recovery title and automatic-reconnect boundary in Japanese and
Traditional Chinese. This is local reproducibility evidence for unreviewed draft
content only; it is not language quality or source/rights clearance, a public
migration release, remote CI, signing/notarization, installed Windows/Linux
validation, an authenticated updater or final compatibility removal. IR-12
remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-04 keyboard-shortcut candidate

On 2026-09-22, `bun run candidate:check` was rerun after adding all 69
independently drafted Japanese and Traditional-Chinese keyboard-shortcut and
global-window-visibility messages. This record was written after the run, so the
figures describe the exact pre-evidence source snapshot.

The prepared source snapshot contained 729 files, 15,676,796 bytes and
source-tree SHA-256
`a8bc461920a28d917d3d4d50ac4f0bf5411d48e20858db285d62ca1a3729242a`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `f4bfd17bb882ce9aa0302782d6d4d146c3660d41` tracked exactly 729 files.
2. Its distinct `git clone --no-local` tracked the same 729 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   porcelain status and both staged and unstaged whitespace checks were empty
   before and after the full gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed and one skipped (902 tests
   passed and one skipped); the Level 1 gate covered 367 modules and 1,308
   dependencies; Contract drift checked 267 operations; source
   commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; the core locale ledger
   checked 2,543 keys; and production build/layout plus five Axterm
   visual/accessibility journeys passed.

The candidate included 2,044 Japanese and 2,044 Traditional-Chinese AI-assisted
drafts. Shortcut copy preserves physical-key capture, a two-bindings-per-action
limit, literal chord/action placeholders in conflict feedback, platform-default
restoration, and the disabled/registered/failed global-registration states. The
separate source and copied unsigned macOS directory-package H-11 journeys also
opened the localized shortcut panel and verified its title, physical-key hint and
action-registry table in Japanese and Traditional Chinese. This is local
reproducibility evidence for unreviewed draft content only; it is not language
quality or source/rights clearance, a public migration release, remote CI,
signing/notarization, installed Windows/Linux validation, an authenticated
updater or final compatibility removal. IR-12 remains **In progress**; IR-13
and IR-14 remain **Open**.

## Current P-04 observability candidate

On 2026-09-22, `bun run candidate:check` was rerun after adding all 84
independently drafted Japanese and Traditional-Chinese remote-monitor and
terminal-information messages. This record was written after the run, so the
figures describe the exact pre-evidence source snapshot.

The prepared source snapshot contained 729 files, 15,697,731 bytes and
source-tree SHA-256
`ffad1810857d54102b0383c46f0f4950bd8d38e3d71c287542a5d7b867a7ee62`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `20737e4de0aff42c6bfa212514bd4ac2833c55c0` tracked exactly 729 files.
2. Its distinct `git clone --no-local` tracked the same 729 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   porcelain status and both staged and unstaged whitespace checks were empty
   before and after the full gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed and one skipped (902 tests
   passed and one skipped); the Level 1 gate covered 367 modules and 1,308
   dependencies; Contract drift checked 267 operations; source
   commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; the core locale ledger
   checked 2,543 keys; and production build/layout plus five Axterm
   visual/accessibility journeys passed.

The candidate included 2,128 Japanese and 2,128 Traditional-Chinese AI-assisted
drafts. Observability copy preserves literal accessibility-summary placeholders,
CPU percentage and duration units, usage severity, disconnected/loading/
unavailable and unsupported/stale/live data states, and does not claim that a
session supplies monitoring data. The separate source and copied unsigned macOS
directory-package H-11 journeys also reran the retained four-language switching,
English cold-restart persistence, and localized shortcut-panel assertions. This
is local reproducibility evidence for unreviewed draft content only; it is not
language quality or source/rights clearance, a public migration release, remote
CI, signing/notarization, installed Windows/Linux validation, an authenticated
updater or final compatibility removal. IR-12 remains **In progress**; IR-13
and IR-14 remain **Open**.

## Current P-04 batch-input and command-line candidate

On 2026-09-22, `bun run candidate:check` was rerun after adding all 16
independently drafted Japanese and Traditional-Chinese batch-input messages and
all 16 command-line batch-operation messages. This record was written after the
run, so the figures describe the exact pre-evidence source snapshot.

The prepared source snapshot contained 729 files, 15,731,275 bytes and
source-tree SHA-256
`794abd69eb7038d8c65be9eda0362e2dd850e2b5ecef4029da7bde34c8c31ac7`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `611aa9a326a804abad9bb873937ac112144815c4` tracked exactly 729 files.
2. Its distinct `git clone --no-local` tracked the same 729 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   porcelain status and both staged and unstaged whitespace checks were empty
   before and after the full gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed and one skipped (902 tests
   passed and one skipped); the Level 1 gate covered 367 modules and 1,308
   dependencies; Contract drift checked 267 operations; source
   commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; the core locale ledger
   checked 2,543 keys; and production build/layout plus five Axterm
   visual/accessibility journeys passed.

The candidate included 2,200 Japanese and 2,200 Traditional-Chinese AI-assisted
drafts. Batch-input copy keeps the literal count and target placeholders and
explicit Enter-to-send/Shift+Enter-to-add-a-line behavior. Command-line
batch-operation copy retains the public migration-window limit for legacy
workflow arrays, its exact initial `connect`-step constraint, and the separate
file-grant requirement for command-line transfers. It neither extends the
migration window nor authorizes command execution or file transfer outside
those controls. Separate source and copied unsigned macOS directory-package
H-11 journeys reran the retained four-language switching and opened the
localized batch-input panel, asserting its description and command placeholder
in Japanese and Traditional Chinese. This is local reproducibility evidence for
unreviewed draft content only; it is not language quality or source/rights
clearance, a public migration release, remote CI, signing/notarization,
installed Windows/Linux validation, an authenticated updater or final
compatibility removal. IR-12 remains **In progress**; IR-13 and IR-14 remain
**Open**.

## Current P-04 bookmark-tree candidate

On 2026-09-22, `bun run candidate:check` was rerun after adding all 31
independently drafted Japanese and Traditional-Chinese bookmark-tree messages,
all six bookmark-group messages and all 12 bookmark-specific quick-command
messages. This record was written after the run, so the figures describe the
exact pre-evidence source snapshot.

The prepared source snapshot contained 729 files, 15,747,320 bytes and
source-tree SHA-256
`7b9d33c6928852b3d7bebd123d76fd26d6a7c4593db15eb683dbdd87417d89a0`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `e446cf0916665509f5c1b82dfbfdd7233fb749e3` tracked exactly 729 files.
2. Its distinct `git clone --no-local` tracked the same 729 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   porcelain status and both staged and unstaged whitespace checks were empty
   before and after the full gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed and one skipped (902 tests
   passed and one skipped); the Level 1 gate covered 367 modules and 1,308
   dependencies; Contract drift checked 267 operations; source
   commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; the core locale ledger
   checked 2,543 keys; and production build/layout plus five Axterm
   visual/accessibility journeys passed.

The candidate included 2,249 Japanese and 2,249 Traditional-Chinese AI-assisted
drafts. Bookmark copy retains literal title, count and color placeholders,
saved-bookmark search, per-bookmark command scope and its limits. It does not
claim a repaired display issue repairs source data, alter group structure, or
authorize inserting or executing a command. Separate source and copied unsigned
macOS directory-package H-11 journeys reran the retained four-language switching
and opened the localized bookmark-tree panel, asserting its region label and
search control in Japanese and Traditional Chinese. This is local
reproducibility evidence for unreviewed draft content only; it is not language
quality or source/rights clearance, a public migration release, remote CI,
signing/notarization, installed Windows/Linux validation, an authenticated
updater or final compatibility removal. IR-12 remains **In progress**; IR-13
and IR-14 remain **Open**.

## Current P-04 command-history and bookmark-trigger candidate

On 2026-09-22, `bun run candidate:check` was rerun after adding all 33
independently drafted Japanese and Traditional-Chinese command-history messages
and all 34 bookmark-trigger messages. This record was written after the run, so
the figures describe the exact pre-evidence source snapshot.

The prepared source snapshot contained 729 files, 15,774,854 bytes and
source-tree SHA-256
`36f8b910497067c9f4737d5d70437e32a806081f779a69e6c112f7d266eded39`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `c08a93e73e1709e1919b0bd73fffb671ea04b488` tracked exactly 729 files.
2. Its distinct `git clone --no-local` tracked the same 729 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   porcelain status and both staged and unstaged whitespace checks were empty
   before and after the full gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed and one skipped (902 tests
   passed and one skipped); the Level 1 gate covered 367 modules and 1,308
   dependencies; Contract drift checked 267 operations; source
   commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; the core locale ledger
   checked 2,543 keys; and production build/layout plus five Axterm
   visual/accessibility journeys passed.

The candidate included 2,386 Japanese and 2,386 Traditional-Chinese AI-assisted
drafts. Command-history copy retains its default-off state, only records safe
single-line commands explicitly submitted by compatible Shell Integration, and
requires Enter after insertion. Bookmark-trigger copy retains its restriction to
terminals opened from that bookmark, coexistence with global rules and Runtime
regular-expression safety revalidation. A fresh unsigned macOS arm64
`package:dir` H-11 journey separately passed immediate switching among the four
retained languages and cold-restart persistence; it did not open these two panels.
This is local reproducibility evidence for unreviewed draft content only; it is
not language quality or source/rights clearance, a public migration release,
remote CI, signing/notarization, installed Windows/Linux validation, an
authenticated updater or final compatibility removal. IR-12 remains **In
progress**; IR-13 and IR-14 remain **Open**.

## Current P-04 complete-core-draft candidate

On 2026-09-22, `bun run candidate:check` was rerun after the Japanese and
Traditional-Chinese core catalogs each reached complete 2,543-key AI-assisted
draft coverage. This record was written after the run, so the figures describe
the exact pre-evidence source snapshot.

The prepared source snapshot contained 729 files, 15,807,663 bytes and
source-tree SHA-256
`32534ce012e0146d55a3a62e03b40c973069c9cb56271be364d82f215e44f4d0`.
All snapshot-audit categories were empty, including forbidden entries,
environment files, oversized files, symbolic links, transient artifacts,
prohibited generated files, high-confidence secrets and dependency markers.

1. A disposable local root commit
   `e36bc833d8bd74bca566fb2f4949439cc4c8cc50` tracked exactly 729 files.
2. Its distinct `git clone --no-local` tracked the same 729 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed and one skipped (902 tests
   passed and one skipped); the Level 1 gate covered 367 modules and 1,308
   dependencies; Contract drift checked 267 operations; source
   commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; the core locale ledger
   checked 2,543 keys with no partial locale or English fallback; and production
   build/layout plus five Axterm visual/accessibility journeys passed.

A fresh unsigned macOS arm64 `package:dir` H-11 journey separately passed
immediate switching among the four retained languages and cold-restart
persistence. The complete Japanese and Traditional-Chinese catalogs are still
AI-assisted drafts with source attribution, language and rights review pending.
This is local reproducibility evidence only; it is not language quality or
source/rights clearance, a public migration release, remote CI,
signing/notarization, installed Windows/Linux validation, an authenticated
updater or final compatibility removal. IR-12 remains **In progress**; IR-13
and IR-14 remain **Open**.

## Current P-02 external-peer candidate

On 2026-09-22, `bun run candidate:check` was rerun after adding the opt-in,
hash-verified external `lrzsz` and `trzsz-go` Docker-PTY tests. This record was
written after the run, so its figures identify the exact pre-evidence snapshot.

The prepared source snapshot contained 731 files, 15,841,595 bytes and
source-tree SHA-256
`844806b85a35e47e92f7959adeb5828ea160c6698649b2b8a34c0b22b26c27b8`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `95baa599bfd5929a9d7d542fae0288123dde91f7` tracked exactly 731 files.
2. Its distinct `git clone --no-local` tracked the same 731 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed with three explicit skipped
   files (902 tests passed with ten explicit skips); the Level 1 gate covered
   367 modules and 1,308 dependencies; Contract drift checked 267 operations;
   source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus five Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set either external-peer
environment flag, so it proves that the public default source gate has no
Docker, network, or downloaded-binary prerequisite. The separately recorded
opt-in `lrzsz` and `trzsz-go` runs exercised the actual external peers before
this candidate was prepared. This candidate is local reproducibility evidence
only; it is not external-peer timeout/failure or cross-platform evidence,
source/rights clearance, a public migration release, remote CI,
signing/notarization, installed Windows/Linux validation, an authenticated
updater or final compatibility removal. IR-12 remains **In progress**; IR-13
and IR-14 remain **Open**.

## Current P-02 dual-architecture external-peer candidate

On 2026-09-22, `bun run candidate:check` was rerun after the opt-in external
`lrzsz` and `trzsz-go` Docker-PTY suites were parameterized for fixed Linux
arm64 and amd64 peers. This record was written after the run, so its figures
identify the exact pre-evidence snapshot.

The prepared source snapshot contained 731 files, 15,850,063 bytes and
source-tree SHA-256
`e51ec11d6e76aa7f666e186822ad608f9d82ee1942890e66c1759dc6d8dbb3b2`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `212b1e88f131efb2a958d5bbb4eec302a6a41041` tracked exactly 731 files.
2. Its distinct `git clone --no-local` tracked the same 731 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed with three explicit skipped
   files (902 tests passed with ten explicit skips); the Level 1 gate covered
   367 modules and 1,308 dependencies; Contract drift checked 267 operations;
   source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus five Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set either external-peer
environment flag, so it has no Docker, network, or downloaded-binary
prerequisite. Separately, the recorded opt-in suites passed all six `lrzsz`
tests and all three `trzsz-go` tests for each fixed `linux/arm64` and
`linux/amd64` peer. This candidate is local reproducibility evidence only; it
is not external-peer timeout/failure or installed cross-platform evidence,
source/rights clearance, a public migration release, remote CI,
signing/notarization, installed Windows/Linux validation, an authenticated
updater or final compatibility removal. IR-12 remains **In progress**; IR-13
and IR-14 remain **Open**.

## Current P-02 external-peer-through-SSH candidate

On 2026-09-22, `bun run candidate:check` was rerun after the opt-in external
`lrzsz` SSH-PTY suite was added. This record was written after the run, so its
figures identify the exact pre-evidence snapshot.

The prepared source snapshot contained 732 files, 15,871,003 bytes and
source-tree SHA-256
`1a4452f85b1a8fb37ea9c3c9928b0ef5bb595571159930b9707d9a3664eaaa3c`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `668939c63c11bf8f181867ba30ca61c0f57810ec` tracked exactly 732 files.
2. Its distinct `git clone --no-local` tracked the same 732 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed with four explicit skipped
   files (902 tests passed with thirteen explicit skips); the Level 1 gate
   covered 367 modules and 1,308 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus five Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set any external-peer
environment flag, so it has no Docker, network, or downloaded-binary
prerequisite. Separately, the external `lrzsz` SSH-PTY suite passed ZMODEM
download, upload and receive-side cancellation plus XMODEM-1K download, upload
and receive-side cancellation for each fixed `linux/arm64` and `linux/amd64`
peer. This candidate is local reproducibility evidence only; it is not
independently operated SSH, host-key approval, external-peer timeout/failure,
installed cross-platform, source/rights, public migration, remote-CI,
signing/notarization, authenticated-updater or final-compatibility-removal
evidence. IR-12 remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-02 controlled-XMODEM-malformed-frame candidate

On 2026-09-22, `bun run candidate:check` was rerun after a selected XMODEM
receive was required to discard its real `.part` staging file once malformed
CRC frames exhaust the bounded retry limit. The opt-in external Debian `sx`
suite first verifies nonzero staging bytes, then deliberately changes a later
payload byte in transit while the peer and encrypted SSH channel stay open. The
product must emit `session-error` and `session-end`, send cancellation to that
peer, observe its nonzero exit and publish no destination. This is a controlled
transport-corruption test around an actual external peer; it does not represent
the upstream binary as naturally generating invalid frames.

The deliberate pre-evidence source snapshot had 738 files, 15,251,257 bytes
and source-tree SHA-256
`f690145a04a2dbcc6707c314bf32742bec54107673e455797a1ed1b08e46bea2`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `01a11f905a025baa04da8013af2c1a3be9baff6d` tracked exactly 738 files.
2. Its distinct `git clone --no-local` tracked the same 738 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 213 test files passed with five explicit skipped
   files (921 tests passed with thirty-one explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; and
   production build/layout plus five visual and two accessibility Electron
   journeys passed.

Separately acquired temporary Debian arm64 and amd64 package bytes each matched
their existing fixed hashes. For each architecture, the production
`Ssh2Transport` SSH-PTY suite passed 15/15, including selected-XMODEM silence
and controlled in-transit malformed-frame cleanup. This is controlled external
peer evidence only. It does not provide independently operated SSH, upstream
native malformed-frame behavior, ZMODEM/TRZSZ malformed-frame or arbitrary
non-channel-close partial-file evidence, source-rights, design/trademark,
public migration or compatibility-removal, remote-CI, owner-created repository,
signing/notarization, authenticated-updater or installed cross-platform
evidence. IR-12 remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-02 all-protocol-controlled-malformed-frame candidate

On 2026-09-22, `bun run candidate:check` was rerun after the external SSH-PTY
coverage was extended from selected-XMODEM malformed frames to controlled
selected ZMODEM and TRZSZ malformed frames. Each external case waits until the
actual peer has written nonzero bytes into Axterm's selected hidden staging
file, then changes only later bytes in transit while leaving the peer and SSH
channel open. The TRZSZ Runtime also now stops its transfer reader and writes
the established terminal cancellation byte if its own protocol/filesystem
operation fails, rather than merely dropping local staging while leaving the
peer waiting. These are controlled transport-fault boundaries, not assertions
that `sz` or `tsz` natively produces malformed frames.

The deliberate pre-evidence source snapshot had 738 files, 15,265,890 bytes
and source-tree SHA-256
`b88551dc87d57250e32787a97d72e8a957a1dd21ee044d6388096938eb99760f`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `1df70dae5eaddcd58dd6511ca325ba0673384fd8` tracked exactly 738 files.
2. Its distinct `git clone --no-local` tracked the same 738 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 213 test files passed with five explicit skipped
   files (921 tests passed with thirty-three explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; and
   production build/layout plus five visual and two accessibility Electron
   journeys passed.

The normal candidate deliberately did not enable external peers. Separately,
each SHA-verified temporary Debian arm64/amd64 package made the actual `lrzsz`
SSH-PTY suite pass 16/16, including XMODEM and ZMODEM controlled in-transit
malformed-frame cleanup after nonzero staging. The hash-pinned `trzsz-go`
arm64/amd64 SSH-PTY suites each passed 7/7, including the equivalent TRZSZ
case. Neither peer input entered the candidate, repository, lockfile or product
payload. This local reproducibility evidence does not establish native upstream
bad-frame behavior, independently operated SSH, arbitrary non-channel-close
partial-file failure, source rights, design/trademark review, public migration
or compatibility removal, remote CI, owner-created repository,
signing/notarization, authenticated updater or installed cross-platform
evidence. IR-12 remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-02 external-peer-through-SSH XMODEM candidate

On 2026-09-22, `bun run candidate:check` was rerun after XMODEM-1K external
`lrzsz` directions and receive-side cancellation were added to the opt-in SSH-
PTY suite. This record was written after the run, so its figures identify the
exact pre-evidence snapshot.

The prepared source snapshot contained 732 files, 15,882,020 bytes and
source-tree SHA-256
`e9a29ab81ac6179d6f4a87f03013951182bb3dc254264cfda2e7ad7b2a391cd9`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `762fa981026af5cd565bcb31e802be9c4c81e8ba` tracked exactly 732 files.
2. Its distinct `git clone --no-local` tracked the same 732 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed with four explicit skipped
   files (902 tests passed with sixteen explicit skips); the Level 1 gate
   covered 367 modules and 1,308 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus five Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set any external-peer
environment flag, so it has no Docker, network, or downloaded-binary
prerequisite. Separately, the external `lrzsz` SSH-PTY suite passed six tests
for each fixed `linux/arm64` and `linux/amd64` peer: ZMODEM and XMODEM-1K
download/upload plus each receive-side cancellation. This candidate is local
reproducibility evidence only; it is not independently operated SSH, host-key
approval, external-peer timeout/failure, installed cross-platform, source/
rights, public migration, remote-CI, signing/notarization, authenticated-
updater or final-compatibility-removal evidence. IR-12 remains **In progress**;
IR-13 and IR-14 remain **Open**.

## Current P-02 external-peer-through-SSH TRZSZ candidate

On 2026-09-22, `bun run candidate:check` was rerun after the opt-in external
`trzsz-go` SSH-PTY suite was added. This record was written after the run, so
its figures identify the exact pre-evidence snapshot.

The prepared source snapshot contained 733 files, 15,902,989 bytes and
source-tree SHA-256
`a2a9a0e7663cc2b75aac9c2578b2d4ee74fdfb2de4f054532082415cf6a58f68`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `2b62b01c2d06c51d7989c0cba2cbbf5e6502d7a9` tracked exactly 733 files.
2. Its distinct `git clone --no-local` tracked the same 733 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed with five explicit skipped
   files (902 tests passed with nineteen explicit skips); the Level 1 gate
   covered 367 modules and 1,308 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus five Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set any external-peer
environment flag, so it has no Docker, network, or downloaded-binary
prerequisite. Separately, the external `lrzsz` SSH-PTY suite passed six tests
for each fixed `linux/arm64` and `linux/amd64` peer: ZMODEM and XMODEM-1K
download/upload plus each receive-side cancellation; the external `trzsz-go`
SSH-PTY suite passed three tests for each fixed peer: external `tsz` download,
Axterm upload to external `trz`, and `tsz` receive-side cancellation without a
published file. This candidate is local reproducibility and controlled-SSH-peer
evidence only; it is not independently operated SSH, host-key approval,
external-peer timeout/failure, installed cross-platform, source/rights, public
migration, remote-CI, signing/notarization, authenticated-updater or final-
compatibility-removal evidence. IR-12 remains **In progress**; IR-13 and IR-14
remain **Open**.

## Current P-02 staged-publication portability candidate

On 2026-09-22, `bun run candidate:check` was rerun after all transfer engines
received the shared staged-publication portability fallback. This record is
written after the command, so all snapshot figures identify the exact
pre-evidence source state.

The prepared source snapshot contained 735 files, 15,954,761 bytes and
source-tree SHA-256
`fa6763a2e677639625083defecbfae83503f28f86107d91290fad7356115778a`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `f2f1750bb210c262c96ae572d6be41e049d7bc9b` tracked exactly 735 files.
2. Its distinct `git clone --no-local` tracked the same 735 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 212 test files passed with five explicit skipped
   files (906 tests passed with twenty-five explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus five Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set any external-peer
environment flag, so it has no Docker, network, or downloaded-binary
prerequisite. Separately, both fixed `linux/arm64` and `linux/amd64` external
SSH-PTY suites pass ten `lrzsz` tests and five `trzsz-go` tests. This candidate
is local reproducibility and controlled-SSH-peer evidence only; it is not a
real unsupported-filesystem mount, an independently operated SSH host,
host-key approval, stalled/failed-transfer coverage after selection, installed
cross-platform, source/rights, public migration, remote-CI, signing/
notarization, authenticated-updater or final-compatibility-removal evidence.
IR-12 remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-02 selection-timeout and P-07 mint-shell candidate

On 2026-09-22, `bun run candidate:check` was rerun after the controlled
external-peer selection-timeout coverage and the Axterm mint selection-state
guard were added. This record is written after the command, so all snapshot
figures identify the exact pre-evidence source state.

The prepared source snapshot contained 733 files, 15,942,142 bytes and
source-tree SHA-256
`d02115c9284fc41f10d9a362fbaef17575210044178fe9653b133912c2cda3b5`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `70ad8565f30ba7767c561a48182dbec83e07f1a3` tracked exactly 733 files.
2. Its distinct `git clone --no-local` tracked the same 733 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed with five explicit skipped
   files (902 tests passed with twenty-five explicit skips); the Level 1 gate
   covered 367 modules and 1,308 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus five Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set any external-peer
environment flag, so it has no Docker, network, or downloaded-binary
prerequisite. Separately, both fixed `linux/arm64` and `linux/amd64` external
SSH-PTY suites passed ten `lrzsz` tests (XMODEM/ZMODEM transfer, cancellation
and no-destination timeouts) and five `trzsz-go` tests (TRZSZ transfer,
cancellation and no-destination timeout). This candidate is local
reproducibility and controlled-SSH-peer evidence only; it is not an
independently operated SSH host, host-key approval, stalled/failed-transfer
coverage after selection, installed cross-platform, source/rights, public
migration, remote-CI, signing/notarization, authenticated-updater or final-
compatibility-removal evidence. IR-12 remains **In progress**; IR-13 and IR-14
remain **Open**.

## Current P-02 external-peer-through-SSH cancellation-direction candidate

On 2026-09-22, `bun run candidate:check` was rerun after external SSH-PTY
cancellation coverage expanded for the hash-pinned `lrzsz` and `trzsz-go`
peers. This record was written after the run, so its figures identify the exact
pre-evidence snapshot.

The prepared source snapshot contained 733 files, 15,913,393 bytes and
source-tree SHA-256
`e4312293be5990ae40cbeafeb2542d79adf66859ee781b7dc42e5af9575c7aab`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `8a8055a6cf27eeec90c7f7904bc80c089ffdd67f` tracked exactly 733 files.
2. Its distinct `git clone --no-local` tracked the same 733 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed with five explicit skipped
   files (902 tests passed with twenty-one explicit skips); the Level 1 gate
   covered 367 modules and 1,308 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus five Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set any external-peer
environment flag, so it has no Docker, network, or downloaded-binary
prerequisite. Separately, the external `lrzsz` SSH-PTY suite passed seven tests
for each fixed `linux/arm64` and `linux/amd64` peer: ZMODEM download/upload and
both cancellation directions, plus XMODEM-1K download/upload and receive-side
cancellation. The external `trzsz-go` SSH-PTY suite passed four tests for each
fixed peer: external `tsz` download, Axterm upload to external `trz`, and both
cancellation directions without a published file. This candidate is local
reproducibility and controlled-SSH-peer evidence only; it is not independently
operated SSH, host-key approval, XMODEM upload-cancellation, external-peer
timeout/failure, installed cross-platform, source/rights, public migration,
remote-CI, signing/notarization, authenticated-updater or final-compatibility-
removal evidence. IR-12 remains **In progress**; IR-13 and IR-14 remain
**Open**.

## Current P-02 external-peer-through-SSH all-protocol-cancellation candidate

On 2026-09-22, `bun run candidate:check` was rerun after cancellation coverage
was completed in both directions for the hash-pinned external XMODEM, ZMODEM
and TRZSZ peers over SSH PTYs. This record was written after the run, so its
figures identify the exact pre-evidence snapshot.

The prepared source snapshot contained 733 files, 15,921,723 bytes and
source-tree SHA-256
`bfe80f28f79715a083a182d881f502a1a3fbbf1f2776c7d3268d9601bb996050`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `f288c0589ad9289d2ccbeac3ed5199125b0bf894` tracked exactly 733 files.
2. Its distinct `git clone --no-local` tracked the same 733 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 211 test files passed with five explicit skipped
   files (902 tests passed with twenty-two explicit skips); the Level 1 gate
   covered 367 modules and 1,308 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus five Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set any external-peer
environment flag, so it has no Docker, network, or downloaded-binary
prerequisite. Separately, the external `lrzsz` SSH-PTY suite passed eight tests
for each fixed `linux/arm64` and `linux/amd64` peer: XMODEM-1K and ZMODEM
download/upload plus both cancellation directions. The external `trzsz-go`
SSH-PTY suite passed four tests for each fixed peer: external `tsz` download,
Axterm upload to external `trz`, and both cancellation directions without a
published file. This candidate is local reproducibility and controlled-SSH-peer
evidence only; it is not independently operated SSH, host-key approval,
external-peer timeout/failure, installed cross-platform, source/rights, public
migration, remote-CI, signing/notarization, authenticated-updater or final-
compatibility-removal evidence. IR-12 remains **In progress**; IR-13 and IR-14
remain **Open**.

## Current P-02 selected-transfer data-loss candidate

On 2026-09-22, `bun run candidate:check` was rerun after the external ZMODEM
SSH-PTY suite gained a selected-transfer incoming-data-loss cleanup regression.
This record was written after the command, so its figures identify the exact
pre-evidence source state.

The prepared source snapshot contained 735 files, 15,966,228 bytes and
source-tree SHA-256
`e8ec8bc68e9d8441dc1f32ba8b397de98a89b864e989423316e41ad0a9dad7a5`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `f6e4aa4a2f63532128eb0f1b23645def6c477e42` tracked exactly 735 files.
2. Its distinct `git clone --no-local` tracked the same 735 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 212 test files passed with five explicit skipped
   files (906 tests passed with twenty-six explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus five Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set any external-peer
environment flag, so it has no Docker, network, or downloaded-binary
prerequisite. Separately recorded opt-in runs passed eleven hash-pinned Debian
`lrzsz` SSH-PTY tests for each fixed `linux/arm64` and `linux/amd64` peer, and
five hash-pinned official `trzsz-go` tests for each fixed peer. The added
`lrzsz` case proves selected-session cleanup and no file publication when later
external-peer data is deliberately unavailable to the product session; fixture
shutdown then waits for the labelled peer container to disappear. This is local
reproducibility and controlled-fixture evidence only. It does not cover
external-peer exit, malformed-frame or partial-file failure after selection,
an independently operated SSH host, host-key approval, installed cross-platform
products, source/rights, public migration, remote CI, signing/notarization,
authenticated updater or final compatibility removal. IR-12 remains **In
progress**; IR-13 and IR-14 remain **Open**.

## Current P-02 staged-partial peer-exit candidate

On 2026-09-22, `bun run candidate:check` was rerun after the external ZMODEM
SSH-PTY peer-exit regression was strengthened to wait for a nonempty Axterm
`.part` staging file before terminating the external peer. This record was
written after the command, so its figures identify the exact pre-evidence source
state.

The prepared source snapshot contained 735 files, 15,982,365 bytes and
source-tree SHA-256
`2b6d4d19aa3fe7b3a5a7e6d091e6b776e22f717d8a7c748561f737e9e41cc8a5`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `6203e7d4b24648d035ef303932918cdb94d62530` tracked exactly 735 files.
2. Its distinct `git clone --no-local` tracked the same 735 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 212 test files passed with five explicit skipped
   files (906 tests passed with twenty-seven explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus five Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set any external-peer
environment flag, so it has no Docker, network or downloaded-binary
prerequisite. Separately recorded opt-in runs passed twelve hash-pinned Debian
`lrzsz` SSH-PTY tests and five hash-pinned official `trzsz-go` tests for each
fixed `linux/arm64` and `linux/amd64` peer. The added ZMODEM case selects a
real destination, verifies that nonzero peer bytes exist in Axterm's hidden
`.part` file, then terminates the external `sz`/SSH fixture. Terminal-channel
exit destroys the product session, removes partial staging output and leaves no
published destination file. This candidate is local reproducibility and
controlled-fixture evidence only. It does not cover malformed frames or
partial-file protocol failures that keep the channel open, XMODEM/TRZSZ
post-selection failure, an independently operated SSH host, host-key approval,
installed cross-platform products, source/rights, public migration, remote CI,
signing/notarization, authenticated updater or final compatibility removal.
IR-12 remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-02 malformed-selected-frame candidate

On 2026-09-22, `bun run candidate:check` was rerun after the selected-
destination ZMODEM protocol regression began corrupting the CRC of a later peer
data packet after prior packet bytes had been staged. This record was written
after the command, so its figures identify the exact pre-evidence source state.

The prepared source snapshot contained 735 files, 15,991,883 bytes and
source-tree SHA-256
`4b71fd22cc9811db2854a2cf5cf9cfc3f5251a9df4756a1937d51581817d68e2`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `49ef6cc1471f34cf7b4bdbca1456d0ad82481125` tracked exactly 735 files.
2. Its distinct `git clone --no-local` tracked the same 735 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 212 test files passed with five explicit skipped
   files (907 tests passed with twenty-seven explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus five Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set any external-peer
environment flag, so it has no Docker, network or downloaded-binary
prerequisite. Separately recorded opt-in runs passed twelve hash-pinned Debian
`lrzsz` SSH-PTY tests and five hash-pinned official `trzsz-go` tests for each
fixed `linux/arm64` and `linux/amd64` peer. The added independent `zmodem2`
peer sends a valid selected-destination data packet, then a CRC-damaged later
packet while the channel remains open. Axterm emits `transfer-error` and
`session-end`, removes partially staged output and never publishes the offered
file. This candidate is local reproducibility and source-level published-peer
bad-frame evidence only. It is not malformed output from an external Debian
peer, independently operated SSH, host-key approval, installed cross-platform
products, XMODEM/TRZSZ post-selection failure, source/rights, public migration,
remote CI, signing/notarization, authenticated updater or final compatibility
removal. IR-12 remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-02 TRZSZ staged-peer-exit candidate

On 2026-09-22, `bun run candidate:check` was rerun after the external
`trzsz-go tsz` SSH-PTY regression was added. It selects a writable destination,
waits until nonzero peer bytes exist in Axterm's hidden `.part` staging file,
then terminates the SSH fixture. This record was written after the command, so
its figures identify the exact pre-evidence source state.

The prepared source snapshot contained 735 files, 16,000,621 bytes and
source-tree SHA-256
`6154eae2061f5cacebc8f6f043b28018fa7b3943b03cf78fc9f1fd6f2c6f1516`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `d7afd586b593699a8768a4c4bb60fbfbff7d7a40` tracked exactly 735 files.
2. Its distinct `git clone --no-local` tracked the same 735 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 212 test files passed with five explicit skipped
   files (907 tests passed with twenty-eight explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus five Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set any external-peer
environment flag, so it has no Docker, network or downloaded-binary
prerequisite. Separately recorded opt-in runs passed twelve hash-pinned Debian
`lrzsz` SSH-PTY tests and six hash-pinned official `trzsz-go` tests for each
fixed `linux/arm64` and `linux/amd64` peer. The added TRZSZ case terminates the
external `tsz`/SSH fixture only after Axterm has staged nonzero selected-
destination bytes; terminal-channel exit destroys the product session, removes
partial staging output and leaves no published destination file. This candidate
is local reproducibility and controlled-fixture evidence only. It does not
cover external-peer malformed frames, non-channel-close partial-file failures,
XMODEM post-selection failure, an independently operated SSH host, host-key
approval, installed cross-platform products, source/rights, public migration,
remote CI, signing/notarization, authenticated updater or final compatibility
removal. IR-12 remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-02 XMODEM staged-peer-exit candidate

On 2026-09-22, `bun run candidate:check` was rerun after the external Debian
`sx --1k` SSH-PTY regression was added. It selects a writable destination,
waits until nonzero peer bytes exist in Axterm's hidden `.part` staging file,
then stops only the Docker container carrying the test's unique label. This
record was written after the command, so its figures identify the exact
pre-evidence source state.

The prepared source snapshot contained 735 files, 16,010,148 bytes and
source-tree SHA-256
`d96efb07da4d618ddebe2e15c04280d19de579c17903565509a879b1d9779bf0`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `443bd4c41f5beb39f1f9752cf93a3b3dedd895e2` tracked exactly 735 files.
2. Its distinct `git clone --no-local` tracked the same 735 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 212 test files passed with five explicit skipped
   files (907 tests passed with twenty-nine explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus five Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set any external-peer
environment flag, so it has no Docker, network or downloaded-binary
prerequisite. Separately recorded opt-in runs passed thirteen hash-pinned Debian
`lrzsz` SSH-PTY tests and six hash-pinned official `trzsz-go` tests for each
fixed `linux/arm64` and `linux/amd64` peer. The added XMODEM case stops its
labelled external `sx` container only after Axterm has staged nonzero selected-
destination bytes; the production terminal channel exits nonzero, destroys the
product session, removes partial staging output and leaves no published
destination file. This candidate is local reproducibility and controlled-
fixture evidence only. It does not cover external-peer malformed frames,
non-channel-close partial-file failures, an independently operated SSH host,
host-key approval, installed cross-platform products, source/rights, public
migration, remote CI, signing/notarization, authenticated updater or final
compatibility removal. IR-12 remains **In progress**; IR-13 and IR-14 remain
**Open**.

## Current P-03 FTP stream-cancellation candidate

On 2026-09-22, `bun run candidate:check` was rerun after FTP stream cleanup
was corrected for caller cancellation without an error. A normal completed
read or write keeps its `basic-ftp` client reusable; an unsettled read or write
stream that a caller destroys closes its data channel so queued work cannot
remain behind a cancelled transfer. The deliberate pre-evidence source snapshot
had 739 files, 16,069,922 bytes and source-tree SHA-256
`1f5509cc9124995b5b42c517c96793da1c851987d7b3d23b1bbc0e6759b6dc99`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `819f1b47762d8d57aec6c9b63a2d0dfe7b2b5543` tracked exactly 739 files.
2. Its distinct `git clone --no-local` tracked the same 739 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 213 test files passed with five explicit skipped
   files (918 tests passed with twenty-nine explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus six Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set an external-peer
environment flag, so it has no Docker, network or downloaded-binary
prerequisite. The migration record is intentionally pending and the composed
final-release command therefore stops before the final name scan. This is local
reproducibility and a narrow FTP lifecycle correction only. It does not provide
rights clearance, public migration or compatibility removal, remote CI, an
owner-created repository, signing/notarization, authenticated updater,
installed cross-platform evidence, or IR-12/IR-14 final acceptance. IR-12
remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-03 FTP control-session-limit candidate

On 2026-09-22, `bun run candidate:check` was rerun after the local FTP Widget
gained a raw-TCP control-session regression. The fixture retains sixteen live
control peers through their `220` greetings, requires a seventeenth peer to
close without acquiring a server session, then disconnects one retained peer
and requires a replacement peer to receive a normal greeting. This verifies
both the bounded `MAX_CLIENTS` boundary and session-slot reclamation after peer
disconnect, without treating it as a substitute for protocol or platform
release testing.

The deliberate pre-evidence source snapshot had 739 files, 16,077,209 bytes
and source-tree SHA-256
`e2db7f4ed6dc2cd726234ca18f8c6617e71c9db436393222b21160cb9fb4885a`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `0c87063ecc8332cad3727bbebb3224614e8907bf` tracked exactly 739 files.
2. Its distinct `git clone --no-local` tracked the same 739 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 213 test files passed with five explicit skipped
   files (919 tests passed with twenty-nine explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; the
   core locale ledger checked 2,543 keys with no partial locale or English
   fallback; and production build/layout plus six Axterm visual/accessibility
   journeys passed.

The normal candidate gate intentionally did not set an external-peer
environment flag, so it has no Docker, network or downloaded-binary
prerequisite. The migration record is intentionally pending and the composed
final-release command therefore stops before the final name scan. This is local
reproducibility and a narrow FTP connection-limit/lifecycle correction only. It
does not provide rights clearance, public migration or compatibility removal,
remote CI, an owner-created repository, signing/notarization, authenticated
updater, installed cross-platform evidence, or IR-12/IR-14 final acceptance.
IR-12 remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-05 product-asset-scope candidate

On 2026-09-22, `bun run candidate:check` was rerun after the unused,
documentation-only `axterm-logo-concept.png` was removed from the source tree.
It was not selected as an Electron resource and its public disposition and
rights review were pending. The generated inventory and review ledger now cover
only the five actual SVG/PNG/ICO/ICNS application-mark files. This reduces the
new public source surface without claiming that the retained app marks have
received authorship, trademark or visual-similarity clearance.

The deliberate pre-evidence source snapshot had 738 files, 15,200,346 bytes
and source-tree SHA-256
`db09e5caf09be94530e6b46513c684d0efee05f137b6e043ee2980a1c3b0559e`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `69aad6495134e43a8576ac770361224b3a0966bf` tracked exactly 738 files.
2. Its distinct `git clone --no-local` tracked the same 738 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 213 test files passed with five explicit skipped
   files (919 tests passed with twenty-nine explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, five-mark asset inventory/review, four-catalog localization
   and snapshot checks passed; the core locale ledger checked 2,543 keys with
   no partial locale or English fallback; and production build/layout plus six
   Axterm visual/accessibility journeys passed.

The normal candidate gate intentionally did not set an external-peer
environment flag, so it has no Docker, network or downloaded-binary
prerequisite. The migration record is intentionally pending and the composed
final-release command therefore stops before the final name scan. This is local
reproducibility and a narrowed product-asset scope only. It does not provide
rights clearance for the retained marks, public migration or compatibility
removal, remote CI, an owner-created repository, signing/notarization,
authenticated updater, installed cross-platform evidence, or IR-12/IR-14 final
acceptance. IR-12 remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-05 documentation-asset-boundary candidate

On 2026-09-22, `bun run candidate:check` was rerun after the independent
source-snapshot audit was made to reject the retired `docs/product/assets/`
location if it is reintroduced. The empty residual directory was removed from
the working tree. This is deliberately a failure condition rather than a
source-copy exclusion: a future documentation image cannot silently bypass the
five-file application-mark inventory and review ledger.

The deliberate pre-evidence source snapshot had 738 files, 15,206,150 bytes
and source-tree SHA-256
`8a37667f5e8e055c00f788884f6013231933536607f7f9066c5e7bfdcd21a07d`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `2e7be206b04580304ce25aefac7ba39cea2ebdbf` tracked exactly 738 files.
2. Its distinct `git clone --no-local` tracked the same 738 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 213 test files passed with five explicit skipped
   files (919 tests passed with twenty-nine explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, five-mark asset inventory/review, four-catalog localization
   and snapshot checks passed; the core locale ledger checked 2,543 keys with
   no partial locale or English fallback; and production build/layout plus six
   Axterm visual/accessibility journeys passed.

The normal candidate gate intentionally did not set an external-peer
environment flag, so it has no Docker, network or downloaded-binary
prerequisite. The migration record is intentionally pending and the composed
final-release command therefore stops before the final name scan. This is local
reproducibility and a product-asset source-scope boundary only. It does not
provide rights clearance for the retained marks, public migration or
compatibility removal, remote CI, an owner-created repository,
signing/notarization, authenticated updater, installed cross-platform evidence,
or IR-12/IR-14 final acceptance. IR-12 remains **In progress**; IR-13 and
IR-14 remain **Open**.

## Current P-07 connection-profile mint-focus candidate

On 2026-09-22, `bun run candidate:check` was rerun after the source review
replaced the remaining bright-blue connection-profile input border and focus
halo (`#266aa2` / `#122a39`) with Axterm's `--shell-primary` semantic token.
The source-level provenance test verifies the focused rule and rejects those
retired blue literals. This applies to application chrome; terminal-theme ANSI
blue remains user-configurable terminal content.

The deliberate pre-evidence source snapshot had 738 files, 15,212,044 bytes
and source-tree SHA-256
`cf0806d6998def5c512bfaed6a8b3c6d4c451bb4c13c61cd32c7c5bf4b3a5ece`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `eb318e64c3e3c34d94ad28715546c353044f0772` tracked exactly 738 files.
2. Its distinct `git clone --no-local` tracked the same 738 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 213 test files passed with five explicit skipped
   files (919 tests passed with twenty-nine explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, five-mark asset inventory/review, four-catalog localization
   and snapshot checks passed; the core locale ledger checked 2,543 keys with
   no partial locale or English fallback; and production build/layout plus six
   Axterm visual/accessibility journeys passed.

The normal candidate gate intentionally did not set an external-peer
environment flag, so it has no Docker, network or downloaded-binary
prerequisite. The migration record is intentionally pending and the composed
final-release command therefore stops before the final name scan. This is local
reproducibility and a narrow P-07 product-color correction only. It does not
provide visual-design or trademark review, rights clearance, public migration
or compatibility removal, remote CI, an owner-created repository,
signing/notarization, authenticated updater, installed cross-platform evidence,
or IR-12/IR-14 final acceptance. IR-12 remains **In progress**; IR-13 and
IR-14 remain **Open**.

## Current P-01 governance and P-07 rendered-mint candidate

On 2026-09-22, `bun run candidate:check` was rerun after the former parity
ADR's header was made explicitly historical/superseded by ADR-016 and a new
source-Electron assertion read the actual connection-profile input's focused
mint border and halo. This is a document-currentness and rendered-chrome
boundary: it is not an assertion that the historical material has rights
clearance or that the product's design has received a trademark review.

The deliberate pre-evidence source snapshot had 738 files, 15,221,407 bytes
and source-tree SHA-256
`932406c746c194389560e83eea3adc5d7f5e472eab401612bb6e6a9e578f9835`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `ce0a8e25e1efa80a8ac84b383b25256c866472ef` tracked exactly 738 files.
2. Its distinct `git clone --no-local` tracked the same 738 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 213 test files passed with five explicit skipped
   files (919 tests passed with twenty-nine explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; and
   production build/layout plus five visual and two accessibility Electron
   journeys passed.

The normal candidate gate intentionally did not set an external-peer
environment flag, so it has no Docker, network or downloaded-binary
prerequisite. The migration record is intentionally pending and the composed
final-release command therefore stops before the final name scan. This is local
reproducibility only. It does not provide source-rights, design/trademark,
public migration or compatibility-removal, remote-CI, owner-created repository,
signing/notarization, authenticated-updater or installed cross-platform
evidence. IR-12 remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-02 selected-XMODEM-silence and P-07 Runtime-recovery-mint candidate

On 2026-09-22, `bun run candidate:check` was rerun after two narrow regressions:
the independent selected XMODEM receiver must send `CAN CAN`, publish no file
and emit its error/end events when a selected peer goes silent; and the real
Core Runtime-recovery banner must render the Axterm mint primary rather than a
retired blue information color. The prepared snapshot deliberately precedes
this evidence record, so this document update is not represented as part of the
checked candidate.

The deliberate pre-evidence source snapshot had 738 files, 15,232,759 bytes
and source-tree SHA-256
`2d6faf61fc400a8a290957092af8437b399f96701c12dc918a98cba5f277343b`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `fa8799b72d5071913565fa9ae10364820a486d83` tracked exactly 738 files.
2. Its distinct `git clone --no-local` tracked the same 738 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype` or generated OpenAPI;
   its status and staged/unstaged whitespace checks were empty before and after
   the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 213 test files passed with five explicit skipped
   files (920 tests passed with thirty explicit skips); the Level 1 gate covered
   368 modules and 1,313 dependencies; Contract drift checked 267 operations;
   source commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; and production
   build/layout plus five visual and two accessibility Electron journeys passed.

The normal candidate gate intentionally did not set the opt-in external-peer
environment flag. It therefore does not make the separate external Debian
`sx`/SSH-PTY test pass: that attempt remains an APT-provisioning timeout before
its fourteen protocol cases, with no claimed interoperability result. This is
local reproducibility plus two focused source/Electron regressions only. It
does not provide source-rights, design/trademark, public migration or
compatibility-removal, remote-CI, owner-created repository,
signing/notarization, authenticated-updater or installed cross-platform
evidence. IR-12 remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-02 fixed-package external-peer candidate

On 2026-09-22, `bun run candidate:check` was rerun after the opt-in external
`lrzsz` peer suites gained a test-only `AXTERM_EXTERNAL_LRZSZ_DEB` input. It is
for a runner whose disposable Docker container cannot download a complete Debian
APT index within the test's fixed 40-second hook. The package is copied only to
the new temporary fixture root and must match the existing selected platform's
fixed SHA-256 before the network-isolated external peer installs it; neither
the package nor an APT cache can enter the source snapshot.

The deliberate pre-evidence source snapshot had 738 files, 15,240,735 bytes
and source-tree SHA-256
`89009fd18e5bbf6d70e608e45f11571164cef598033e0f1cfb6f4c6e24763e6b`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `15669fdf794f97a6546b1b0e5cac36d9aa72f875` tracked exactly 738 files.
2. Its distinct `git clone --no-local` tracked the same 738 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 213 test files passed with five explicit skipped
   files (920 tests passed with thirty explicit skips); the Level 1 gate covered
   368 modules and 1,313 dependencies; Contract drift checked 267 operations;
   source commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; and production
   build/layout plus five visual and two accessibility Electron journeys passed.

Separately acquired temporary Debian arm64 and amd64 package bytes each matched
their existing fixed hashes. For each architecture, the direct external-PTY
suite passed 6/6 and the production `Ssh2Transport` SSH-PTY suite passed 14/14,
including an external selected-XMODEM peer that goes silent after receiving the
receiver's CRC request. This is controlled external-peer evidence only. It does
not provide independently operated SSH, malformed-frame/non-channel-close
partial-file evidence, source-rights, design/trademark, public migration or
compatibility-removal, remote-CI, owner-created repository,
signing/notarization, authenticated-updater or installed cross-platform
evidence. IR-12 remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-03 FTP ABOR candidate

On 2026-09-22, `bun run candidate:check` was rerun after the independent
`NodeLocalFtpServer` gained a raw control/data cancellation regression. The
test authenticates, enters PASV, begins a 32 MiB `RETR`, pauses after data
arrives, sends `ABOR` on the live control socket, requires `426` followed by
`226`, then requires `NOOP` on that same authenticated socket to return `200`.
The snapshot deliberately precedes this evidence record, so this explanatory
update is not represented as a candidate input.

The deliberate pre-evidence source snapshot had 738 files, 15,276,762 bytes
and source-tree SHA-256
`5eb4f57f7260a6000cf21a641bb2c032cd49860c18769aef54ab0a3cf3a5cf82`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `89292d97f2d50b5b5ab5b89a30760946fc4e941e` tracked exactly 738 files.
2. Its distinct `git clone --no-local` tracked the same 738 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 213 test files passed with five explicit skipped
   files (922 tests passed with thirty-three explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; and
   production build/layout plus five visual and two accessibility Electron
   journeys passed.

The normal candidate does not enable the opt-in external-peer suite. This is
local reproducibility and FTP cancellation/resource-cleanup evidence only. It
does not provide an independent FTP-server security review, source rights,
design/trademark review, public migration or compatibility-removal, remote-CI,
owner-created repository, signing/notarization, authenticated-updater or
installed cross-platform evidence. IR-04 and IR-12 remain **In progress**;
IR-13 and IR-14 remain **Open**.

## Current P-03 pending-PASV ABOR candidate

On 2026-09-22, `bun run candidate:check` was rerun after the local FTP server
made a pending data connection abortable. The raw authenticated client has a
single configured PASV port, starts `RETR` without opening the announced data
connection, receives `150`, and sends `ABOR`. It requires the transfer's `426`
then the command's `226` without waiting for the 15-second data-connect timeout,
requires a fresh PASV allocation from that sole port, and requires `NOOP` on the
same control session to return `200`. The snapshot deliberately precedes this
evidence record, so this explanatory update is not represented as a candidate
input.

The deliberate pre-evidence source snapshot had 738 files, 15,284,843 bytes
and source-tree SHA-256
`abfa7b097fdd6ca449cac6b4a42bf4f380fad1999e9c696dbf13258d79836b34`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `6146cb61388ef62a3097c56301367347a8b2a686` tracked exactly 738 files.
2. Its distinct `git clone --no-local` tracked the same 738 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 213 test files passed with five explicit skipped
   files (923 tests passed with thirty-three explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; and
   production build/layout plus five visual and two accessibility Electron
   journeys passed.

The normal candidate does not enable the opt-in external-peer suite. This is
local reproducibility and FTP pending-listener cleanup evidence only. It does
not provide an independent FTP-server security review, source rights,
design/trademark review, public migration or compatibility-removal, remote-CI,
owner-created repository, signing/notarization, authenticated-updater or
installed cross-platform evidence. IR-04 and IR-12 remain **In progress**;
IR-13 and IR-14 remain **Open**.

## Current P-03 same-peer PASV candidate

On 2026-09-22, `bun run candidate:check` was rerun after the local FTP passive
listener began accepting at most one data socket from its already authorized
control peer. The raw loopback regression has a one-port PASV range and starts
four concurrent data connections from the same peer; it requires at most one
to remain open, then completes a real `RETR` through the retained socket. The
snapshot deliberately precedes this evidence record, so this explanatory update
is not represented as a candidate input.

The deliberate pre-evidence source snapshot had 738 files, 15,292,702 bytes
and source-tree SHA-256
`13c8deb354b795b6a38f5ee0173a14790fe5face9ae258a42c4f9ef6ceb4c4de`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `3b62aa542bade2b0a9e48114ecd0b9776f19e233` tracked exactly 738 files.
2. Its distinct `git clone --no-local` tracked the same 738 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 213 test files passed with five explicit skipped
   files (924 tests passed with thirty-three explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; and
   production build/layout plus five visual and two accessibility Electron
   journeys passed.

The normal candidate does not enable the opt-in external-peer suite. This is
local reproducibility and same-peer data-socket containment evidence only. It
does not provide an independent FTP-server security review, source rights,
design/trademark review, public migration or compatibility-removal, remote-CI,
owner-created repository, signing/notarization, authenticated-updater or
installed cross-platform evidence. IR-04 and IR-12 remain **In progress**;
IR-13 and IR-14 remain **Open**.

## Current P-03 Linux PASV-lifecycle candidate

On 2026-09-22, `bun run candidate:check` was rerun after the optional
platform-selected Linux FTP source smoke gained raw TCP coverage for the local
PASV lifecycle fixes. The container remains read-only and network-isolated;
both `linux/arm64` and `linux/amd64` runs require a pending passive `RETR` to
return `426` then `226` after `ABOR`, release its listener for a fresh PASV
allocation, keep `NOOP` usable on the authenticated control connection, and
retain only one of four simultaneous same-peer data sockets for a real `RETR`.
The snapshot deliberately precedes this evidence record, so this explanatory
update is not represented as a candidate input.

The deliberate pre-evidence source snapshot had 738 files, 15,302,994 bytes
and source-tree SHA-256
`4fce07c1f62e1d99d2025f29011807a2bba0f2e402015bd984d4737d1ab57567`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `1226a26feef79119baef2ebc24dd2d72a0da0072` tracked exactly 738 files.
2. Its distinct `git clone --no-local` tracked the same 738 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 213 test files passed with five explicit skipped
   files (924 tests passed with thirty-three explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; and
   production build/layout plus five visual and two accessibility Electron
   journeys passed.

The normal candidate does not enable the opt-in external-peer suite. The two
explicit Linux source-runtime commands passed separately in their selected
containers. This is local reproducibility plus Linux source-runtime PASV
lifecycle evidence only. It does not provide an Electron package or installed
application, independent FTP-server security review, source rights,
design/trademark review, public migration or compatibility-removal, remote-CI,
owner-created repository, signing/notarization, authenticated-updater or
installed cross-platform evidence. IR-04 and IR-12 remain **In progress**;
IR-13 and IR-14 remain **Open**.

## Current P-03 loopback-only FTP candidate

On 2026-09-22, `bun run candidate:check` was rerun after the Local FTP Widget
was confined to loopback endpoints. Plain FTP has no transport encryption, so
the product Contract now permits only `localhost`, `127.0.0.1` and `::1`; the
Runtime Adapter repeats that restriction before resolving the Directory Grant or
opening a control/passive listener. The Widget form exposes only the IPv4/IPv6
loopback options, while the source and copied packaged Electron journeys still
authenticate and list a real granted directory. Raw Adapter and Contract tests
reject `0.0.0.0` and `::`. The SSH Server Widget remains the encrypted path for
intentional network sharing. The snapshot deliberately precedes this evidence
record, so this explanatory update is not represented as a candidate input.

The deliberate pre-evidence source snapshot had 739 files, 15,313,240 bytes
and source-tree SHA-256
`e28ac8fe6c737df4bcd15ab2a27c81d3e2e4e06a59ef2bb52752bba6f5ba0cb4`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `39410efdb142887ca78afd19818dd65d00849e53` tracked exactly 739 files.
2. Its distinct `git clone --no-local` tracked the same 739 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 214 test files passed with five explicit skipped
   files (926 tests passed with thirty-three explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; and
   production build/layout plus five visual and two accessibility Electron
   journeys passed.

The normal candidate does not enable the opt-in external-peer suite. This is
local reproducibility and source-level FTP exposure hardening only. It does not
provide an independent FTP-server security review, source rights,
design/trademark review, public migration or compatibility-removal, remote-CI,
owner-created repository, signing/notarization, authenticated-updater or
installed cross-platform evidence. IR-04 and IR-12 remain **In progress**;
IR-13 and IR-14 remain **Open**.

## Current P-08 release-handoff candidate

On 2026-09-22, `bun run candidate:check` was rerun after the release-owner
handoff made the Local FTP Widget's plaintext threat boundary explicit for the
independent protocol/security review. The handoff requires the reviewer to
verify that the Contract, Runtime and Widget form reject `0.0.0.0` and `::`,
accept only `localhost`, `127.0.0.1` and `::1`, and direct any intentional
network sharing to the independently authenticated SSH Server Widget. This
candidate verifies the source tree containing that handoff; it does not
substitute the requested independent review with a local assertion. The
snapshot deliberately precedes this evidence record, so this explanatory
update is not represented as a candidate input.

The deliberate pre-evidence source snapshot had 739 files, 15,320,122 bytes
and source-tree SHA-256
`6d5c06760ef5e68b47f8dac6d51dbb3f47726998bf4dd7b3486bca20d8b7a6e2`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `b3a3fa3b52f10f098ab39468a9ed0ecc46d162d0` tracked exactly 739 files.
2. Its distinct `git clone --no-local` tracked the same 739 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 214 test files passed with five explicit skipped
   files (926 tests passed with thirty-three explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; and
   production build/layout plus five visual and two accessibility Electron
   journeys passed.

The normal candidate does not enable the opt-in external-peer suite. This is
local reproducibility and release-handoff evidence only. It does not provide an
independent FTP-server security review, source rights, design/trademark review,
public migration or compatibility-removal, remote-CI, owner-created repository,
signing/notarization, authenticated-updater or installed cross-platform
evidence. IR-04 and IR-12 remain **In progress**; IR-13 and IR-14 remain
**Open**.

## Current P-02 ADR-018 provenance candidate

On 2026-09-22, `bun run candidate:check` was rerun after ADR-018 superseded
ADR-013's direct-Legacy Prototype protocol-source decision. The new ADR retains the
Runtime-owned terminal-byte, REST, File Grant and Binary WebSocket boundaries,
but records `xmodem.ts` as Axterm-authored and `zmodem2`/`trzsz2` as separately
published third-party dependencies whose source-rights review remains pending.
Current packaging, dependency and upstream-mapping documentation was updated to
match this boundary. The snapshot deliberately precedes this evidence record,
so this explanatory update is not represented as a candidate input.

The deliberate pre-evidence source snapshot had 740 files, 15,333,747 bytes
and source-tree SHA-256
`09effef707f4ace084eaebe622d348637dc316bd46a6eb039ac62e5bfeccef0a`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `3de0e227bf95e82ea48677b099886bfceb026831` tracked exactly 740 files.
2. Its distinct `git clone --no-local` tracked the same 740 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 214 test files passed with five explicit skipped
   files (926 tests passed with thirty-three explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; and
   production build/layout plus five visual and two accessibility Electron
   journeys passed.

The normal candidate does not enable the opt-in external-peer suite. This is
local reproducibility and current-source-governance evidence only. It does not
provide a source-rights conclusion, independently operated SSH interoperability,
design/trademark review, public migration or compatibility-removal, remote-CI,
owner-created repository, signing/notarization, authenticated-updater or
installed cross-platform evidence. IR-02, IR-03, IR-04 and IR-12 remain **In
progress**; IR-13 and IR-14 remain **Open**.

## Current P-08 retired-source snapshot guard candidate

On 2026-09-22, `bun run candidate:check` was rerun after the independent
snapshot audit began rejecting the retired direct terminal-transfer source
directory, local FTP Adapter, generated Legacy Prototype locale/theme data and their
generators. These former direct P-02/P-03/P-04/P-05 source inputs are distinct
from the separately governed P-06 compatibility boundary, which remains
available only through the documented migration period. The guard makes a
reintroduction of a known direct source or generator fail the source snapshot;
it does not claim that migration compatibility has been removed or that rights
review is complete. The snapshot deliberately precedes this evidence record, so
this explanatory update is not represented as a candidate input.

The deliberate pre-evidence source snapshot had 740 files, 15,342,092 bytes
and source-tree SHA-256
`badf40ee2f558df2d5c580b531519b0f1ce33bd72f03a716c9cd02ea0a3b8bfe`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `8bc499847ee91ad3c38fdd37097614586914d80b` tracked exactly 740 files.
2. Its distinct `git clone --no-local` tracked the same 740 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 214 test files passed with five explicit skipped
   files (926 tests passed with thirty-three explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; and
   production build/layout plus five visual and two accessibility Electron
   journeys passed.

The normal candidate does not enable the opt-in external-peer suite. This is
local reproducibility and direct-source-reintroduction prevention only. It does
not provide a source-rights conclusion, independent protocol/security review,
design/trademark review, public migration or compatibility-removal, remote-CI,
owner-created repository, signing/notarization, authenticated-updater or
installed cross-platform evidence. IR-02, IR-03, IR-04 and IR-12 remain **In
progress**; IR-13 and IR-14 remain **Open**.

## Current P-08 final-public promotion-gate candidate

On 2026-09-22, `bun run candidate:check` was rerun after the final-public
command gained its source-promotion prerequisites. In addition to the approved
migration-removal record and final name/content snapshot, it now requires
current component/license inventories, reviewed dependency-attribution and
product-mark records, reviewed navigation/core records for the four retained
languages, and an active public privacy/security/support service record. The
normal migration-period check still validates truthful `pending` handoffs; the
new command rejects them rather than silently treating a valid template as an
approval. The snapshot deliberately precedes this evidence record, so this
explanatory update is not represented as a candidate input.

The deliberate pre-evidence source snapshot had 740 files, 15,352,257 bytes
and source-tree SHA-256
`047df9275e37c2128adcf9d6479aaef279140ca4582d0704d5fa85920f05c8e3`.
All snapshot-audit categories were empty: forbidden entries, environment files,
oversized files, symbolic links, transient artifacts, prohibited generated
files, high-confidence secrets and prohibited dependency markers.

1. A disposable local root commit
   `8d8173c7c07240a178b1ea7a7749063b5b2f8ae8` tracked exactly 740 files.
2. Its distinct `git clone --no-local` tracked the same 740 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation rebuilt macOS arm64 `node-pty`. The clone's complete
   `bun run check` passed: 214 test files passed with five explicit skipped
   files (926 tests passed with thirty-three explicit skips); the Level 1 gate
   covered 368 modules and 1,313 dependencies; Contract drift checked 267
   operations; source commercialization, component/license/SBOM, migration,
   release-service, four-catalog localization and snapshot checks passed; and
   production build/layout plus five visual and two accessibility Electron
   journeys passed.

The normal candidate does not enable the opt-in external-peer suite, and it
does not run `release:final-public:check` successfully because the migration,
review and public-service records deliberately remain pending. This is local
reproducibility and release-promotion-boundary evidence only. It does not
provide a source-rights conclusion, completed human review, independent
protocol/security review, design/trademark review, public migration or
compatibility-removal, remote-CI, owner-created repository, signing/notarization,
authenticated-updater or installed cross-platform evidence. IR-02, IR-03,
IR-04, IR-11 and IR-12 remain **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-08 sensitive-artifact snapshot candidate

On 2026-09-22, `bun run candidate:check` was rerun after the independent
snapshot audit began rejecting private-key containers, common SSH private-key
filenames, persistent database files and SQLite journal/WAL/SHM sidecars. The
report exposes only each finding's source-relative path and category, so the
audit does not echo candidate secret bytes into logs. The snapshot deliberately
precedes this evidence record, so this explanatory update is not represented as
a candidate input.

The deliberate pre-evidence source snapshot had 740 files, 15,385,386 bytes
and source-tree SHA-256
`bda22f6b004bad1f274e6867258b1f1c029756a6a84430a82a02020cb7f38971`.
All snapshot-audit categories were empty, including forbidden entries,
environment files, oversized files, symbolic links, transient artifacts,
prohibited generated files, high-confidence secrets, sensitive artifacts and
prohibited dependency markers.

1. A disposable local root commit
   `09cee12f4119e1789f9df827e0676c1fefcc290a` tracked exactly 740 files.
2. Its distinct `git clone --no-local` tracked the same 740 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation installed 609 packages and rebuilt macOS arm64
   `node-pty`. The clone's complete `bun run check` passed: 214 test files
   passed with five explicit skipped files (931 tests passed with thirty-three
   explicit skips); the Level 1 gate covered 368 modules and 1,313
   dependencies; Contract drift checked 267 operations; source
   commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; and production
   build/layout plus five visual and two accessibility Electron journeys
   passed.

The normal candidate does not run `release:final-public:check`, packaged-app,
DMG/ZIP installation, external-peer or independently operated-host suites;
those remain separately governed evidence. This is local source-snapshot and
fresh-clone reproducibility evidence only. It does not provide a source-rights
conclusion, completed human review, independent protocol/security review,
design/trademark review, public migration or compatibility-removal, remote-CI,
owner-created repository, signing/notarization, authenticated-updater or
installed Windows/Linux evidence. IR-02, IR-03, IR-04, IR-11 and IR-12 remain
**In progress**; IR-13 and IR-14 remain **Open**.

## Current P-08 aggregated final-public diagnostics candidate

On 2026-09-22, `bun run candidate:check` was rerun after the final-public
release command replaced its short-circuiting shell chain with a dedicated
orchestrator. A real current-worktree invocation now evaluates every promotion
prerequisite in one run, reports every failed gate, and runs the final source
snapshot only when all prerequisites pass. It truthfully reported six current
blockers—migration removal, dependency-attribution review, product-mark review,
navigation-catalog review, core-catalog review and active public services—and
explicitly skipped the final snapshot. Focused regressions cover complete
prerequisite evaluation, snapshot ordering, approved exception forwarding and
ambiguous-argument rejection. The snapshot deliberately precedes this evidence
record, so this explanatory update is not represented as a candidate input.

The deliberate pre-evidence source snapshot had 742 files, 15,399,502 bytes
and source-tree SHA-256
`01976c30a102ba7bef08ad3b4ed6a34eecfa135545b4a2918797af72aeec8228`.
All snapshot-audit categories were empty, including forbidden entries,
environment files, oversized files, symbolic links, transient artifacts,
prohibited generated files, high-confidence secrets, sensitive artifacts and
prohibited dependency markers.

1. A disposable local root commit
   `32c3d0038a57b3e051595aac767c369be1794b0b` tracked exactly 742 files.
2. Its distinct `git clone --no-local` tracked the same 742 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation installed 609 packages and rebuilt macOS arm64
   `node-pty`. The clone's complete `bun run check` passed: 215 test files
   passed with five explicit skipped files (934 tests passed with thirty-three
   explicit skips); the Level 1 gate covered 368 modules and 1,313
   dependencies; Contract drift checked 267 operations; source
   commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; and production
   build/layout plus five visual and two accessibility Electron journeys
   passed.

The normal candidate deliberately does not invoke the final-public command,
because the current migration-period records must remain valid while the
promotion records remain pending. The separate real invocation and unit tests
prove its current diagnostic behavior; they do not approve any of the six
reported owner/reviewer gates. The candidate also does not run packaged-app,
DMG/ZIP installation, external-peer or independently operated-host suites.
This is local source-gate and fresh-clone reproducibility evidence only, not a
source-rights conclusion, completed human review, public migration or
compatibility removal, remote CI, owner-created repository,
signing/notarization, authenticated updater or installed Windows/Linux
evidence. IR-02, IR-03, IR-04, IR-05, IR-07, IR-08, IR-09, IR-11 and IR-12
remain unaccepted; IR-13 and IR-14 remain **Open**.

## Current P-08 Windows/Linux real-installer gate candidate

On 2026-09-22, `bun run candidate:check` was rerun after the three-platform CI
stopped treating electron-builder's `linux-unpacked` and `win-unpacked`
directories as installation evidence. The Linux entry point now refuses to
replace a pre-existing package, installs exactly one amd64 DEB through APT,
checks the `/opt/Axterm` executable/version, runs the packaged suite under
1920×1080 Xvfb and removes only the package it installed. The Windows entry
point silently installs exactly one NSIS artifact into a generated,
path-validated runner-temporary directory, checks the executable/version and
sole uninstaller, runs the packaged suite from that installation, and cleans
only that directory. Static safety/routing regressions and Linux shell syntax
pass locally; neither platform installer was run on this macOS host. The
snapshot deliberately precedes this evidence record, so this explanatory
update is not represented as a candidate input.

The deliberate pre-evidence source snapshot had 745 files, 15,416,802 bytes
and source-tree SHA-256
`c8b0ca868bee06d903fae8a879a810114adcb51d54d42ceb4fbd75d1ebbab0fc`.
All snapshot-audit categories were empty, including forbidden entries,
environment files, oversized files, symbolic links, transient artifacts,
prohibited generated files, high-confidence secrets, sensitive artifacts and
prohibited dependency markers.

1. A disposable local root commit
   `24301f61017107e6572c76887679d0fd454219d0` tracked exactly 745 files.
2. Its distinct `git clone --no-local` tracked the same 745 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation installed 609 packages and rebuilt macOS arm64
   `node-pty`. The clone's complete `bun run check` passed: 216 test files
   passed with five explicit skipped files (937 tests passed with thirty-three
   explicit skips); the Level 1 gate covered 368 modules and 1,313
   dependencies; Contract drift checked 267 operations; source
   commercialization, component/license/SBOM, migration, release-service,
   four-catalog localization and snapshot checks passed; and production
   build/layout plus five visual and two accessibility Electron journeys
   passed.

This candidate proves that the installer gates, workflow routing, safety tests
and handoff documentation survive a fresh source-only Git clone. It does not
prove that the Linux DEB or Windows NSIS installer runs successfully; that
requires the corresponding real runner and retained artifact/log evidence. The
candidate also does not run the final-public, packaged/installed, external-peer
or independently operated-host suites. This is local source-gate readiness and
fresh-clone reproducibility evidence only, not source-rights review, public
migration, completed human review, remote CI, signing/notarization,
authenticated updater, installed Windows/Linux evidence or IR-12/IR-13/IR-14
acceptance. IR-12 remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-06 local-recovery and IR-12 source candidate

On 2026-09-22, the source Electron dual-format WebDAV journey was strengthened
from a no-change preview/commit into an observable recovery. After backing up
the legacy object and creating/uploading the isolated Axterm profile, its
loopback provider changes the remote Axterm appearance setting and recomputes
the category hash. The user-visible preview and explicit commit then restore
that changed setting into product SQLite while the old `/legacy-prototype/` object and
its write count remain unchanged. The focused current-worktree desktop journey
passed. The default candidate gate does not run the broader `desktop` project,
so that focused result is reported separately rather than attributed to the
clone. The snapshot deliberately precedes this evidence section, so this
explanatory update is not represented as candidate input.

The deliberate pre-evidence source snapshot had 746 files, 15,442,880 bytes
and source-tree SHA-256
`c8e52b546858a24d54d276d3c2f560beccf1c124540f1668849e9ba27b597d98`.
Every snapshot-audit category was empty, including forbidden entries,
environment files, oversized files, symbolic links, transient artifacts,
prohibited generated files, high-confidence secrets, sensitive artifacts and
prohibited dependency markers.

1. A disposable local root commit
   `49b44312f397a1ccd27fa0943ba244f9cca5e52d` tracked exactly 746 files.
2. Its distinct `git clone --no-local` tracked the same 746 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation installed 609 packages and rebuilt macOS arm64
   `node-pty`. The clone's complete `bun run check` passed 216 test files with
   five explicit skipped files (937 tests passed with thirty-three explicit
   skips), the 368-module / 1,313-dependency Level 1 gate, 267 Contract
   operations, commercialization/localization/license/SBOM/snapshot checks,
   production layout, and five visual plus two accessibility Electron journeys.

This adds local Axterm-format setting-recovery and fresh-clone reproducibility
evidence. It is not representative historical-data or collection recovery, a
live-provider test, a public migration release/window, an old installed-binary
upgrade, source-rights/human review, remote CI, final-public promotion, signing,
installed Windows/Linux evidence or an owner-created repository. IR-08 and
IR-12 remain **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-06 setting/bookmark-recovery and IR-12 source candidate

On 2026-09-22, the dual-format WebDAV journey was extended from one setting to
a representative linked collection. It creates and uploads a real SSH host and
bookmark, deletes both locally, changes the remote Axterm appearance setting,
then uses the user-visible preview and explicit commit to restore the setting,
host and SSH bookmark into product SQLite. The old `/legacy-prototype/` object and its
write count remain unchanged. The focused current-worktree desktop journey
passed. The default candidate gate does not run the broader `desktop` project,
so that result remains separately scoped. The snapshot deliberately precedes
this evidence section, so this explanatory update is not represented as
candidate input.

The deliberate pre-evidence source snapshot had 746 files, 15,452,442 bytes
and source-tree SHA-256
`d6cb2857696de4136ea7abce9fdcf0d2f20ed1f664dff811d89f43d1c2f7cd11`.
Every snapshot-audit category was empty, including forbidden entries,
environment files, oversized files, symbolic links, transient artifacts,
prohibited generated files, high-confidence secrets, sensitive artifacts and
prohibited dependency markers.

1. A disposable local root commit
   `2a948efd55672288dcfc8745a35db7c53770479a` tracked exactly 746 files.
2. Its distinct `git clone --no-local` tracked the same 746 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation installed 609 packages and rebuilt macOS arm64
   `node-pty`. The clone's complete `bun run check` passed 216 test files with
   five explicit skipped files (937 tests passed with thirty-three explicit
   skips), the 368-module / 1,313-dependency Level 1 gate, 267 Contract
   operations, commercialization/localization/license/SBOM/snapshot checks,
   production layout, and five visual plus two accessibility Electron journeys.

This adds local linked host/bookmark recovery and fresh-clone reproducibility
evidence. It is not representative coverage of every category or historical
format, a live-provider test, a public migration release/window, an old
installed-binary upgrade, source-rights/human review, remote CI, final-public
promotion, signing, installed Windows/Linux evidence or an owner-created
repository. IR-08 and IR-12 remain **In progress**; IR-13 and IR-14 remain
**Open**.

## Current P-06 Quick Command-recovery and IR-12 source candidate

On 2026-09-22, the dual-format WebDAV journey was extended to a second linked
collection. Before Electron starts, the production SQLite repository creates a
Quick Command folder and a two-step child command carrying user-authored
commands, delays, description, tags and input-only behavior. The product uploads
that category in its isolated Axterm document. After the SSH host/bookmark is
deleted through the product UI and the command/folder are deleted through the
same production repository boundary, the user-visible preview and explicit
commit restore the setting, host/bookmark and Quick Command tree. The assertion
requires the restored command to reference the newly generated folder ID and
retain both steps and metadata. The old `/legacy-prototype/` object and its write count
remain unchanged. The focused current-worktree desktop journey passed. The
default candidate gate does not run the broader `desktop` project, so that
result remains separately scoped. The snapshot deliberately precedes this
evidence section, so this explanatory update is not represented as candidate
input.

The deliberate pre-evidence source snapshot had 746 files, 15,463,826 bytes
and source-tree SHA-256
`be6bdb33cd9e49b0a1045541659d668b5e70f21473c52b0d0e5dd15df2edb7c7`.
Every snapshot-audit category was empty, including forbidden entries,
environment files, oversized files, symbolic links, transient artifacts,
prohibited generated files, high-confidence secrets, sensitive artifacts and
prohibited dependency markers.

1. A disposable local root commit
   `1dcb993efd4c80cd8887788155c3cd6d924b9382` tracked exactly 746 files.
2. Its distinct `git clone --no-local` tracked the same 746 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation installed 609 packages and rebuilt macOS arm64
   `node-pty`. The clone's complete `bun run check` passed 216 test files with
   five explicit skipped files (937 tests passed with thirty-three explicit
   skips), the 368-module / 1,313-dependency Level 1 gate, 267 Contract
   operations, commercialization/localization/license/SBOM/snapshot checks,
   production layout, and five visual plus two accessibility Electron journeys.

This adds local Axterm-format setting, linked host/bookmark and linked Quick
Command recovery plus fresh-clone reproducibility evidence. It is not coverage
of the remaining sync categories or historical formats, a live-provider test,
a public migration release/window, an old installed-binary upgrade,
source-rights/human review, remote CI, final-public promotion, signing,
installed Windows/Linux evidence or an owner-created repository. IR-08 and
IR-12 remain **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-06 custom-theme remap and IR-12 source candidate

On 2026-09-22, the same dual-format WebDAV journey was extended across the
`terminalThemes` and `settings` categories. Before Electron starts, the
production theme repository creates an Axterm custom theme and the settings
repository selects that source theme ID. The uploaded independent document must
contain the custom palette and the matching settings reference. Locally, the
test selects the built-in default and deletes the custom theme. The user-visible
preview and explicit commit must then recreate the theme under a different ID,
preserve the UI primary plus terminal foreground/background/cursor colors and
remap the restored terminal setting to that new ID. The old `/legacy-prototype/` object
and its write count remain unchanged. The focused current-worktree desktop
journey passed. The default candidate gate does not run the broader `desktop`
project, so that result remains separately scoped. The snapshot deliberately
precedes this evidence section, so this explanatory update is not represented
as candidate input.

The deliberate pre-evidence source snapshot had 746 files, 15,475,343 bytes
and source-tree SHA-256
`65736e3a2cbc0980f868aba1676c92aebcaad6241ece43a6da5d2dd6f648cfe9`.
Every snapshot-audit category was empty, including forbidden entries,
environment files, oversized files, symbolic links, transient artifacts,
prohibited generated files, high-confidence secrets, sensitive artifacts and
prohibited dependency markers.

1. A disposable local root commit
   `086edfe3cbccc85d63dd4d875282a5a24609bad5` tracked exactly 746 files.
2. Its distinct `git clone --no-local` tracked the same 746 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation installed 609 packages and rebuilt macOS arm64
   `node-pty`. The clone's complete `bun run check` passed 216 test files with
   five explicit skipped files (937 tests passed with thirty-three explicit
   skips), the 368-module / 1,313-dependency Level 1 gate, 267 Contract
   operations, commercialization/localization/license/SBOM/snapshot checks,
   production layout, and five visual plus two accessibility Electron journeys.

This adds local cross-category custom-theme/settings remapping plus
fresh-clone reproducibility evidence. It is not coverage of the remaining sync
categories or historical formats, a live-provider test, a public migration
release/window, an old installed-binary upgrade, source-rights/human review,
remote CI, final-public promotion, signing, installed Windows/Linux evidence or
an owner-created repository. IR-08 and IR-12 remain **In progress**; IR-13 and
IR-14 remain **Open**.

## Current P-06 Profile-reference recovery and IR-12 source candidate

On 2026-09-22, the dual-format WebDAV journey was extended across all three
Profile collections. Before Electron starts, the production repositories create
a connection Profile, a terminal Profile and a tunnel Profile. The SSH bookmark
references the connection and terminal Profiles, the portable default-terminal
setting references the terminal Profile, and the tunnel references the SSH Host.
The uploaded independent document must contain all three collections and their
source references. Locally, the fixture removes those records in dependency-safe
order and resets the default-terminal setting. The user-visible preview and
explicit commit must then recreate every Profile and the Host under new IDs,
remap the bookmark, setting and tunnel to the matching new IDs, preserve the
terminal values and environment, and keep all credential references null. The
old `/legacy-prototype/` object and its write count remain unchanged. The focused
current-worktree desktop journey passed. The default candidate gate does not run
the broader `desktop` project, so that result remains separately scoped. The
snapshot deliberately precedes this evidence section, so this explanatory
update is not represented as candidate input.

The deliberate pre-evidence source snapshot had 746 files, 15,492,019 bytes
and source-tree SHA-256
`0cd8a61e359a23d1d7c408f1c753bdaa4ead48c5d0c0015afc585d57cc615e22`.
Every snapshot-audit category was empty, including forbidden entries,
environment files, oversized files, symbolic links, transient artifacts,
prohibited generated files, high-confidence secrets, sensitive artifacts and
prohibited dependency markers.

1. A disposable local root commit
   `0e46f871dff0b122ebc24a53a0a088c48a32caba` tracked exactly 746 files.
2. Its distinct `git clone --no-local` tracked the same 746 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation installed 609 packages and rebuilt macOS arm64
   `node-pty`. The clone's complete `bun run check` passed 216 test files with
   five explicit skipped files (937 tests passed with thirty-three explicit
   skips), the 368-module / 1,313-dependency Level 1 gate, 267 Contract
   operations, commercialization/localization/license/SBOM/snapshot checks,
   production layout, and five visual plus two accessibility Electron journeys.

This adds local cross-collection Profile/Host/settings reference remapping plus
fresh-clone reproducibility evidence. It is not coverage of the remaining
address-bookmark/workspace/trigger categories or historical formats, a live
provider test, a public migration release/window, an old installed-binary
upgrade, source-rights/human review, remote CI, final-public promotion, signing,
installed Windows/Linux evidence or an owner-created repository. IR-08 and
IR-12 remain **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-06 eight-category recovery and IR-12 source candidate

On 2026-09-22, the dual-format WebDAV journey completed local recovery
coverage for all eight independent Axterm sync categories. In addition to the
existing linked Host/bookmark, Quick Command tree, custom theme and all three
Profile collections, the fixture now uploads a remote address bookmark, a
named/current workspace with a terminal tab and startup bookmark, and a global
cooldown trigger. Their references cross the Host, bookmark, terminal Profile
and custom-theme collections. Before download, the fixture deliberately clears
the address bookmark and workspace only from the remote `settings` category,
recomputes its hash and leaves the dedicated `addressBookmarks` and
`workspaces` categories intact. It also deletes the local trigger and resets the
local settings. Preview plus explicit commit must restore the dedicated
categories, remap every Host/bookmark/Profile/theme reference, preserve the
trigger's matching/action/cooldown fields under a new ID, and retain null
credential references. The old `/legacy-prototype/` object and its write count remain
unchanged. The focused current-worktree desktop journey passed. The default
candidate gate does not run the broader `desktop` project, so that result
remains separately scoped. The snapshot deliberately precedes this evidence
section, so this explanatory update is not represented as candidate input.

The deliberate pre-evidence source snapshot had 746 files, 15,511,811 bytes
and source-tree SHA-256
`9e0198e9880d7c2cda8a54546b3ede66f3567859d69c14abf981efb9488187b5`.
Every snapshot-audit category was empty, including forbidden entries,
environment files, oversized files, symbolic links, transient artifacts,
prohibited generated files, high-confidence secrets, sensitive artifacts and
prohibited dependency markers.

1. A disposable local root commit
   `32e4ed08fb41bc13e7e7c789c2003223033054be` tracked exactly 746 files.
2. Its distinct `git clone --no-local` tracked the same 746 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation installed 609 packages and rebuilt macOS arm64
   `node-pty`. The clone's complete `bun run check` passed 216 test files with
   five explicit skipped files (937 tests passed with thirty-three explicit
   skips), the 368-module / 1,313-dependency Level 1 gate, 267 Contract
   operations, commercialization/localization/license/SBOM/snapshot checks,
   production layout, and five visual plus two accessibility Electron journeys.

This completes local current-format recovery coverage for the eight Axterm
sync categories and adds fresh-clone reproducibility evidence. It is not
historical-format or old installed-binary recovery, a live-provider test, a
public migration release/window, source-rights/human review, remote CI,
final-public promotion, signing, installed Windows/Linux evidence or an
owner-created repository. IR-08 and IR-12 remain **In progress**; IR-13 and
IR-14 remain **Open**.

## Current P-06 packaged independent-recovery and IR-12 source candidate

On 2026-09-22, the copied-outside-checkout macOS arm64 packaged migration
journey was extended beyond the guarded backup action. The unsigned directory
app now saves the exact legacy WebDAV object, creates the separate Axterm
profile, uploads a plaintext independent document only below `/axterm/`, then
downloads a remotely changed appearance category after its uploaded Host has
been deleted locally. The packaged preview and explicit commit recreate that
Host under a new ID and apply the remote setting. The old `/legacy-prototype/` bytes
remain exact with two reads and zero writes, while the Axterm object receives
one upload and no download-side write. The focused packaged journey passed
against a 101,524,687-byte `app.asar` with SHA-256
`ecc1aa6ee4f949e4ace0bf3e852ffe5e2576706eef04c6c486f3c534d0dca8a1`.
Its save dialog is deterministically stubbed; this is not a native-dialog,
signed or installed-artifact claim. The default candidate gate below does not
run the broader `packaged` project, so that result remains separately scoped.
The snapshot deliberately precedes this evidence section, so this explanatory
update is not represented as candidate input.

The deliberate pre-evidence source snapshot had 746 files, 15,526,426 bytes
and source-tree SHA-256
`dd73ad42aa0982228ac562852ac5da93b8f0b40a2e663a6884c7e24f42ae167b`.
Every snapshot-audit category was empty, including forbidden entries,
environment files, oversized files, symbolic links, transient artifacts,
prohibited generated files, high-confidence secrets, sensitive artifacts and
prohibited dependency markers.

1. A disposable local root commit
   `7cee857023cf3af9e904894bbef142982cdd9dee` tracked exactly 746 files.
2. Its distinct `git clone --no-local` tracked the same 746 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation installed 609 packages and rebuilt macOS arm64
   `node-pty`. The clone's complete `bun run check` passed 216 test files with
   five explicit skipped files (937 tests passed with thirty-three explicit
   skips), the 368-module / 1,313-dependency Level 1 gate, 267 Contract
   operations, commercialization/localization/license/SBOM/snapshot checks,
   production layout, and five visual plus two accessibility Electron journeys.

This adds packaged macOS directory-app backup, isolated independent upload and
reviewed recovery evidence plus fresh-clone source reproducibility. It is not
historical-format or old installed-binary recovery, a live-provider test, a
public migration release/window, source-rights/human review, remote CI,
final-public promotion, signing, installed Windows/Linux evidence or an
owner-created repository. IR-08 and IR-12 remain **In progress**; IR-13 and
IR-14 remain **Open**.

## Current P-06 packaged encrypted-recovery and IR-12 source candidate

On 2026-09-22, the copied-outside-checkout macOS arm64 packaged migration
journey strengthened the preceding independent-recovery evidence with an
encrypted Axterm object. The legacy profile stores both its WebDAV access
password and sync-encryption password in the application-local Vault. The
guarded conversion inherits that local encryption reference without exporting
the secret, saves the exact legacy WebDAV object and uploads an
AES-256-GCM+scrypt envelope only below `/axterm/`. The remote bytes expose
neither the uploaded Host name/address nor the encryption password. The
fixture then deletes that Host locally, changes the portable appearance from
light to dark, and uses packaged preview plus explicit commit to decrypt the
same remote object, recreate the Host under a new ID and restore the light
setting. The old `/legacy-prototype/` bytes remain exact with two reads and zero writes,
while the Axterm object receives one encrypted upload and no download-side
write. The focused packaged journey passed against a 101,524,687-byte
`app.asar` with SHA-256
`ecc1aa6ee4f949e4ace0bf3e852ffe5e2576706eef04c6c486f3c534d0dca8a1`.
Its save dialog is deterministically stubbed; this is not a native-dialog,
signed or installed-artifact claim. The default candidate gate below does not
run the broader `packaged` project, so that result remains separately scoped.
The snapshot deliberately precedes this evidence section, so this explanatory
update is not represented as candidate input.

The deliberate pre-evidence source snapshot had 746 files, 15,535,080 bytes
and source-tree SHA-256
`ab6d0909f8509b286123b15a3327050840327cf0448da18e207a4ed57cc078b7`.
Every snapshot-audit category was empty, including forbidden entries,
environment files, oversized files, symbolic links, transient artifacts,
prohibited generated files, high-confidence secrets, sensitive artifacts and
prohibited dependency markers.

1. A disposable local root commit
   `0da5a66941e95e30ee8b5fb67fda828754e15a69` tracked exactly 746 files.
2. Its distinct `git clone --no-local` tracked the same 746 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation installed 609 packages and rebuilt macOS arm64
   `node-pty`. The clone's complete `bun run check` passed 216 test files with
   five explicit skipped files (937 tests passed with thirty-three explicit
   skips), the 368-module / 1,313-dependency Level 1 gate, 267 Contract
   operations, commercialization/localization/license/SBOM/snapshot checks,
   production layout, and five visual plus two accessibility Electron journeys.

This adds packaged macOS directory-app encrypted upload and reviewed
decryption/recovery evidence plus fresh-clone source reproducibility. It is not
historical-format or old installed-binary recovery, a live-provider test, a
public migration release/window, source-rights/human review, remote CI,
final-public promotion, signing, installed Windows/Linux evidence or an
owner-created repository. IR-08 and IR-12 remain **In progress**; IR-13 and
IR-14 remain **Open**.

## Current P-06 packaged encrypted eight-category recovery and IR-12 source candidate

On 2026-09-22, the copied-outside-checkout macOS arm64 packaged migration
journey extended encrypted recovery from one Host plus appearance to the full
current Axterm sync document. Before upload, the production repositories build
all eight categories: a linked SSH Host/bookmark, a two-step Quick Command tree,
a custom terminal theme, connection/terminal/tunnel Profiles, a linked address
bookmark, named/current workspace layouts and startup selection, a global
cooldown trigger and portable settings that reference those records. The
guarded conversion inherits the local encryption credential, saves the exact
legacy WebDAV object and uploads one AES-256-GCM+scrypt envelope only below
`/axterm/`; the remote bytes expose none of the representative Host, command,
theme, workspace, trigger or encryption-password values.

The fixture then clears every settings reference and deletes every source
record in dependency-safe order. Packaged preview plus explicit commit decrypts
the same object and restores all eight categories. Recreated Host, bookmark,
Quick Command tree, theme, all three Profile types and trigger receive new IDs.
The recovered bookmark, tunnel, default terminal selection, address bookmark,
current/named workspace layouts and startup selection point at the matching new
Host/bookmark/Profile/theme IDs; user-authored command steps and metadata,
profile values, theme palette and trigger semantics are preserved, and
credential references remain null. The old `/legacy-prototype/` bytes remain exact
with two reads and zero writes, while the Axterm object receives one encrypted
upload and no download-side write. The focused packaged journey passed against
a 101,524,687-byte `app.asar` with SHA-256
`ecc1aa6ee4f949e4ace0bf3e852ffe5e2576706eef04c6c486f3c534d0dca8a1`.
Its save dialog is deterministically stubbed; this is not a native-dialog,
signed or installed-artifact claim. The default candidate gate below does not
run the broader `packaged` project, so that result remains separately scoped.
The snapshot deliberately precedes this evidence section, so this explanatory
update is not represented as candidate input.

The deliberate pre-evidence source snapshot had 746 files, 15,563,610 bytes
and source-tree SHA-256
`d9bffaf962e6512161527eea4c18879c9b7623425481848ed676f7c5ac6c953e`.
Every snapshot-audit category was empty, including forbidden entries,
environment files, oversized files, symbolic links, transient artifacts,
prohibited generated files, high-confidence secrets, sensitive artifacts and
prohibited dependency markers.

1. A disposable local root commit
   `6e881f4f101d9d74684f17a7a5198de403382da7` tracked exactly 746 files.
2. Its distinct `git clone --no-local` tracked the same 746 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation installed 609 packages and rebuilt macOS arm64
   `node-pty`. The clone's complete `bun run check` passed 216 test files with
   five explicit skipped files (937 tests passed with thirty-three explicit
   skips), the 368-module / 1,313-dependency Level 1 gate, 267 Contract
   operations, commercialization/localization/license/SBOM/snapshot checks,
   production layout, and five visual plus two accessibility Electron journeys.

This completes current-format eight-category recovery coverage in both the
source Electron journey and the copied macOS directory app, while adding
encrypted packaged recovery and fresh-clone source reproducibility. It is not
historical-format or old installed-binary recovery, a live-provider test, a
public migration release/window, source-rights/human review, remote CI,
final-public promotion, signing, installed Windows/Linux evidence or an
owner-created repository. IR-08 and IR-12 remain **In progress**; IR-13 and
IR-14 remain **Open**.

## Current P-06 packaged all-provider non-overwrite and IR-12 source candidate

On 2026-09-22, the provider migration boundary was corrected for the first
Axterm upload into an existing legacy container. A GitHub or Gitee Gist that
contains `axterm-sync.json` but not `axterm-sync-v1.json` now reports the Axterm
target as uncreated instead of treating the Gist as an invalid Axterm document;
PATCH adds only the new file, leaving the old sibling exact. A named-file Custom
container now merges its old and new files into an ETag-guarded PUT. A raw
single-object Custom endpoint reports no Axterm target but rejects the later
Axterm save before any PUT, because the existing object cannot safely be
replaced. Focused provider tests cover both Gist variants, the named-file merge,
container ETag and the raw-object fail-closed path.

A fresh unsigned macOS arm64 directory app was copied outside the checkout and
driven through the production Settings UI against one loopback HTTP service.
The journey creates legacy GitHub Gist, Gitee Gist and Custom profiles, uses the
actual Bearer, token and HS256 JWT authentication forms, saves each old payload
byte-for-byte during guarded conversion, and performs the first Axterm upload
while only the legacy named file exists. Both Gists retain exact
`axterm-sync.json` while gaining `axterm-sync-v1.json`; the Custom request sends
the existing ETag and includes both exact named files. Together with the
separately rerun WebDAV encrypted eight-category journey, both focused packaged
tests passed. The tested `app.asar` is 101,527,864 bytes with SHA-256
`a627e04edbbc81137820f3347c37593cfbbca8858281a1464841b8cbfb7448f6`.
The save dialog is deterministically stubbed, and the providers are controlled
fixtures rather than live accounts. The default candidate gate below does not
run the broader `packaged` project, so those results remain separately scoped.
The snapshot deliberately precedes this evidence section, so this explanatory
update is not represented as candidate input.

The deliberate pre-evidence source snapshot had 746 files, 15,593,751 bytes
and source-tree SHA-256
`616cab1d3210ac7a33d4e4a1568cc70485b8cd4c471b67875a48a81769885550`.
Every snapshot-audit category was empty, including forbidden entries,
environment files, oversized files, symbolic links, transient artifacts,
prohibited generated files, high-confidence secrets, sensitive artifacts and
prohibited dependency markers.

1. A disposable local root commit
   `d837e24dd834a5e4ef9204b4a8bc3bb6595457a1` tracked exactly 746 files.
2. Its distinct `git clone --no-local` tracked the same 746 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation installed 609 packages and rebuilt macOS arm64
   `node-pty`. The clone's complete `bun run check` passed 216 test files with
   five explicit skipped files (940 tests passed with thirty-three explicit
   skips), the 368-module / 1,313-dependency Level 1 gate, 267 Contract
   operations, commercialization/localization/license/SBOM/snapshot checks,
   production layout, and five visual plus two accessibility Electron journeys.

This closes the controlled macOS directory-app non-overwrite gap for all four
built-in provider types and adds fresh-clone source reproducibility. It is not
live-provider behavior, historical-format or old installed-binary recovery, a
public migration release/window, source-rights/human review, remote CI,
native-dialog evidence, final-public promotion, signing, installed
Windows/Linux evidence or an owner-created repository. IR-08 and IR-12 remain
**In progress**; IR-13 and IR-14 remain **Open**.

## Current P-06 packaged all-provider reviewed recovery and IR-12 source candidate

On 2026-09-22, the copied-outside-checkout macOS arm64 GitHub Gist, Gitee Gist
and named-file Custom journey was extended beyond first-upload non-overwrite.
For each provider, the production Settings UI uploads the independent named
file with a light appearance setting, the fixture changes the local setting to
dark, and packaged download preview plus explicit commit restores the remote
light value. GitHub uses Bearer authentication, Gitee uses token authentication
and Custom uses a verified HS256 JWT. Each exact legacy `axterm-sync.json` and
new `axterm-sync-v1.json` remains unchanged through recovery, and each remote
container still records only its single Axterm upload. The separately rerun
WebDAV journey continues to cover encrypted recovery of all eight categories.
Both focused packaged tests passed against the same 101,527,864-byte `app.asar`
with SHA-256
`a627e04edbbc81137820f3347c37593cfbbca8858281a1464841b8cbfb7448f6`.
The save dialog is deterministically stubbed and the providers are controlled
fixtures, not live accounts. The default candidate gate below does not run the
broader `packaged` project, so those results remain separately scoped. The
snapshot deliberately precedes this evidence section, so this explanatory
update is not represented as candidate input.

The deliberate pre-evidence source snapshot had 746 files, 15,607,241 bytes
and source-tree SHA-256
`a27b04b9542fbdc93bf6d21d02c922f34680b9c7f5d83494d39f228cfd30d47e`.
Every snapshot-audit category was empty, including forbidden entries,
environment files, oversized files, symbolic links, transient artifacts,
prohibited generated files, high-confidence secrets, sensitive artifacts and
prohibited dependency markers.

1. A disposable local root commit
   `cbb002685dc376319baae5d09d7be0415696926e` tracked exactly 746 files.
2. Its distinct `git clone --no-local` tracked the same 746 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation installed 609 packages and rebuilt macOS arm64
   `node-pty`. The clone's complete `bun run check` passed 216 test files with
   five explicit skipped files (940 tests passed with thirty-three explicit
   skips), the 368-module / 1,313-dependency Level 1 gate, 267 Contract
   operations, commercialization/localization/license/SBOM/snapshot checks,
   production layout, and five visual plus two accessibility Electron journeys.

This closes controlled macOS directory-app reviewed current-format recovery for
all four built-in provider types and adds fresh-clone source reproducibility. It
is not live-provider behavior, historical-format or old installed-binary
recovery, a public migration release/window, source-rights/human review, remote
CI, native-dialog evidence, final-public promotion, signing, installed
Windows/Linux evidence or an owner-created repository. IR-08 and IR-12 remain
**In progress**; IR-13 and IR-14 remain **Open**.

## Current P-02 three-protocol Runtime-destruction and IR-12 source candidate

On 2026-09-22, the default XMODEM and TRZSZ protocol suites joined ZMODEM in
covering direct Runtime destruction after a selected receive has written
nonzero staging bytes. XMODEM accepts a valid CRC frame, ZMODEM receives from a
real `zmodem2` sender and TRZSZ receives from a real `trzsz2` transfer peer.
Each fixture calls the active session's `destroy()` while its peer or terminal
channel remains open, then requires inactive state, no published destination,
no hidden `.part` file and no file/session-completion event. The three focused
protocol files passed 31 tests together; the documentation regression raises
that focused run to 32 tests. This is source-level lifecycle evidence, not an
independently operated peer or installed-platform claim. The snapshot
deliberately precedes this evidence section, so this explanatory update is not
represented as candidate input.

The deliberate pre-evidence source snapshot had 746 files, 15,619,319 bytes
and source-tree SHA-256
`28de9a7f5f7fb874d3c96d1d0dbd6b25a9520aca5e68bc1939e565a179ceb08a`.
Every snapshot-audit category was empty, including forbidden entries,
environment files, oversized files, symbolic links, transient artifacts,
prohibited generated files, high-confidence secrets, sensitive artifacts and
prohibited dependency markers.

1. A disposable local root commit
   `cf9b0c059398edc83e44930becdab1d7e530b3d3` tracked exactly 746 files.
2. Its distinct `git clone --no-local` tracked the same 746 files and had no
   `.gitmodules`, submodule output, `vendor/legacy-prototype`, generated OpenAPI or
   external peer package; its status and staged/unstaged whitespace checks were
   empty before and after the complete gate.
3. Frozen installation installed 609 packages and rebuilt macOS arm64
   `node-pty`. The clone's complete `bun run check` passed 216 test files with
   five explicit skipped files (942 tests passed with thirty-three explicit
   skips), the 368-module / 1,313-dependency Level 1 gate, 267 Contract
   operations, commercialization/localization/license/SBOM/snapshot checks,
   production layout, and five visual plus two accessibility Electron journeys.

This closes the default source-suite Runtime-destruction symmetry gap for all
three terminal-transfer protocols and adds fresh-clone reproducibility. It is
not source-rights/human review, independently operated SSH, arbitrary external
peers, filesystem portability, signed/installed macOS/Windows/Linux evidence,
remote CI, final-public promotion or an owner-created repository. IR-03 and
IR-12 remain **In progress**; IR-13 and IR-14 remain **Open**.

## Current Linux x64 package-source snapshot

On 2026-09-22, a later independent source snapshot was used as the exact input
to the current Linux x64 package/install run. It had 748 files, 15,631,699
bytes and source-tree SHA-256
`78729c8a949c223363dc71fcb43685b4fe729250993837b814b3f622d81c3dcc`;
every snapshot-audit category was empty. The snapshot contained no `.git`,
`.gitmodules`, `vendor/legacy-prototype`, generated OpenAPI file, dependency tree or
release output. Frozen installation installed 612 packages, and production
build plus package-layout checks passed before electron-builder created the
Linux x64 AppImage and DEB.

The exact DEB then passed the installed-package gate in the digest-pinned
emulated `linux/amd64` environment: APT installed `/opt/Axterm`, version
`0.10.0` matched, and all 18 Linux-applicable packaged journeys passed with
seven declared Windows/optional-SSH skips. Exact artifact, sidecar and manifest
hashes are in
[IR-13 Linux installed-package evidence](IR13-LINUX-X64-INSTALL-ATTEMPT-2026-09-22.md).
This strengthens the audited-source-to-package chain, but it is not a fresh
owner-created remote Git repository, native Linux desktop, Windows install,
signed upgrade, final-public snapshot or human rights review. IR-12 remains
**In progress**; IR-13 and IR-14 remain **Open**.

## Current post-Linux-fix ephemeral Git candidate

After the Linux installed-package fixes and evidence synchronization, a fresh
`bun run candidate:check` completed on 2026-09-22. Its deliberate source
snapshot had 748 files, 15,638,233 bytes and tree SHA-256
`672c279d34f5656f3e3106adac21235909c802cfa9160627c68c284d4362ff81`;
all snapshot-audit categories were empty. Temporary root commit
`9db88a7e7245b671299256141c5f1f1698c9e492` and its distinct
`git clone --no-local` each tracked exactly 748 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, external peer package,
dependency tree or release output.

The clone's frozen installation installed 609 packages and rebuilt macOS arm64
`node-pty`. Its complete `bun run check` passed 217 test files with five
skipped files (947 tests with 33 skips), the 368-module / 1,313-dependency Level
1 architecture gate, 267 Contract operations, component/license/attribution/
SBOM/asset/migration/service and four-language gates, its own 748-file snapshot
audit, production build/layout, and five visual plus two accessibility Electron
journeys. The clone was clean and whitespace-clean before and after the gate,
and the candidate script removed its temporary working directories.

This is the current local fresh-clone reproducibility result. It does not
complete human rights/language/brand review, the public migration window,
remote CI, a native Windows/Linux desktop install, signing, an installed
binary-to-binary upgrade, final-public compatibility removal or an
owner-created repository. IR-12 remains **In progress**; IR-13 and IR-14 remain
**Open**.

## Current post-install artifact-integrity candidate

On 2026-09-22, `release:hashes:check` closed the local mutation window between
installed-app testing and CI artifact upload. The verifier regenerates the
complete platform/product release manifest from current distributable bytes
and rejects changed byte counts or SHA-256 values, a late or removed artifact,
duplicate paths, wrong product/platform/policy and extra or missing fields.
The three-platform workflow runs it after DMG/NSIS/DEB testing (and after the
Linux packaged SSH fixture) but before the first upload step. Focused tests
exercise a matching manifest, changed bytes, a late artifact and policy
tampering; the current local macOS manifest also passed against its actual DMG
and ZIP bytes.

The corresponding fresh `bun run candidate:check` source snapshot had 749
files, 15,662,813 bytes and tree SHA-256
`5155e617df187b638b2ddc556d5644f05f0c770056e87cebdd75b0125e7e350e`;
every snapshot-audit category was empty. Temporary root commit
`737613c1794c34ad4483a3ba538d332387f0bf2e` and its distinct
`git clone --no-local` each tracked exactly 749 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (950 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, all source/release hygiene checks,
production build/layout, and five visual plus two accessibility Electron
journeys; the candidate script then removed its temporary directories.

This is current local source/build-to-upload integrity and fresh-clone
reproducibility evidence. It does not verify bytes downloaded from a remote
artifact service, sign/notarize the artifacts, provide native Windows/Linux
results, complete a public upgrade, obtain human review or create the owner's
new repository. IR-12 remains **In progress**; IR-13 and IR-14 remain **Open**.

## Current uploaded-artifact round-trip candidate

On 2026-09-22, the three-platform workflow added a post-upload verification
boundary. After uploading the exact installer set and release hash manifest,
the same matrix job downloads those two named artifacts into a clean directory
with the immutable commit for `download-artifact` v4.3.0, runs
`release:hashes:check` against the downloaded bytes and writes a deterministic
`AXTERM_UPLOAD_ROUNDTRIP.<platform>.json` only on success. The receipt hashes
the downloaded manifest and records the verified product, platform, artifact
paths, byte counts and SHA-256 values. The verifier refuses to overwrite the
manifest or any verified artifact. Focused tests execute the receipt CLI,
exercise both overwrite refusals, require all three platform commands, lock
upload/download/check/receipt ordering and reject any unpinned external action.

The corresponding fresh `bun run candidate:check` source snapshot had 749
files, 15,675,516 bytes and tree SHA-256
`fd3de0afa692e3b5cdb7e10f099fcc113cabd6f94528fb439988b6e7f98131dc`;
every snapshot-audit category was empty. Temporary root commit
`f0ca5eb6796a603e35ffe6fbc80089fa64ff6d0b` and its distinct
`git clone --no-local` each tracked exactly 749 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (952 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, all source/release hygiene checks,
production build/layout, and five visual plus two accessibility Electron
journeys. The candidate script removed its temporary directories.

This proves that the workflow and receipt implementation reproduce from a
fresh local clone. It is not evidence that a remote GitHub Actions run completed
the upload/download round trip, does not verify the separately uploaded SPDX
sidecar or a public Release/CDN download, and does not sign/notarize artifacts,
provide native Windows/Linux results, complete a public upgrade, obtain human
review or create the owner's new repository. IR-12 remains **In progress**;
IR-13 and IR-14 remain **Open**.

## Current still-open-channel staging-loss candidate

On 2026-09-22, the XMODEM, ZMODEM and TRZSZ source protocol suites added a
common selected-destination failure boundary. Each regression first writes
nonzero bytes to its hidden same-directory staging file. While the already-open
file, terminal channel and protocol peer remain active, the POSIX test removes
that staging pathname and resumes protocol traffic. XMODEM accepts another CRC
block before EOT; real in-process `zmodem2` and `trzsz2` peers resume their
remaining bytes. Each adapter must fail final publication, emit its error/end
events, signal cancellation to the peer, become inactive and leave neither a
final file nor a staging pathname. The three focused protocol files pass 34
tests. This is intentionally scoped to staging namespace/finalization loss; it
does not claim disk-full/write-permission or Windows unlink behavior.

The corresponding fresh `bun run candidate:check` source snapshot had 749
files, 15,687,694 bytes and tree SHA-256
`afaba883048e1bbf47743b98afdc8bfd34a94833d4e55a0e5df4ffe06bfa579a`;
every snapshot-audit category was empty. Temporary root commit
`f39df5eb10e983747c5dc10f34a2e14360d62b55` and its distinct
`git clone --no-local` each tracked exactly 749 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (955 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, all source/release hygiene checks,
production build/layout, and five visual plus two accessibility Electron
journeys. The candidate script removed its temporary directories.

This is local failure-cleanup and fresh-clone reproducibility evidence. It does
not establish source rights, an independently operated host, native Windows or
Linux installed-package behavior, remote CI, signed distribution, the public
migration/removal window or an owner-created repository. IR-03 and IR-12 remain
**In progress**; IR-13 and IR-14 remain **Open**.

## Current P-03 FTP filesystem-identity candidate

On 2026-09-22, the independent Local FTP Widget narrowed two filesystem
mutation races. `STOR` now creates an inaccessible root-anchored UUID staging
file, revalidates the canonical destination and its parent `dev`/`ino` identity
before publication, and removes the partial if a held-open transfer's nested
destination is exchanged. `RNFR` records its canonical source identity and
`RNTO` refuses to move a replacement at the same pathname. The focused server
and documentation files pass 16 tests; the detailed scope and residual
path-based rename interval are recorded in the IR-04 filesystem-identity
evidence.

The corresponding fresh `bun run candidate:check` source snapshot had 750
files, 15,705,225 bytes and tree SHA-256
`6d3a2cbecb2a2921fb4c8fc3a5d57a800f4625d113b9c9b9cd3cb3223595f83f`;
every snapshot-audit category was empty. Temporary root commit
`26b8c13fa1232b36ff5a736103dc2f9443e2b419` and its distinct
`git clone --no-local` each tracked exactly 750 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (957 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, all source/release hygiene checks,
production build/layout, and five visual plus two accessibility Electron
journeys. The candidate script removed its temporary directories.

This proves local filesystem-mutation hardening and clean-clone reproducibility.
It does not provide the independent FTP security/source-rights review,
Windows/native-Linux installed evidence, remote CI, signed distribution, public
migration/removal or owner-created repository. IR-04 and IR-12 remain **In
progress**; IR-13 and IR-14 remain **Open**.

## Current P-03 FTP REST STREAM candidate

On 2026-09-22, the Local FTP Widget added the RFC 3659 `REST STREAM` feature
declaration and made a marker single-use for the immediately following transfer
attempt. Failed, syntactically invalid or badly positioned state no longer
changes a later transfer. Resumed `STOR` now streams the retained prefix and new
remainder into private root-anchored staging, validates the original file and
destination parent identities, and atomically publishes only if they remain
unchanged. The focused server and documentation files pass 18 tests, including
raw resumed `RETR`/`STOR`, rejection recovery and held-open source replacement.

The corresponding fresh `bun run candidate:check` source snapshot had 751
files, 15,726,520 bytes and tree SHA-256
`75521c0b29cc3d40e90bdda600374b51d0b4289207c1934427e490ff07f3755a`;
every snapshot-audit category was empty. Temporary root commit
`c302a43c31ac55ed2688348dc282ff34de19da22` and its distinct
`git clone --no-local` each tracked exactly 751 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (959 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, all source/release hygiene checks,
production build/layout, and five visual plus two accessibility Electron
journeys. The candidate script removed its temporary directories.

This proves local protocol-state/atomic-publication hardening and clean-clone
reproducibility. It does not provide independent protocol/security/source-
rights review, Windows/native-Linux installed evidence, remote CI, signed
distribution, public migration/removal or owner-created repository. IR-04 and
IR-12 remain **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-03 FTP feature and rename-sequence candidate

On 2026-09-22, the Local FTP Widget aligned two more control-protocol
boundaries with the public specifications. Its `FEAT` response now contains the
mandatory one-space-indented `MDTM` and `SIZE` lines for those implemented
commands. Every command other than `RNTO` clears a prior `RNFR` selection, so
an intervening `NOOP` produces `503` at the later `RNTO`; a new immediately
adjacent pair still renames the byte-exact file and keeps the authenticated
session usable. The focused server and documentation files pass 19 tests.

The corresponding fresh `bun run candidate:check` source snapshot had 752
files, 15,739,512 bytes and tree SHA-256
`60792bf2057c2e76a7be3ad12f03822b4086a0b4a6e2a6bd7f0fd6e68e56276e`;
every snapshot-audit category was empty. Temporary root commit
`36c7bb3cd10286c1d7b861db89e3c4b255af91e2` and its distinct
`git clone --no-local` each tracked exactly 752 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (960 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, all source/release hygiene checks,
production build/layout, and five visual plus two accessibility Electron
journeys. The candidate script removed its temporary directories.

This proves local control-sequence/feature-advertisement hardening and clean-
clone reproducibility. It does not provide independent protocol/security/source-
rights review, Windows/native-Linux installed evidence, remote CI, signed
distribution, public migration/removal or owner-created repository. IR-04 and
IR-12 remain **In progress**; IR-13 and IR-14 remain **Open**.

## Current P-06 legacy field-loss-reporting candidate

On 2026-09-22, the migration-period legacy importer replaced fixed Group,
Profile and Quick Command field lists with reports derived from the actual
conversion rules. Nested protocol paths, unknown properties and partial
step/tag rejection are now visible without exposing secret values; preview and
commit share the bounded Quick Command conversion. Eight Application tests and
the documentation regression passed together, while a separately focused
production Electron File Grant journey displayed representative group, Profile
and Quick Command omissions before commit. The default suite retains its
10-second per-test/hook limits and caps Vitest at two workers after repeated
higher-concurrency full runs contended on loopback/PTY startup; no test was
skipped and no timeout was extended.

The corresponding fresh `bun run candidate:check` source snapshot had 753
files, 15,763,557 bytes and tree SHA-256
`8342f5b137bbb8d3a89de044f37a200b0f73c22bdef857b2e29f47c76354ef92`;
every snapshot-audit category was empty. Temporary root commit
`623416e58a98e377577d7419ea3112b3c6db2f62` and its distinct
`git clone --no-local` each tracked exactly 753 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (961 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, all source/release hygiene checks,
production build/layout, and five visual plus two accessibility Electron
journeys. The candidate script removed its temporary directories.

This proves synthetic legacy-field reporting and clean-clone reproducibility.
It does not provide actual old-release/historical-format recovery, a public
migration window, human review, remote CI, signed/installed Windows or native-
Linux evidence, or an owner-created repository. IR-08 and IR-12 remain **In
progress**; IR-09, IR-13 and IR-14 remain **Open**.

## Current P-06 legacy batch-workflow candidate

On 2026-09-22, the migration-period `--batch-op` translator began returning
the actual unsupported and shadowed source paths alongside its mapped Axterm
request. Field names are bounded and control-character-sanitized; values and
inline credentials are not returned. A shared synthetic workflow now drives
unit, source Electron and copied unsigned macOS arm64 directory-app checks.
The source second-instance journey also found and closed a lost-wakeup race by
latching an event that arrives while the previous deep-link drain is active.
The focused parser passes four tests, the second-instance source journey passed
three consecutive runs, and the focused packaged migration journey passed
three consecutive runs after current-session layout persistence was blocked
from a setting-enabled import through the required restart. The recorded final
package is a 101,540,201-byte `app.asar` with SHA-256
`def175cc7f9995102b6e4536be2379e8ceedab07f0b8ac2f220c44bb4e34c5d4`.

The corresponding fresh `bun run candidate:check` source snapshot had 755
files, 15,797,670 bytes and tree SHA-256
`a6e0f1062276ea489943236952d09454df0df24f4c984cd29c6a1f64c64acac0`;
every snapshot-audit category was empty. Temporary root commit
`cda5ad67740d3dfc0b82cc0415fd4401b07d490e` and its distinct
`git clone --no-local` each tracked exactly 755 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (963 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, the four-catalog/2,544-key
localization gate, all source/release hygiene checks, production build/layout,
and five visual plus two accessibility Electron journeys. The candidate script
removed its temporary directories.

This proves current synthetic workflow reporting and clean-clone
reproducibility. It does not provide a genuine old-release workflow, a public
migration window, human review, remote CI, signed/installed Windows or native-
Linux evidence, or an owner-created repository. IR-08 and IR-12 remain **In
progress**; IR-09, IR-13 and IR-14 remain **Open**.

## Current P-07 Host-dialog decoupling candidate

On 2026-09-23, the Add SSH host editor stopped embedding a second full-window
settings workspace. The duplicate shell tabs, bookmark directory,
toolbar/search/tree, protocol heading and obsolete responsive CSS were removed.
The centered Axterm dialog retains nine protocol choices, group creation, six
keyboard-operable tabs and the real advanced SSH controls. Four catalogs now
contain the new protocol/field/accessibility copy (2,558 keys each), and the
source visual regression adds a ninth macOS image. Focused source tests cover
ordinary and 200% layouts, mint checkbox rendering, accessibility and the
complete protocol/group workflow. A copied unsigned macOS arm64 directory app
passed the corresponding Phase 12 absence, bounds, focus-restoration and mint
assertions; its 101,535,430-byte `app.asar` has SHA-256
`71737e0db4380139d06bdc15fcf0a6696c55ac700190430b70e4412dff0d6297`.
The complete current packaged suite passed 16 macOS-applicable journeys, with
nine explicit Windows/Linux or optional SSH-fixture skips.

The corresponding fresh `bun run candidate:check` deliberate pre-evidence
snapshot had 756 files, 15,939,636 bytes and tree SHA-256
`6c62c3fcde2738b46ab5e2292d9c672bd4cb7f75ac5ae8492b84c28b33163664`;
every snapshot-audit category was empty. Temporary root commit
`dea6eafd9f7639a31c559c32be0c1f62bcdf6f04` and its distinct
`git clone --no-local` each tracked exactly 756 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (963 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, the four-catalog / 2,558-key
localization gate, all source/release hygiene checks, production build/layout,
five visual journeys covering nine macOS images and two accessibility Electron
journeys. The candidate script removed its temporary directories.

This proves local Host-dialog decoupling and clean-clone reproducibility. It
does not provide human design/trademark/source-rights approval, remote CI,
signed/installed Windows or native-Linux evidence, public migration/removal or
an owner-created repository. IR-10 and IR-12 remain **In progress**; IR-13 and
IR-14 remain **Open**.

## Current P-04/P-07 connection-configuration decoupling candidate

On 2026-09-23, the Simplified Chinese connection-configuration workspace
stopped mixing the English `Profile` noun into its title, description, search,
empty state, form/actions, Host selector, credential guidance and sync
category. The component no longer hard-codes `Profiles`; its non-persisted
`ID: PROFILE0` parity display was deleted, and the Axterm-owned page title and
explanation are visible again. The existing four-language core scope remains
2,558 keys. Focused unit and functional Electron tests pass, an inspected tenth
macOS source baseline covers the 1280×800 page, and a separate 200% zoom journey
reaches the name field, final protocol tab and save action without horizontal
document overflow. The complete source visual/accessibility gate passes six
visual plus two accessibility journeys. A copied unsigned macOS arm64 directory
app passed all 16 applicable package journeys, with nine explicit
Windows/Linux or optional SSH-fixture skips, and recorded the inspected
`phase12-connection-configuration.png`. Its 101,535,302-byte `app.asar` has
SHA-256
`ff639dd259739c64fbcb940fe44fd910b439c52696353543fe63fec4ad6e86c2`.

The corresponding fresh `bun run candidate:check` deliberate pre-evidence
snapshot had 757 files, 16,012,139 bytes and tree SHA-256
`527eadd01cf6337e1a9ad540fcf91cb223f3e74317ab34f2cab4875aae741c28`;
every snapshot-audit category was empty. Temporary root commit
`c9ec5c485a64b5959365899eaa22348cde9ce117` and its distinct
`git clone --no-local` each tracked exactly 757 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (964 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, the four-catalog / 2,558-key
localization gate, all source/release hygiene checks, production build/layout,
six visual journeys covering ten macOS images and two accessibility Electron
journeys. The candidate script removed its temporary directories.

This proves local copy/layout decoupling and clean-clone reproducibility. It
does not provide human language/design/trademark/source-rights approval, remote
CI, signed/installed Windows or native-Linux evidence, public
migration/removal or an owner-created repository. IR-10 and IR-12 remain **In
progress**; IR-13 and IR-14 remain **Open**.

## Current P-07 shared protocol-editor decoupling candidate

On 2026-09-23, the FTP/FTPS, Telnet, Serial, RDP, VNC, SPICE and Web bookmark
forms stopped relying on the narrow generic modal unchanged. They now share an
explicit Axterm-owned 820 px surface, mint semantic chrome, two-column fields
and options, sticky actions, protocol identity and deterministic name-field
focus. RDP is the densest representative: the inspected eleventh macOS source
baseline covers its 1280×800 state, and the 200% journey requires a one-column
720×450 CSS layout with the desktop-size and save-and-connect controls still
reachable and no document horizontal overflow. Its save/edit/Vault functional
test and expanded keyboard/screen-reader journey pass. A copied unsigned macOS
arm64 Phase 12 app records the inspected `phase12-rdp-dialog.png` and passes the
same width, focus, mint and action checks; its 101,538,816-byte `app.asar` has
SHA-256
`119152a22da8ac994f59f68967e2b26a5979771b4858718f37f1e19422f69f58`.

The corresponding fresh `bun run candidate:check` deliberate pre-evidence
snapshot had 758 files, 16,127,388 bytes and tree SHA-256
`e376c562c8e1ee4e1cd5a0d848f422455b7543e495aef108b9732ed715a56647`;
every snapshot-audit category was empty. Temporary root commit
`ea5f0ac8275f76729406c6c6b244fdecc95122d2` and its distinct
`git clone --no-local` each tracked exactly 758 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (964 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, the four-catalog / 2,558-key
localization gate, all source/release hygiene checks, production build/layout,
six visual journeys covering eleven macOS images and two accessibility Electron
journeys. The candidate script removed its temporary directories.

This proves local shared-dialog decoupling and clean-clone reproducibility. It
does not provide human design/trademark/source-rights approval, remote CI,
signed/installed Windows or native-Linux evidence, public migration/removal or
an owner-created repository. IR-10 and IR-12 remain **In progress**; IR-13 and
IR-14 remain **Open**.

## Current P-04/P-07 SSH-interaction localization candidate

On 2026-09-23, Unknown/Changed Host Key and keyboard-interactive requests
stopped carrying Runtime-authored Simplified Chinese presentation strings.
They now cross the Contract as structured, language-neutral data while the four
Renderer catalogs own titles, summaries, labels, warnings, confirmations and
actions. The core scope was 2,573 keys per locale for this superseded candidate. A real loopback SSH Electron
regression switches fresh English, Japanese, Simplified Chinese and Traditional
Chinese profiles and verifies the actual Unknown Host Key target, algorithm,
SHA256 fingerprint, remember control and safe Reject autofocus. Its changed-key
case verifies the high-risk surface, old/new fingerprints, unchecked required
acknowledgement and blocked destructive action. Focused Runtime, provenance,
localization and Electron tests pass.

The corresponding fresh `bun run candidate:check` deliberate pre-evidence
snapshot had 758 files, 16,161,718 bytes and tree SHA-256
`a3d4797dbaf69eafa57d3ee5270704228569175410162d66e6b0b6e386f3cf4c`;
every snapshot-audit category was empty. Temporary root commit
`67b125482dc8869a2b69ac228699041ad9f7b84c` and its distinct
`git clone --no-local` each tracked exactly 758 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (964 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, the then-current four-catalog / 2,573-key
localization gate, all source/release hygiene checks, production build/layout,
six visual journeys covering eleven macOS images and two accessibility Electron
journeys. The candidate script removed its temporary directories.

This proves local SSH-interaction presentation decoupling and clean-clone
reproducibility. It does not provide human language/design/trademark/source-
rights approval, packaged/cross-platform Host Key evidence, remote CI,
signed/installed Windows or native-Linux evidence, public migration/removal or
an owner-created repository. IR-05, IR-10 and IR-12 remain **In progress**;
IR-13 and IR-14 remain **Open**.

## Current P-04/P-07 packaged SSH Host Key candidate

On 2026-09-23, the SSH Host Key regression was extended from the source app to
a copied unsigned macOS arm64 directory app. It opens the real Unknown Host Key
interaction under English, Japanese, Simplified Chinese and Traditional
Chinese, verifies the actual target, algorithm and SHA256 fingerprint, and
keeps Reject as the safe autofocus action. The packaged run exposed the SSH
adapter's former hard-coded `ssh` Algorithm value; the adapter now decodes the
algorithm from the SSH public-key blob and reports `ecdsa-sha2-nistp256` for
the fixture. The Changed Host Key path shows the old and presented
fingerprints, keeps its acknowledgement unchecked, blocks replacement and
renders its missing-confirmation error from the selected application catalog
instead of Chromium's host-language validation bubble. The four catalogs now
contain 2,574 keys. Focused source, adapter and packaged tests pass, and the
complete packaged suite passes 17 macOS-applicable journeys with nine explicit
platform/optional-fixture skips. The tested 101,554,061-byte `app.asar` has
SHA-256
`0e7335790df5c3a496f6d59ee56a832425c0db45ffc2b59b4049f9399faa3110`.

The corresponding fresh `bun run candidate:check` deliberate pre-evidence
snapshot had 758 files, 16,183,445 bytes and tree SHA-256
`4c34d34b63671063dd42688b2a6957f9a15a520d94457619bb89a2676acb4afb`;
every snapshot-audit category was empty. Temporary root commit
`6addbac5b887c6dda0fa471e103e55a62acd5b3c` and its distinct
`git clone --no-local` each tracked exactly 758 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (965 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, the four-catalog / 2,574-key
localization gate, all source/release hygiene checks, production build/layout,
six visual journeys covering eleven macOS images and two accessibility
Electron journeys. The candidate script removed its temporary directories.

This proves local packaged Host Key behavior and clean-clone reproducibility.
It does not provide human language/design/trademark/source-rights approval,
remote CI, signed installation, Windows/native-Linux evidence, public
migration/removal or an owner-created repository. IR-05, IR-10 and IR-12 remain
**In progress**; IR-13 and IR-14 remain **Open**.

## Current P-07 session-launch empty-state candidate

On 2026-09-23, the early split-pane empty surface was replaced by an
Axterm-owned session-launch hierarchy. The decorative frequency-sort switch,
which had no product behavior, was deleted together with its now-unused
`sortByFrequency` entry in all four navigation sources, the generated catalog
and the pending-review ledger. The catalog now contains exactly 44 used keys.
The surface uses no product-name oval/logo; it presents a mint terminal glyph,
one mint primary local-terminal action, three secondary connection actions and
a visible existing-session selector.

The production Electron visual project checks the four-pane layout at
1280×800, 1440×900 and 1920×1080, verifies all controls remain inside their
pane, reads the mint/on-primary computed colors and starts a terminal from the
keyboard. The three inspected additions raise the source baseline to fourteen
macOS images. A separately rebuilt unsigned macOS arm64 directory app passed
the focused Phase 12 journey and recorded `phase12-empty-pane.png`; its
101,554,888-byte `app.asar` has SHA-256
`942c1bfa1bf049841db90c14bf8362c7fcccc9645e6af30926073739219d8145`.

The corresponding fresh `bun run candidate:check` deliberate pre-evidence
snapshot had 761 files, 16,381,308 bytes and tree SHA-256
`10a9fbc16be11716790bb2049ef0aa30ed686fd6d95a4927550aed1d3fe45565`;
every snapshot-audit category was empty. Temporary root commit
`167b23d4e11e35bf9e9fcb4085e3fadb5f34908a` and its distinct
`git clone --no-local` each tracked exactly 761 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (965 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, four catalogs with 44/44 live
navigation and 2,574/2,574 core keys, all source/release hygiene checks,
production build/layout, seven visual journeys covering fourteen macOS source
images and two accessibility journeys. The candidate script removed its
temporary directories.

This proves local empty-state implementation/package behavior and clean-clone
reproducibility. It does not provide human design/trademark/source-rights
approval, remote CI, signed installation, Windows/native-Linux evidence,
public migration/removal or an owner-created repository. IR-10 and IR-12 remain
**In progress**; IR-13 and IR-14 remain **Open**.

## Current P-06 historical-source package upgrade candidate

On 2026-09-23, P-06 added an opt-in packaged journey that accepts a preserved
historical package through `AXTERM_PREVIOUS_PACKAGED_APP`, creates data through
that package's real UI and launches the current package against the same
user-data directory. The executed macOS arm64 case rebuilt exact historical
commit `657b3cc1552cd3b0dc3b0f73df1c1a4a5a8a6a6e`, then proved its
migration-33 database and application-local Vault crossed current migrations
34–38 without losing the SSH Host/Bookmark, Quick Command, credential reference
or decryptable synthetic password. The migration-34 rollback copy was
byte-identical to the closed historical database. The focused journey passed;
its exact app, database, screenshot and JSON hashes are recorded in
[IR-08 historical package evidence](IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23.md).

The corresponding fresh `bun run candidate:check` deliberate pre-evidence
snapshot had 762 files, 16,408,469 bytes and tree SHA-256
`aa03b105fc33f3769d80d9807564a64f6b675debcb6b1f5d0e38d74ffadf740b`;
every snapshot-audit category was empty. Temporary root commit
`cbb370612683a48acc0427b44705e0a251089a64` and its distinct
`git clone --no-local` each tracked exactly 762 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (966 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, four catalogs with 44/44 live
navigation and 2,574/2,574 core keys, all source/release hygiene checks,
production build/layout, seven visual journeys covering fourteen macOS source
images and two accessibility journeys. The candidate script removed its
temporary directories.

This proves the new historical-source upgrade gate and its limitations survive
a no-submodule clean clone. It does not make the historical package an archived
signed/public installer, prove a version-number change, start a public migration
window, supply Windows/native-Linux installed upgrades, complete human rights
review or create the owner's final repository. IR-08 and IR-12 remain **In
progress**; IR-09, IR-13 and IR-14 remain **Open**.

## Current P-05/P-06 historical-theme upgrade candidate

On 2026-09-23, the historical-source packaged journey was extended to make the
old application select its removed `3024 Day` (`…0003`) built-in through the
real Theme workspace before closing. Read-only inspection requires the old
migration-33 database and its automatic pre-migration-34 rollback copy to retain
that ID. The current package must migrate the live setting to the stable mint
Axterm `Default` (`…0001`), render that selection in the four-entry independent
catalog and apply its `#0d1d1a` terminal background. The focused macOS arm64
journey passed one of one; exact artifact, screenshot, database and evidence-JSON
hashes are recorded in
[IR-08 historical package evidence](IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23.md).

The corresponding fresh `bun run candidate:check` deliberate pre-evidence
snapshot had 762 files, 16,418,287 bytes and tree SHA-256
`592215ff4b82ba2de70dcd27770af7b0f3c9d4fbc4564e69160565ca1e5681d1`;
every snapshot-audit category was empty. Temporary root commit
`91eab559af98e081728edcbf1e3ac5d8abc6263d` and its distinct
`git clone --no-local` each tracked exactly 762 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (966 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, four catalogs with 44/44 live
navigation and 2,574/2,574 core keys, all source/release hygiene checks,
production build/layout, seven visual journeys covering fourteen macOS source
images and two accessibility journeys. The candidate script removed its
temporary directories.

This proves the exact historical-source theme-selection fallback and the new
gate survive a no-submodule clean clone. It does not make the rebuilt old
package an archived signed/public installer, prove a version-number change,
start a public migration window, supply Windows/native-Linux installed upgrades,
complete human rights review or create the owner's final repository. IR-05,
IR-08 and IR-12 remain **In progress**; IR-09, IR-13 and IR-14 remain **Open**.

## Current P-05/P-06 historical-theme and sync-profile upgrade candidate

On 2026-09-23, the historical-source packaged journey was extended again so the
old application's real UI selects removed built-in `3024 Day` and creates an
encrypted WebDAV profile with distinct access and encryption credentials.
Read-only inspection requires the old migration-33 database and the automatic
pre-migration-34 rollback copy to retain the old theme ID, profile fields and
both sync credential references. The current package must map the theme to
Axterm `Default`, mark the retained profile as `legacy-legacy-prototype-v1`, render saved
local-Vault placeholders for both credential fields and round-trip all three
Vault credentials (SSH, WebDAV access and sync encryption). None of their
plaintext values may appear in SQLite. The focused macOS arm64 journey passed
one of one in 7.1 seconds; exact application, database, screenshot and
evidence-JSON hashes are recorded in
[IR-08 historical package evidence](IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23.md).

The corresponding fresh `bun run candidate:check` deliberate pre-evidence
snapshot had 762 files, 16,432,722 bytes and tree SHA-256
`53a12a7c5f32d30fbc96523a36c4080b8722c7de4030e673ed8a0d2f0d2f23ae`;
every snapshot-audit category was empty. Temporary root commit
`026414392ac3153d2ed1bac439fd49c527ea0867` and its distinct
`git clone --no-local` each tracked exactly 762 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (966 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, four catalogs with 44/44 live
navigation and 2,574/2,574 core keys, all source/release hygiene checks,
production build/layout, seven visual journeys covering fourteen macOS source
images and two accessibility journeys. The candidate script removed its
temporary directories.

This proves that the exact historical-source theme fallback and saved local
sync-profile/Vault migration survive a no-submodule clean clone. It does not
recover a historical remote sync document, make the rebuilt old package an
archived signed/public installer, prove a version-number change, start a public
migration window, supply Windows/native-Linux installed upgrades, complete
human rights review or create the owner's final repository. IR-05, IR-08 and
IR-12 remain **In progress**; IR-09, IR-13 and IR-14 remain **Open**.

## Current P-06 historical encrypted/plaintext remote-recovery candidate

On 2026-09-23, the historical-source macOS arm64 packaged journey was extended
through actual controlled encrypted and plaintext remote round trips. The old
application's production Settings UI saved a legacy WebDAV profile with
distinct access and encryption credentials and uploaded both documents to a
controlled loopback server. The 8,869-byte AES-256-GCM+scrypt envelope had
SHA-256 `a43d5bc9dbcbde23c66123f3a066e75483348f5a6ca278d0006e0cdcc0347a58`;
the 6,568-byte plaintext version-1 envelope had SHA-256
`1a7ef3993f6a8a0764a18e3a27930bae48e3cf1d8fc764b724b1da1dcb136008`.
Neither object exposed the SSH, WebDAV access or sync-encryption secrets. After
the current package upgraded the old data and Vault, separate recovery passes
deleted the migrated Quick Command and changed the local appearance setting.
The current package then read the matching old remote object, presented the
legacy preview and restored both values only after explicit commit. Each object
recorded three authenticated reads and exactly one write from the old package;
recovery performed no write and both remote byte sequences remained identical.
The focused journey passed one of one in 10.9 seconds. Exact application,
database and screenshot hashes are recorded in
[IR-08 historical package evidence](IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23.md).

The corresponding fresh `bun run candidate:check` deliberate pre-evidence
snapshot had 762 files, 16,460,925 bytes and tree SHA-256
`96be2ab858eb7fe11a79a04493d9f2b6c0926b44de4d8f577866fe93f823af09`;
every snapshot-audit category was empty. Temporary root commit
`efc4dd142932e7cc9380b35ce86b7ba038438cfe` and its distinct
`git clone --no-local` each tracked exactly 762 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (966 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, four catalogs with 44/44 live
navigation and 2,574/2,574 core keys, all source/release hygiene checks,
production build/layout, seven visual journeys covering fourteen macOS source
images and two accessibility journeys. The candidate script removed its
temporary directories.

This proves encrypted and plaintext historical WebDAV recovery only against a
controlled loopback provider. It does not prove a live cloud/provider account,
every old document shape, an archived signed/public old installer, a version-
number change, a public migration window, Windows/native-Linux installed
upgrades, human rights review or the owner's final repository. IR-08 and IR-12
remain **In progress**; IR-09, IR-13 and IR-14 remain **Open**.

## Current P-02 partial-write failure and IR-12 source candidate

On 2026-09-23, the default XMODEM, ZMODEM and TRZSZ protocol regressions gained
a deterministic destination-write fault after a true partial stage. Each
production receive path defaults to the real Node descriptor/`FileHandle`
write. For each of the nine XMODEM/ZMODEM/TRZSZ ×
`ENOSPC`/`EACCES`/`EIO` pairs, the narrow injectable write operation persists
the first 64 bytes into the real same-directory `.part` file, then raises the
selected code on the next write while the peer or terminal channel is still
open. Every adapter signals cancellation, emits its error and session-end
events, becomes inactive, publishes no final file and removes the partial
staging file. The three focused files pass 43 tests and the whole terminal-
transfer directory passes 78 tests with 32 opt-in/platform skips.

The corresponding fresh `bun run candidate:check` deliberate pre-evidence
snapshot had 762 files, 16,479,416 bytes and tree SHA-256
`580b98847b5669534b0edc734d4d177caddd80b898a52f9bedf6fcfde826eff7`;
every snapshot-audit category was empty. Temporary root commit
`93d0711fff4ac89a5d5c641872dbb5e6c2c123c9` and its distinct
`git clone --no-local` each tracked exactly 762 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt macOS
arm64 `node-pty`. The clone's complete gate passed 217 test files with five
skipped files (975 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, four catalogs with 44/44 live
navigation and 2,574/2,574 core keys, all source/release hygiene checks,
production build/layout, seven visual journeys covering fourteen macOS source
images and two accessibility journeys. The candidate script removed its
temporary directories.

This proves deterministic source-level partial-write cleanup and clean-clone
reproducibility. It does not prove a physically exhausted volume, quota or
permission failure, independently operated SSH, source-rights approval,
signed/installed cross-platform artifacts, remote CI, public migration/final
removal or the owner's final repository. IR-03 and IR-12 remain **In
progress**; IR-13 and IR-14 remain **Open**. The immediately preceding
ENOSPC-only candidate remains identified by 762 files / 16,469,993 bytes, tree
SHA-256 `e8627f6a8054e6c2ce5348690f5dfe3b662c1179058930a49fcd0887a528da4e`
and temporary commit `0ee610d831faf1e033c7f9bcbfae40332564802e`; this three-error
candidate supersedes it.

## Current P-03 FTP partial-write failure candidate

On 2026-09-23, the independent FTP server's ordinary and resumed upload
regressions gained deterministic `ENOSPC`, `EACCES` and `EIO` after 64 real
bytes have been written to the private staging file. All six cases return
`426`, remove the stage, preserve any existing destination and keep the
authenticated control connection usable. The focused server file passes 24
tests. The production default remains Node's `createWriteStream`; only the
test's narrow staging-stream factory injects faults.

The corresponding deliberate pre-evidence `bun run candidate:check` source
snapshot had 762 files / 16,486,371 bytes / tree SHA-256
`82ed1a3de4bc2de83877c4734123fe76735a081e37e2d9be8f90ee6e8525001b`;
every snapshot-audit category was empty. Temporary root commit
`55a2f430810b98dc3ba8fb3201676918c1189e7f` and its distinct clean
`git clone --no-local` each tracked 762 files without `.gitmodules`, a
submodule, `vendor/legacy-prototype`, generated OpenAPI, installed dependencies or
release outputs. Frozen installation installed 609 packages and rebuilt
macOS arm64 `node-pty`. The clone's complete gate passed 217 test files with
five skipped files (981 tests with 33 skips), the 368-module / 1,314-dependency
architecture gate, 267 Contract operations, four catalogs with 44/44 live
navigation and 2,574/2,574 core keys, all source/release hygiene checks,
production build/layout, seven visual journeys covering fourteen macOS source
images and two accessibility journeys. The candidate script removed its
temporary directories.

This proves local clean-clone reproducibility of the FTP partial-write
cleanup, not a physically exhausted or access-revoked filesystem, independent
FTP review, signed/installed Windows or native-Linux binaries, remote CI,
source-rights approval, public migration/final removal or the owner's final
repository. IR-04 and IR-12 remain **In progress**; IR-13 and IR-14 remain
**Open**. The preceding P-02 candidate with tree SHA-256
`580b98847b5669534b0edc734d4d177caddd80b898a52f9bedf6fcfde826eff7`
remains recorded above and is superseded for the current source snapshot.

## 2026-09-23 current UI/AppImage-gate clean-clone candidate

After the AppImage payload gate and the data-migration option alignment, a new
`bun run candidate:check` prepared an independent source snapshot of 765 files,
16,552,067 bytes and tree SHA-256
`d145790d30bfe99bcd672f41280f70eb8246c0022d214ac98aef626a83e30628`.
All audit violation categories were empty. The script made only a disposable
local root commit `f6ac1f9b9d4d419c2ca62add88bea684394c8c24` and a distinct
`git clone --no-local`; both tracked exactly 765 files. The clone had no
`.gitmodules`, submodules, `vendor/legacy-prototype` or generated OpenAPI file, and
its initial and final Git status were clean.

The clone's `bun install --frozen-lockfile` installed 609 packages and built
macOS arm64 `node-pty`. Its complete `bun run check` passed 218 test files
with five skipped files (987 tests passed, 33 skipped), the 368-module /
1,314-dependency Level 1 gate, 267 Contract operations, source/release
hygiene and four-language checks, production build/layout, seven Axterm visual
and two accessibility journeys. The script removed its owned temporary source
and clone after the successful check. Later evidence-document edits are not
claimed to be part of that exact snapshot.

A separate current-checkout `bun run test:ssh` subsequently passed the real
controlled OpenSSH integration and source Electron save-and-connect journey;
it did **not** run inside this deleted clone. A separately built current-source
macOS directory app passed the packaged OpenSSH journey and complete packaged
suite; see [IR-03 packaged SSH evidence](IR03-MACOS-PACKAGED-OPENSSH-2026-09-21.md).
These add protocol and packaged-app evidence alongside the clean-clone proof,
but do not constitute native Windows/Linux CI, a signed installer, final
source-rights review or an owner-created new repository. IR-12 remains **In
progress**; IR-13/IR-14 remain **Open**.

## 2026-09-23 controlled OpenSSH in the same clean clone

`bun run candidate:ssh:check` now opt-in extends the disposable candidate gate
with the real Docker OpenSSH fixture. It preserves `candidate:check` for hosts
without Docker; the extra fixture is not silently counted when only the default
gate runs. The command first prepared and audited a 765-file, 16,557,900-byte
source snapshot with tree SHA-256
`b384e23009f7c51143248bf78ed92a2d20ba5251df226911c1d561f84ed38acb`.
Every reported violation category was empty. Temporary root commit
`7ba6ecb6b67142a338f9822e88beb0f68d278a21` and a separate
`git clone --no-local` contained the same 765 tracked files without the
submodule, old vendor tree or generated OpenAPI file.

In **that clone**, frozen Bun installation rebuilt macOS arm64 `node-pty` and
the complete `bun run check` passed 218 test files with five skipped files
(988 tests passed, 33 skipped), the 368-module / 1,314-dependency Level 1
gate, 267 Contract operations, source/release hygiene, production build/layout,
seven visual and two accessibility journeys. The same clone then ran
`bun run test:ssh`: the controlled three-container OpenSSH fixture passed its
Runtime integration test and the source Electron B-12 authenticated
save-and-connect journey. The candidate's final Git status was clean. Its
temporary source/clone were removed; the Docker fixture left no labeled
container or `axterm-ssh-fixture-net-*` network.

This closes the earlier **evidence-separation gap** between clean-clone source
checks and the local real-SSH fixture. It is still one unsigned macOS host and
one controlled OpenSSH topology, not a full external peer/security audit,
packaged Windows/native-Linux run, remote CI receipt, rights review, final
public source snapshot or owner-created repository. The later evidence edits
are not claimed to be inside the exact pre-evidence snapshot. IR-12 stays
**In progress**; IR-13 and IR-14 stay **Open**.

## 2026-09-23 independent external peers in the same clean clone

`bun run candidate:protocol:check` is an opt-in superset of the ordinary
candidate and controlled-OpenSSH gates. A first attempt stopped before peer
assertions because the Debian APT index did not finish inside the fixture's
40-second setup deadline. The candidate gate now fetches the fixed Debian
package by its official direct URL into its disposable parent root, or accepts
an explicit `AXTERM_EXTERNAL_LRZSZ_DEB` path. In both cases the lrzsz fixture
checks the existing platform-specific SHA-256 before starting a peer; the
package is not added to the source snapshot, lockfile or production payload.

The successful deliberate pre-evidence snapshot had 765 files, 16,583,503
bytes and source-tree SHA-256
`b4644096f621062728e201dddc4090f61efddb49e9d974848b6231a45df88aa7`.
All audit violation categories were empty. Disposable root commit
`6b39e328f00c92671425aef415fb68148d94f847` and a distinct
`git clone --no-local` each tracked 765 files with no `.gitmodules`,
submodule, `vendor/legacy-prototype` or generated OpenAPI file. Frozen installation
rebuilt macOS arm64 `node-pty`. In **that one clone**, the full `bun run check`
passed 218 test files with five skipped files (988 tests passed, 33 skipped),
the 368-module / 1,314-dependency architecture gate, 267 Contract operations,
source/release hygiene, production build/layout, seven visual journeys and two
accessibility journeys. `bun run test:ssh` then passed its controlled OpenSSH
Runtime integration and Electron B-12 save-and-connect journey. Finally the
opt-in external SSH/PTY suites passed 16/16 Debian `lrzsz` cases and 7/7
official `trzsz-go` cases using Linux arm64 peers. The clone's final Git status
was clean, and the temporary source/clone and fetched peer package were removed.

This closes the local **same-clone external-peer evidence gap**. It does not
turn controlled SSH fixtures into an independently operated host, prove remote
GitHub Actions execution, or certify native Windows/Linux installed packages,
signed artifacts, source-rights review, the public migration window, final
source snapshot or the owner's new Git repository. IR-03 and IR-12 remain
**In progress**; IR-13 and IR-14 remain **Open**. Later documentation edits are
not claimed to be in the exact pre-evidence snapshot.

## 2026-09-23 migration-fixture clean-clone refresh

After the historical-source portable file and the explicitly sanitized
encrypted/plaintext sync derivatives were added to the working tree, the
local-only candidate was rerun. Both `bun run candidate:check` and
`bun run candidate:ssh:check` independently prepared the same **782-file,
17,679,713-byte** audited source snapshot, tree SHA-256
`f9e89cee22498784a6698c2b6272b07653f43f541ff9dcd48990e6d93d00bebb`.
The audit reported no forbidden, transient, oversized, sensitive or
high-confidence-secret entries and no retired direct/lockfile dependency
markers. Temporary root commits were respectively
`9fe5ab15bc621211f5cb813c8246f425bdc32f3b` and
`15cd762413e52ee65224e92fe4c09d3e3933e741`; each separate
`git clone --no-local` tracked exactly 782 files, had no submodule or old
vendor tree, and ended with a clean Git status.

Each clone completed `bun install --frozen-lockfile` (609 packages, native
macOS arm64 `node-pty` rebuild) and the full `bun run check`: 218 test files
passed and five skipped, **1,003 tests passed and 33 skipped**, the
374-module/1,320-dependency Level 1 gate, 267 Contract operations,
source/license/SBOM/localization/snapshot checks, production layout, seven
visual and two accessibility journeys. This includes the unconditional
old-package portable and sanitized remote-document regression tests. The
`--ssh` clone additionally passed the controlled OpenSSH Runtime integration
and source Electron B-12 authenticated save-and-connect journey. After the
run, no `axterm-ssh-fixture` containers or `axterm-ssh-fixture-net-*`
networks remained. Both candidate commands removed their own temporary
source and clone directories; neither wrote to this checkout's Git history
or any remote.

This is a deliberate **pre-evidence** source snapshot: this paragraph and
later status edits are not part of that exact hash. The ordinary candidate
does not run real SSH, while the opt-in `--ssh` variant does. Neither run
claims independent external peers in this refreshed snapshot, remote CI,
native Windows/Linux installation, signed distribution, source/brand/rights
approval, public migration release, final compatibility removal or the
owner-created new repository. IR-12 remains **In progress**; IR-13/IR-14
remain **Open**.

## 2026-09-23 current-worktree clean-clone refresh

After the current UI, localization and release-evidence changes, a fresh
`bun run candidate:ssh:check` audited a **799-file, 18,158,906-byte** source
snapshot with tree SHA-256
`61a29835f68ed8b91538e0c44edd981e51f5161761e6b4441c8b1f0cfd048acc` and no
reported snapshot, secret, dependency-marker or hygiene violations. The
temporary root commit was
`ae5fda57d45df81de527557b6f8ef0a03f569a14`; its distinct `git clone
--no-local` tracked exactly 799 files, and the candidate script verified a
clean final Git status. No remote or caller-checkout Git history was changed.

Frozen installation completed with 609 packages and rebuilt macOS arm64
`node-pty`. In that clone, the full `bun run check` passed 219 test files with
five skipped files (**1,019 tests passed, 33 skipped**), the 358-module /
1,304-dependency Level 1 gate, 267 Contract operations, source/license/SBOM/
localization/snapshot checks, production build/layout, nine visual journeys
and two accessibility journeys. The same clone then passed `bun run test:ssh`:
the controlled OpenSSH Runtime fixture and Electron B-12 authenticated
save-and-connect journey both passed. The script removed its temporary source
snapshot and clone after completion; the post-run Docker inventory contained
no `axterm-ssh-fixture` containers or `axterm-ssh-fixture-net-*` networks.
This evidence section and its matching `STATUS.md` entry were written after
the clone run and are not included in the recorded source-tree hash.

This is current local clean-checkout and controlled-protocol evidence, not
remote CI, an independently operated SSH peer, signed packages, native
Windows/Linux installation or upgrade evidence, source-rights/brand review,
the public migration window, final compatibility removal or the owner's final
new repository. IR-12 remains **In progress**; IR-13/IR-14 remain **Open**.

## 2026-09-23 current migration-accessibility snapshot

After adding the keyboard-activated packaged migration accessibility journey,
the ordinary `bun run candidate:check` created a new source-only snapshot and
non-local Git clone. The audit covered **800 files / 18,196,546 bytes** with
source-tree SHA-256
`cb80b1e61eed562c80d0a7d8389eff028c58be7496615f27c268cd1dab0d4134` and no
reported forbidden, environment, oversized, symlink, transient, prohibited
generated, sensitive, secret, dependency or hygiene violations. The disposable
root commit was `beeb3b41279a26a55f55be6b8ed2e0d8697d7b2f`; its separate
`git clone --no-local` tracked exactly 800 files. The candidate verifier also
confirmed a clean final Git status and absence of `.gitmodules`,
`vendor/legacy-prototype` and `docs/api/openapi.json`.

The clone completed `bun install --frozen-lockfile` with 610 packages and
rebuilt macOS arm64 `node-pty`. In that clone, `bun run check` passed 219 test
files with five skipped files (**1,019 tests passed, 33 skipped**), the
358-module / 1,304-dependency Level 1 gate, 267 Contract operations,
license/SBOM/localization/snapshot checks, production build/layout, nine visual
journeys and two source accessibility journeys. The separately run packaged
accessibility journey remains the evidence for the unsigned macOS directory
package; `candidate:check` does not run the `packaged` Playwright project.
The candidate script removed its temporary source/clone after completion and
did not configure or push a remote.

This strengthens current local IR-12 clean-checkout reproducibility only. It
does not provide remote CI, Windows/native-Linux installed-app evidence, signed
distribution, independent source-rights or brand review, a public migration
window, final compatibility removal, or an owner-created GitHub repository.
The evidence paragraph was written after the clone and is not inside the exact
reported source snapshot. IR-12 remains **In progress**; IR-13/IR-14 remain
**Open**.

## 2026-09-23 retired-locale packaged-migration candidate refresh

After adding the packaged retired-language migration regression and its
macOS arm64 evidence, `bun run candidate:check` produced a clean temporary
source snapshot of **801 files / 18,205,025 bytes**, source-tree SHA-256
`7e1c28b7a63646aff886ee828b4707f2b930567f0af0869711a8e93ef7c7c8c1`. The
candidate root commit was `cd6c2ec6c251e0058b60f23c900be410e6ba21dc`; a distinct
`git clone --no-local` tracked the same 801 files and passed the candidate
script's clean-status, no-submodule, no-`vendor/legacy-prototype`, and generated
OpenAPI-file checks. No remote was configured.

In that clone, `bun install --frozen-lockfile` installed 610 packages and
rebuilt macOS arm64 `node-pty`. The complete `bun run check` passed 219 test
files with five skipped (**1,019 tests passed, 33 skipped**), the 358-module /
1,304-dependency Level 1 gate, 267 Contract operations, all source/license/
SBOM/localization/snapshot checks, production build/layout, nine visual tests
and two accessibility tests. The packaged-project retired-locale journey had
already passed separately against a freshly built macOS arm64 app. The
candidate command does not run packaged Playwright tests, controlled SSH, or
external-peer fixtures.

The temporary source and clone were removed by the candidate script. This
refresh proves the current independent source snapshot and frozen-install
`bun run check` locally; it does not prove remote CI, Windows/native-Linux
installation, signed release, independent rights review, migration-window
completion or creation of the owner's final repository. This evidence section
was appended after the candidate run and is not in its recorded hash. IR-12
remains **In progress**; IR-13/IR-14 remain **Open**.

## 2026-09-23 disabled-control contrast fix candidate

A current-checkout rerun exposed an axe-core contrast failure during the
temporary period in which data-migration and Axterm-configuration actions are
disabled while a File Grant is being revoked. The global `button:disabled`
rule faded foreground and surface together with `opacity: 0.42`; the source
accessibility journey observed ratios as low as 3.72:1. The style now retains
full opacity and uses the Axterm muted-text/raised-surface token pair, measured
at 5.43:1. A focused unit regression guards the disabled style, and the
keyboard-driven J-08 accessibility journey passes with the real async preview
flow.

After that fix, `bun run candidate:check` created a clean snapshot of **801
files / 18,208,344 bytes**, tree SHA-256
`6ac0aa3e8b61d0eaf03667cefe1a07b91641112fd2a26f4569cc2e172e0ea7d5`, temporary
root commit `fc149543270888ff3f6f0b6b847cfe6722f5be40`, and a separate clean
`git clone --no-local`. Frozen install rebuilt macOS arm64 `node-pty`; all
1,020 source tests passed, 33 skipped, and all 11 visual/accessibility checks
passed with the 358-module / 1,304-dependency architecture gate and 267
Contract operations. Root-worktree `bun run check` also passed on the same
code. The candidate did not run packaged Playwright, SSH peers or external
protocol peers. This paragraph was added after the candidate and is not in its
hash. IR-12 and IR-10 remain **In progress**.

## 2026-09-24 full-checkout protocol-peer candidate

The current 804-file audited source snapshot contained 18,267,811 bytes and
had source-tree SHA-256
`ec3f66a43fe038122afc4e4a06d2c198847802a64f634f0a19b6d65b266e01b7`. The
candidate protocol check created ephemeral root commit
`83f6056a0b427d4c55bcdc065c493e8c9ed34674`, then independently cloned it with
`git clone --no-local`; the clone froze 610 packages and passed the complete
`bun run check`: 1,028 tests passed, 33 skipped, 358 modules / 1,306
dependencies, 267 Contract operations, nine visual and two accessibility
journeys.

The same clean candidate passed the real OpenSSH Runtime fixture and the
production-Electron B-12 Save-and-Connect journey. It also passed 16 external
`lrzsz` SSH transfer tests and seven `trzsz` SSH tests against pinned Linux
arm64 peers. The Debian `lrzsz` package SHA-256 was verified before use; peer
containers ran with networking disabled. Temporary clone, peer containers and
SSH fixture were confirmed removed after the run.

This adds reproducible source-checkout and external protocol-peer engineering
evidence. It does not complete IR-12 acceptance: no remote CI or native Linux
or Windows installed-app evidence was produced, and it does not establish
source-rights approval, signed release or repository-owner acceptance. This
evidence paragraph was appended after the candidate run and is not included in
its exact source-tree hash. IR-03 and IR-12 remain **In progress**.

## 2026-09-24 IR-12 clean independent-build acceptance candidate

A follow-up `bun run candidate:protocol:check` captured the current
804-file/18,270,506-byte source snapshot with tree SHA-256
`90a24ab2709b02ca69cb19f00bb705afa14adf952cb334e597bd2bdf282ad9a6` and
ephemeral root commit `091327a600a7cc06a93c8ba7d17122d739c5c575`. Its separate
`git clone --no-local` froze 610 packages, rebuilt macOS arm64 `node-pty`, and
passed the full `bun run check`: 219 test files passed, five skipped; 1,028
tests passed, 33 skipped; 358 modules / 1,306 dependencies; 267 Contract
operations; nine visual and two accessibility journeys; and the production
package-layout check. Snapshot, dependency-marker and transition-boundary
audits reported no violations.

The same candidate passed the real OpenSSH Runtime fixture (1/1), the
production-Electron B-12 authenticated Save-and-Connect journey (1/1), 16
pinned external `lrzsz` SSH tests and seven pinned external `trzsz` SSH tests
against Linux arm64 peers. The Debian `lrzsz` package hash was checked before
use; test peers ran without network access. After completion, the exact
temporary clone directory was absent and no matching SSH or external-peer
test container remained.

Against IR-12's named acceptance criteria, this clean-checkout, frozen-install,
complete-gate, real-fixture, Electron-E2E and package-layout evidence supports
**Accepted**. It is local macOS arm64 evidence only; it does not establish
source-rights approval, native Windows/Linux desktop installation,
signing/updater readiness, remote CI or owner-created-repository acceptance.
Those remain separately gated by IR-02, IR-11, IR-13 and IR-14. This evidence
paragraph was appended after the candidate and is not part of its recorded
source-tree hash. IR-03 remains **In progress**; IR-12 is **Accepted**.

## 2026-09-24 installer-protocol regression candidate rerun

After adding installed-protocol registration assertions to the Linux DEB and
Windows NSIS test scripts, `bun run candidate:protocol:check` again captured
and independently cloned the current source. The clean candidate contained
804 files / 18,277,398 bytes, with source-tree SHA-256
`8f48f098026c29d28ab2c6810ac6f66bca56067a5bcb929747ea84957c6cff02` and
ephemeral root commit `65510547526bcae05d7401dc2800cf8c0ec6c222`. Frozen install
resolved 610 packages and rebuilt macOS arm64 `node-pty`. The complete
`bun run check` passed: 1,028 tests passed and 33 skipped, 358 modules / 1,306
dependencies, 267 Contract operations, nine visual and two accessibility
journeys, and the production package-layout check. Snapshot hygiene and the
expanded Legacy Prototype-transition reference scan reported no violations.

The candidate also passed the OpenSSH Runtime fixture (1/1), packaged B-12
Save-and-Connect Electron journey (1/1), 16 pinned `lrzsz` SSH tests, and seven
pinned `trzsz` SSH tests. Temporary clone, fixture and peer containers were
confirmed cleaned. This validates the Linux DEB and Windows NSIS test-script
changes as source in a reproducible clean build, but the candidate ran on macOS
arm64: it did not execute a native DEB installation or the PowerShell NSIS
script. Those OS-level assertions still need Linux/Windows CI execution. The
append-only evidence text is not included in the source-tree hash. IR-12 stays
**Accepted**; this does not change IR-08 or IR-13 status.
