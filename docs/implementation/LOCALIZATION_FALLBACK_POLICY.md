# Axterm localization fallback policy

Updated: 2026-10-03

Authority: [ADR-016](../adr/ADR-016-independent-open-source-product.md), [localization scope audit](LOCALIZATION_SCOPE_AUDIT.md)  
Status: technical release policy; human language and rights review remains required

## Current user-visible behavior

Axterm presents four selectable application languages: English, Japanese,
Simplified Chinese and Traditional Chinese. Arabic and the other ten previously
selectable languages are not retained product locales.

The navigation catalog used by `t()` contains independently drafted values for
all four locales. It covers the activity rail, settings categories, layout and
other navigation/control labels identified by the scope audit. Changing a
language immediately changes those values, persists the choice and sets the
document `lang`. All retained locales are LTR.

The wider application-copy catalog used by `x()` currently has authored English
and Simplified Chinese entries. Japanese and Traditional Chinese each contain
2,612 AI-assisted Axterm drafts for the language Settings surface, common actions,
high-frequency Shell controls, the Settings scaffold, current configuration and sync surfaces, plus the terminal workspace's search,
paste review, reconnect, shortcut-bar, dropped-file and transfer-status
controls; the startup, file-management, external-editor and accessibility
settings; the connection-profile workspace; the terminal-profile editor; and
the complete hosts/SSH-bookmark workflow, including the Axterm-owned protocol
dialog, connection stability,
connection security, connection dialogs and status/error reporting; and the FTP,
Telnet, serial, RDP, VNC, SPICE and Web bookmark editor workflow; and the
complete terminal workspace/context-menu workflow, including transfer, logging,
clipboard, selection, input-limit, rendering-fallback and OSC 52 safety
feedback; and the sync-service, credential, category, comparison and
migration-period workflow; and the Axterm-owned configuration snapshot export,
inspection, preview and atomic-import workflow; and the SSH Config Include
authorization, preview, safe-field editing, atomic import and result-report
workflow; and the batch SSH operation editor, concurrency, execution state and
per-host result workflow; and the trigger presets, rule editor, JSON validation,
matching/action controls and safety feedback workflow; and terminal-theme
selection, independent built-in theme editing, legacy-theme migration, pagination,
background editing and AI preview workflow; activity-rail ordering and fixed-tool
availability; static file, local FTP and SSH server-widget configuration; MCP
endpoint/tool controls; file-renaming preview and confirmation; desktop window
preference controls and restart guidance; remote-desktop connection, display and
security feedback; connection-history recording, reconnection, bookmark,
credential and recovery feedback; and the complete 174-key file-manager surface:
transfer, FTP capability, permission, drag-and-drop, remote copy, primary
actions, local and remote browsing, queue/conflict handling, and path validation;
and the complete 163-key global Shell surface: status, recovery, deep links,
connection lifecycle, workspaces, tab actions, Runtime state, AI context and
transfer center; and the complete 91-key AI workspace surface for provider
configuration, conversations, attachments, command review, bounded/redacted
context, tool activity, risk and approval state; and the complete AI
SSH-bookmark, known-host-key and SSH-tunnel surfaces, including secret exclusion,
explicit review-before-save, host-key revocation, and non-loopback
tunnel-binding warnings; and the complete quick-command library and multi-step
command editor surface, preserving clipboard placeholders, explicit
send-versus-insert behavior and the rule that insertion never silently runs a
command; and the complete productivity-panel, AI-Inspector, approval-card and
changed-host-key confirmation surface; and the complete saved-credential and
SSH-proxy configuration surface; and the complete 69-key keyboard-shortcut
configuration surface, including physical-key capture, conflict feedback,
platform-default reset and global window-visibility registration state; and the
complete 43-key remote-monitor bar and detail surface, including usage level,
process, network, disk and session-state feedback; and the complete 41-key
terminal-information panel, including unsupported/stale/live data state, filter,
system/CPU/memory/network/user/disk groups and duration units; and the complete
40-key terminal-interaction and recovery-settings surface, including the
established-SSH/unexpected-disconnect condition, bounded reload recovery,
file-drop choices and monitor-item controls; and the complete 16-key batch-input
and 16-key command-line batch-operation surfaces, including the announced
migration-window boundary for legacy workflow arrays, separate file grants and
literal field/count placeholders; and the complete 31-key bookmark-tree, six-key
bookmark-group and 12-key bookmark-specific quick-command surfaces, including
title/count/color placeholders, saved-bookmark search and per-bookmark command
limits; and the complete 33-key file-comparison, 31-key file-information and
six-key file-table surfaces, including path/owner/group, file size, permission
and operation/subject/column placeholders; and the complete 33-key command-history
surface, retaining its off-by-default, explicit-safe-single-line-command and
insert-then-Enter boundaries; and the complete 34-key bookmark-trigger surface,
retaining its per-bookmark terminal scope, coexistence with global rules and
Runtime regular-expression safety revalidation; and the complete 17-key external
system-editor temporary-copy and cleanup surface plus the complete 26-key
remote-text-editor save, conflict, reload, copy and unsaved-draft surface; and
the complete 29-key SSH-tunnel, 25-key session-startup and 15-key connection-
hopping surfaces; and the complete 13-key legal-and-license, five-key tab-
preferences and 27-key Web-session surfaces. No core keys fall back to English.
The current local optimization also adds explicit AI request review, source sizes, history selection and receipt failure copy. The historical feature descriptions retain the earlier implementation scope; removed legacy migration/sync paths are not active product interfaces. They do not read a
former Legacy Prototype catalog or silently substitute
upstream wording. Selecting either complete AI-assisted draft is **not** a claim
that every visible sentence has passed human language or rights review. The language Settings
surface must retain this distinction in user-facing help text.

