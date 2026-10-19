# ADR-033: Enable OSC 52 clipboard writes by default

Date: 2026-10-11
Status: Accepted at the owner's request; validation evidence is recorded in STATUS.

## Decision

The default terminal behavior enables OSC 52 and allows writes to the local
clipboard. This lets remote programs such as Pi copy text through SSH without
requiring a custom Terminal Profile. OSC 52 reads remain denied by default.
Profiles retain separate protocol, read and write controls, including explicit
disable and deny choices.

Use the shared Contract defaults for new unprofiled sessions, newly created
profiles and missing fields in older profile records. Do not rewrite existing
explicit permissions or immutable behavior snapshots in open/saved workspace
tabs. Such sessions retain their creation-time policy; the new default applies
when a new session is created without an explicit overriding profile.

Keep the current trusted-document Browser Clipboard API path, target `c` only,
strict Base64/UTF-8 validation, bounded payload/response sizes, timeout, feedback
and deterministic parser cleanup. No new IPC, Host capability, dependency or
database migration is needed. Update all four settings hints to explain the
write-enabled, read-denied default.

## Acceptance

Verify default copy and denied reads through the OSC parser and a real Electron
terminal, including an isolated packaged macOS candidate. Verify that saved
explicit denials, sparse PATCH and Runtime restart persistence retain their
permissions. Run the full check and report existing failures without weakening
architecture, security or visual gates.
