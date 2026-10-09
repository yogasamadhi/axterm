# W-02-03: bookmark-trigger preset lineage and replacement

Date: 2026-09-25  
Status: **engineering replacement tested; source/rights decision pending**

## Why this was selected

The bounded seven-token source screen used for
[the RDP and monitor review](W02-03-RDP-KEYBOARD-LINEAGE-2026-09-25.md)
next surfaced `bookmark-triggers-editor.tsx` against Legacy Prototype's
`src/client/components/terminal/automation/trigger-presets.js` at fixed commit
`799bedef98c1deae676ae03041719de98d3b57f1`. The reference file's
SHA-256 is
`0dc1e06f093e2a3e90d79c6b0bfdf0e12bdbc19a950f6f5c59b57271e4897801`.
Before this change, Axterm's two inlined preset rule objects had the same
`--More--`/Space pager response and the same `\[sudo\]\s*password`/notify
pattern as reference presets, along with the same rule-field arrangement and
cooldown values. That combination is a real adaptation candidate, not proof
that the generic device prompt or Trigger schema is protected expression.

## Current product behavior

The editor now lists Axterm intent options and builds a rule only when the
user selects one. It preserves the useful opt-in workflows but does not
retain an inlined upstream-style preset-rule array:

- `pager-space`: recognizes the standard `--More--` text without case
  sensitivity, sends only Space, never Enter, and uses a 900 ms cooldown.
- `password-alert`: recognizes a password prompt with or without a `for user`
  suffix, publishes a notification only, never sends a password, host-key
  acceptance or Enter, and uses a 10 s cooldown.

Existing user-saved triggers are not modified. The four supported catalogs
now label the preset _action_ explicitly; the old Cisco/sudo-specific labels
were removed. The current preset factory is
`bookmark-trigger-presets.ts` SHA-256
`8a6d214e97e090563ebfdb9eaef7cf4632d3b5622b03db3fda2184bb44bcd6fe`.
The fixed prompt string remains because the optional pager operation needs
to recognize the actual terminal text; it is not offered as evidence that
the file has passed an intellectual-property review.

Focused tests use the actual `TriggerEngine`: a pager prompt split across
output chunks fires exactly one send action, and a sudo password prompt fires
only a notification. They also validate the input schema, the regular
expression safety gate and all four labels. `bunx vitest run
tests/unit/bookmark-trigger-presets.test.ts` passed **3/3**; typecheck passed.
The core-language review ledger was regenerated for **2,602 keys** per
language and remains pending for en, ja, zh-CN and zh-TW. Full `bun run check`
then passed **1,249** unit/integration tests and **21/21**
visual/accessibility journeys, including architecture, Contract,
source-review-ledger, localization and build checks.

The engineering author inspected the fixed reference while triaging this
candidate; no clean-room authorship or release-rights clearance is claimed.
The named source/rights and language reviewers must assess the exact final
bytes and whether any retained behavior or wording requires attribution or
further replacement. W-02-03, W-05-01 and IR-02 remain open.