This policy describes product behavior, not a statement that any existing
translation is linguistically or legally approved.

The executable core-copy scope record is
`scripts/localization/axterm-core-review-ledger.json`. It binds the exact
`core.ts` key set plus per-locale message hashes to each of the four locale
records, distinguishes complete, partial and English-fallback coverage, and
keeps source attribution, language review and rights review separate. `bun run
locales:core:check` is part of the default quality gate; it rejects catalog
drift or a ledger that claims coverage absent from the runtime catalog. `bun run
locales:core:reviewed-check` remains intentionally red until every retained
locale has complete core-copy coverage and qualified review. It is a content-
review precondition only, not proof of platform behavior or IR-05 acceptance.

## Release and support wording

Release notes, product pages and support responses may say that Axterm offers
four language selections and localized navigation. They must not say “fully
localized in four languages”, “complete native-language coverage”, or make an
equivalent claim while the broader catalog falls back to English and review is
pending.

When a support issue concerns core copy, support should preserve the original
text for reproduction and avoid offering a machine-generated response as a
reviewed translation. Accessibility labels, security warnings, destructive-action
confirmations and migration notices are product copy and must follow the same
review path before being represented as localized.

## Adding or changing a translation

1. Draft source copy from Axterm's current control semantics. Do not copy an
   upstream locale file, translated screenshot, trace or UI string as the
   source.
2. Preserve placeholders, interpolation names, plural/select semantics,
   keyboard vocabulary and accessibility names. A translation must not add
   markup or alter a security/migration promise.
3. Record the locale, keys, source author, date, translation method, reviewer,
   review date and any rights/provenance concern in the machine-readable
   `scripts/localization/axterm-navigation-review-ledger.json` and, for `x()`
   copy, `scripts/localization/axterm-core-review-ledger.json`. Their validators
   rejects a reviewed claim without recorded attribution, independent language
   and rights reviewers/dates, and an exact current key-scope fingerprint.
   `bun run locales:navigation:reviewed-check` additionally rejects a stale
   generated catalog or any pending navigation review before that _navigation_
   scope is called reviewed. `bun run locales:core:reviewed-check` rejects
   missing core coverage, attribution or reviews. “AI-assisted” is a drafting
   method, not reviewer approval.
4. Run the deterministic catalog checks, Renderer scope audit, immediate-switch
   and cold-restart tests. For every changed retained locale, test
   representative compact, normal and wide viewports, focus traversal,
   overflow and accessible names.
5. A qualified human reviewer for the target language and a product/brand
   reviewer must sign the ledger before public release notes describe the
   changed surface as reviewed. Missing review leaves the locale in draft state.

## Promotion gate

A locale may be promoted from “navigation available” to “reviewed broader
coverage” only when the review ledger identifies the exact scope, all affected
`x()` copy has a target-language entry, the visible workflow/accessibility
tests pass on supported packaged platforms, and product wording has been
approved. This promotion is per scope: completing navigation does not silently
promote settings, migration, security, terminal or file-management copy.

`bun run locales:navigation:reviewed-check` is an enforceable precondition for
promoting the generated navigation catalog. It is intentionally narrower than
IR-05: it cannot pass or replace the broader-copy, product-wording, packaged
platform and human evidence required for an independent release.

`bun run locales:core:reviewed-check` applies the same promotion discipline to
the broader literal `x()` catalog, but it cannot promote navigation, establish
visible-workflow quality, or replace supported-platform evidence. Both review
commands must pass for a language to be described as reviewed wherever their
respective scopes are included.

P-04 / IR-05 remains **In progress** until the required independent language,
rights, terminology and platform reviews are complete. This policy does not
relax that acceptance condition.
