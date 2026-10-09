# W-02-03: bookmark Contract source-lineage triage

Date: 2026-09-25  
Status: **bounded review evidence; current Contract unchanged; rights decision pending**

## Fixed byte inputs and observed overlap

The current `packages/contracts/src/schemas/bookmarks.ts` is SHA-256
`ee13de958659bb27eddc269390931b232d9289a79c1795661a9677aa1612b02e`.
The reference is Legacy Prototype commit `799bedef98c1deae676ae03041719de98d3b57f1`:

| Reference file                           | SHA-256                                                            | Bounded seven-token screen against current file |
| ---------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| `src/client/common/bookmark-schemas.js`  | `e28de3df1bdd937a9d964e4da62c8b9c4a9df36f5d5046877a4f1c10c3662e69` | 99 shared shingles; 0.149 containment           |
| `src/app/common/bookmark-zod-schemas.js` | `f6204872f43f4dab8a858323c66d63cd7e049325d57d836270270f56afb63427` | 76 shared shingles; 0.137 containment           |

The screen normalizes string and number literals, so a score is neither a
copied-code percentage nor a rights conclusion. A separate literal syntax
scan for `key: z.*` found 76 distinct current property names; 25 overlap
the client reference's 63 names and 18 overlap the app reference's 54 names.
That scan misses imported schema aliases, object spreads and runtime meaning;
its only purpose is to route manual review. Shared names include protocol
settings such as `baudRate`, `dataBits`, `parity`, `rtscts`, `xon`, `xoff` and
`xany`. The current serial defaults for 9,600 baud, `\r` line ending,
`\x01ky` close sequence and 500 ms delay parallel choices described in the
reference. Which choices are functional conventions and which, if any,
require source attribution is a reviewer decision.

## Current Axterm boundary that must not be lost

The reference describes flat bookmarks with inline `password`, `privateKey`
and related fields. The current Axterm Contract instead separates Host and
Bookmark aggregates, stores saved secrets by `credentialRef`, uses strict
versioned DTOs, and validates protocol-specific settings and update/create
operations. It also rejects secret fields in AI bookmark drafts. The focused
`bookmark-contract-boundaries.test.ts` proves FTP settings and bookmark input
reject an inline password, AI drafts reject an inline password, and the
existing serial defaults are explicit. It passed **2/2**, with typecheck.

Therefore this triage does **not** scramble or rename persisted fields merely
to lower a similarity metric. Doing so would change the Contract, migration
and existing users' data without establishing an independent rights basis.
The next action is a named source-rights review of exact code expression,
field/default provenance and retained distribution terms. If that review
requires a default or schema change, specify the product behavior, migration
and old/new data tests first, then implement and re-review the changed bytes.
This record does not mark W-02-01, W-02-03 or IR-02 accepted.
