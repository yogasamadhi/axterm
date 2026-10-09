# ADR-016: Independent Apache-2.0 product and commercial release

Status: Accepted  
Date: 2026-09-20  
Supersedes: ADR-003's Legacy Prototype 1:1 delivery target, not the Level 1 architecture or security invariants

## Context

The fixed Legacy Prototype 5.5.0 comparison helped Axterm deliver a usable first desktop version quickly. It was a development and acceptance method, not the intended long-term product identity. Axterm is already an Apache-2.0 project with its own Electron Host, independent Runtime, typed HTTP contracts, local persistence, security boundaries and brand. The current source tree nevertheless contains direct Legacy Prototype adaptations, generated locale/theme data, an `@legacy-prototype` package, compatibility surfaces and a parity harness. Removing a submodule or starting a new Git history alone would not remove those relationships.

The owner has chosen to keep the new repository Apache-2.0 and to allow targeted UI/UX improvements rather than a full interface rewrite. Only English, Japanese, Simplified Chinese and Traditional Chinese are retained; the upstream 310-theme collection will be replaced by a smaller Axterm-owned catalog. Legacy Prototype-specific import, links and sync formats will be removed only after a public migration window; the exact duration requires a release decision, with one stable release and 90 days recommended as a minimum. A commercial release must preserve applicable third-party notices and be honest about provenance. The detailed work packages and verification gates are in [the cleanup plan](../implementation/COMMERCIALIZATION_CLEANUP_PLAN.md).

## Decision

1. Axterm's current delivery objective becomes an independently maintainable, Apache-2.0 desktop product that can be commercially distributed. The fixed Legacy Prototype 1:1 program is historical evidence, not a continuing product or pixel-similarity release gate. The 122-row parity matrix and its existing states are archived as observed progress; no row is silently relabeled Certified.
2. The Level 1 process model, REST/OpenAPI, SSE, binary terminal WebSocket, streaming file paths, Runtime-owned SQLite, Host-owned Vault/File Grants and all existing safety/resource invariants remain mandatory. This ADR authorizes no Plugin Kernel, business IPC, weaker credential policy or disabled substitute for an implemented capability.
3. Reuse efficient terminal, connection and file workflows, but establish Axterm-owned visual tokens, wording, screenshots and usability/accessibility checks. Targeted brand and UX improvements are sufficient; wholesale React/CSS rewriting is not a completion criterion. A cosmetic change alone is not evidence that copied code, data or other rights issues are resolved.
4. Replace direct Legacy Prototype-derived protocol code, its locale/theme snapshots and the `@legacy-prototype/ftp-srv` dependency with independently sourced implementations or content. Retain only English, Japanese, Simplified Chinese and Traditional Chinese; replace the upstream 310-theme collection with a curated Axterm-owned set and migrate old built-in theme references without touching user-created themes. File renaming or JS-to-TS transcription does not satisfy this decision.
5. Remove Legacy Prototype import/export, `legacy-prototype://` and old sync paths only after a public migration window whose duration is decided before release. A minimum of one stable release and 90 days is recommended, not yet approved. The migration release must include warnings, usable export/conversion paths, old Axterm data upgrade tests and remote-sync backup guidance. During that window, describe interoperability honestly and retain relevant notices; do not claim the public product has no Legacy Prototype association.
6. Keep Axterm's root license Apache-2.0. Retained third-party code, data, fonts and assets keep their own permissions and notices in both source and packaged applications. A release needs an auditable component inventory, notice packaging, clean-checkout tests and applicable platform evidence.
7. Creation or deletion of a GitHub repository is a separate owner action after the new source snapshot passes its gates. Previously public copies and licenses remain unaffected by that action.

## Transition and acceptance

The work follows P-01 through P-08 and stages 0–5 of the cleanup plan. Until replacement functional, accessibility, security, provenance and packaged-app checks exist, legacy tests may continue running as regression evidence; they must not be misrepresented as the new commercial release gate. The execution plan and new status ledger control work order, while the old parity roadmap, matrix and screenshots remain labeled historical until removed from the new public snapshot.

The transition is complete only when a fresh checkout without the Legacy Prototype submodule builds, runs the new full check, passes retained feature/protocol and data-migration tests, produces verified macOS/Windows/Linux release artifacts with readable notices, and has documented provenance and brand review. A source-only or green unit-test result is insufficient. Unavailable platforms or legal review remain open release gates, not assumed passes.

## Consequences

The prior `MASTER_SPEC` sections that prescribe Legacy Prototype as the unique delivery target or require 95% pixel similarity no longer define future product acceptance. Their implementation history is not erased; architecture, security and existing user-data obligations remain. Replacing copied material and translation/theme catalogs adds cost, but it removes a source and build dependency and allows Axterm to evolve by user needs instead of a frozen reference application.

Removing compatibility features could break links or access to existing synced data. The migration window, tests and release notes are therefore mandatory. The final new-repository product omits those compatibility paths; the migration-period build may not claim complete name-free detachment.

## Alternatives considered

- Retain the 1:1 program indefinitely: rejected because the first-version comparison is not the desired long-term product direction.
- Delete Git history without replacing code/data: rejected because it changes neither provenance nor license obligations.
- Rewrite every UI component before release: rejected because useful generic workflows can remain and a visual rewrite alone would not resolve source rights.
- Remove every compatibility path immediately: rejected because users need a public migration window.

## Rollback

Keep each replacement behind existing contracts until its real protocol, security, packaged-app and migration checks pass. An unsuccessful replacement is not made the default; the old code remains in the current development checkout with its notices while the work item stays open. Do not publish a new-repository snapshot or delete the old repository during an incomplete transition.

## 2026-09-25 clarification: unpublished Axoterm prototype

The repository owner confirmed that the old Axoterm/Axterm installation package
was never publicly distributed. For the first public release, the owner accepts
an explicit manual migration from that prototype: export/import portable data,
export/import each custom theme separately, and re-enter saved passwords. The
new application does not promise automatic import of `axoterm.sqlite` or its
Vault. Keep a cold backup of the complete old profile until the manually
imported connections and themes are checked. This scoped decision does not
eliminate the Legacy Prototype compatibility migration window in Decision 5, nor does
it close IR-08's remaining release and platform gates.

## 2026-09-26 first-commercial-release scope

[ADR-021](ADR-021-immediate-legacy-prototype-compatibility-removal.md) has already
superseded Decision 5's public migration window. [ADR-022](ADR-022-commercial-release-mac-acceptance.md)
now uses Mac formal-package acceptance plus common source/rights gates as this
task's commercial-release completion line, with manual updates. Windows/Linux
remain compatibility targets; their native tests are owner-run, outside this
task's blocking scope, and stay visibly unverified until run. Neither decision waives
source/contributor rights, third-party notices, Mac signing/notarization, user
data safety or final-source review. The current task's release checklist is
[MINIMUM_COMMERCIAL_RELEASE](../implementation/MINIMUM_COMMERCIAL_RELEASE.md).
