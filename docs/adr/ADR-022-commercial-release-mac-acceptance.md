# ADR-022: Minimum commercial release with macOS acceptance and cross-platform ownership

Status: Accepted for release planning, 2026-09-26  
Supersedes: ADR-015's production-feed prerequisite and ADR-016's all-platform **first-release completion** prerequisite for this manual-update release  
Does not supersede: macOS/Windows/Linux compatibility as a product target, Level 1 architecture, security/data rules, ADR-021 compatibility removal or third-party license duties

## Context

ADR-021's Legacy Prototype technical decoupling and the independent clean build have been verified on macOS.
The owner requires Axterm to remain compatible with macOS, Windows and Linux, while this task's
computer can validate only macOS. The owner explicitly takes responsibility for Windows/Linux
native testing on separate computers and does not make those results a condition for **this task's
commercial-release completion**. This boundary must be reported honestly: an unrun platform is not a
passed platform. The first release may use accurately documented manual updates rather than a
production automatic-update feed. The old Axoterm/Axterm packages were never publicly distributed.

## Decision

1. The product keeps **macOS arm64, Windows x64 and Linux x64 compatibility targets**, with Axterm-owned
   source under Apache-2.0. Charging for a build, service or support does not change recipients'
   Apache-2.0 rights. This task's commercial-release completion gate is the frozen source and a
   signed/notarized, publicly downloadable **macOS arm64** installer with its required rights, notices,
   data-safety and installed-app evidence. Windows/Linux packaging/build paths must not knowingly
   regress, but their native install/upgrade/protocol tests belong to the owner after handoff and do not
   block marking **this commercial-release task** complete. A status report must say “Windows/Linux:
   owner self-test pending/unverified” until actual results exist; it may not say those tests passed.
2. This first release uses **manual updates** from an owner-controlled public HTTPS release page.
   The page gives version, date, security/release notes, available installer SHA-256 values and authentic downloads.
   The app and public documentation must accurately explain this process and expose no dead or misleading
   automatic-update control. The unconfigured ADR-015 provider may remain inert and make no network
   request; its Host/Runtime boundary and signature validation must not be weakened. Enabling automatic
   updates later requires a separate active signed feed and installed-upgrade evidence.
3. The first release keeps the four approved languages, current Axterm configuration format and
   user-data preservation. It does not restore Legacy Prototype import/export, links, theme files or sync. No
   new feature, wholesale UI rewrite or parity target is required merely to reach this release.
4. The manual-update choice and platform testing ownership do **not** waive source/contributor rights,
   independent replacement of directly adapted material, applicable third-party notices, data safety,
   privacy/security/support contacts, Mac package testing or a clean source snapshot. Use the existing
   component/source inventories to find actual distribution risks: the owner may attest common-origin
   first-party material once, and must resolve identified direct adaptations, missing notices or
   uncertain assets individually. The first-release gate does not require one human signature per
   source file, transitive crate or translation key. An automated `pending` ledger is not permission.
5. Historical parity evidence and obsolete migration instructions must not be copied into the new
   public source snapshot by default. Required copyright, license and NOTICE material must remain;
   zero occurrences of an upstream name is not a substitute for permission. Any permitted historical
   public document exception needs an owner decision. Preserve a readable controlled backup of the
   old history and evidence before creating a new Git root; do not repeat the full upstream-ref audit
   merely to satisfy this task. Old GitHub deletion remains an owner action after the new repository
   and downloads have been verified.

## Release gate and implementation gap

The authoritative first-release checklist is
[MINIMUM_COMMERCIAL_RELEASE](../implementation/MINIMUM_COMMERCIAL_RELEASE.md). Its required checks
apply to frozen source and the macOS arm64 installer; Windows/Linux build compatibility is checked
where available, with native verification separately owned. The existing 46-W/14-IR board remains
the traceable full three-platform work inventory and is not automatically marked complete by this ADR.

As of this decision, `release:final-public:check` still requires an active automatic-update feed.
**Do not bypass it, mark its pending records active, or call the product releasable.** Implement and
test a lean macOS/manual-update commercial-release gate that retains actual rights, notice, data,
clean-source and macOS installed-package checks without requiring hundreds of repetitive human
ledger approvals; keep the existing full three-platform/automatic-update
gate for later acceptance. Until the Mac gate passes on frozen bytes, this commercial-release task
remains blocked. Windows/Linux native results are not fabricated or silently accepted.

## Deferred, not waived

The production signed automatic-update feed/installed updater journey and Windows/Linux native
installation, protocol, upgrade, package-notice and appropriate signing tests remain open under the
owner's separate follow-up. They do not block the Mac-based completion of this task, but no one may
claim their platform acceptance without evidence. A public Windows/Linux download, if offered before
that self-test, must be clearly labeled unverified and owner-controlled; no unsupported pass claim is
allowed. Any change to this completion boundary requires another ADR, not a silent status edit.
