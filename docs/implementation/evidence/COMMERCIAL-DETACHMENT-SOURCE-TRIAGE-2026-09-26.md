# Commercial-detachment source triage — 2026-09-26

Status: the fixed-reference candidate set is **closed for the requested
engineering commercial-detachment scope** after the replacements, owner
attestations and checks below. This is not a legal opinion or formal-release
signoff.

## Inputs and bounded method

- Current independent local Git root: 596 tracked JS/TS/TSX/MJS/CJS files.
  Fixed controlled reference snapshot at commit
  `799bedef98c1deae676ae03041719de98d3b57f1`: 756 code files,
  including its tests. The original bytes stay outside this Git root.
- A temporary TypeScript-scanner comparison normalized string and numeric
  literals, formed unique 10-token shingles and reported file pairs with at
  least 25 shared shingles. It found 24 pairs. This is a routing screen, not
  a measure of copied code, and cannot detect every form of adaptation.
- An exact trimmed-line check on those 24 pairs found one identical 45+-character
  shell collector line and one generic blank trigger-match object initializer.
  The collector line was replaced with a Linux `/proc/stat` first-line sampler;
  the generic initializer remains because it is the current form's data shape.
  No other long identical source line was found within the reported pairs.

## Candidate disposition

| Candidate                                     | Current finding and action                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RDP scan-code map                             | 106 shared normalized shingles reflect the same keyboard facts. The current 84-key table was regenerated from pinned Chromium BSD-licensed data with its source and notice; see [RDP lineage](W02-03-RDP-KEYBOARD-LINEAGE-2026-09-25.md).                                                                                                                                                                                               |
| Four terminal palettes and their test fixture | 75 shared normalized shingles reflect terminal-theme field names. The earlier literal comparison found zero exact key/color pairs against the two fixed reference theme defaults; see [theme comparison](W02-03-MONITOR-THEME-SIMILARITY-2026-09-25.md). The owner confirmed in this task on 2026-09-26 that these palettes are their own design or authorized for Axterm's Apache-2.0 commercial use.                                  |
| Trigger UI, engine tests and preset fixture   | 34–41 shared shingles concern the rule field structure and common pager/password-prompt behavior. The former preset array was replaced by an opt-in factory with different rule values and tests; see [preset replacement](W02-03-BOOKMARK-TRIGGER-PRESETS-2026-09-25.md). One generic empty-text match initializer remains in the form.                                                                                                |
| Bookmark Contract                             | 42–50 shared shingles in this 10-token run; the earlier 7-token screen found more. Retained protocol names/defaults are functional data, while the current implementation separates Host/Bookmark aggregates, secrets by `credentialRef`, strict versioned DTOs and bounded validators; see [Contract triage](W02-03-BOOKMARK-CONTRACT-LINEAGE-2026-09-25.md). No long identical line in the reported pair.                             |
| Quick Connect                                 | 38 shared shingles in the parser and 37 in tests, primarily protocol/option names and default values. The current URL-based bounded parser has typed targets, ephemeral secrets, grants and per-protocol option validation; the fixed reference manually slices connection strings into a mutable options object. No long identical line in the reported pairs. Product behavior compatibility alone is not source-expression identity. |
| Runtime monitor and UI                        | The prior long network collector and CPU/memory expression were replaced; see [Runtime replacement](IR02-RUNTIME-MONITOR-SOURCE-REPLACEMENT-2026-09-26.md). This pass found one retained aggregate-CPU shell line, now changed to `head -n 1 /proc/stat` twice. Current file SHA-256: `36e9f2f2278a7a090335d8ca6babc14c06b8d4e4123e6e3374f744e440e15295`. Other overlap consists of terminal-information fields and UI model names.     |
| Window preference and Zod tests               | Two low-containment pairs (0.035 and 0.019) share test/framework vocabulary; no long identical line.                                                                                                                                                                                                                                                                                                                                    |

Engineering disposition: retain the current RDP map with its separate Chromium
license, owner-authorized palettes, opt-in trigger implementation, functional
Bookmark Contract and URL-based Quick Connect parser. Retain the generic blank
trigger field initializer as form data; replace the last identical monitor
collector line. No candidate in this bounded review requires copying the
fixed reference implementation into the new source root.

The changed CPU command returned two aggregate samples in an Alpine Linux
container; the actual output parsed to a bounded percentage. Existing model
and service tests exercise CPU calculation and command dispatch. Full
`bun run check` passed: 1,220 unit/integration and 21 visual/accessibility
tests, architecture/Contract/source/license checks and production build. An
unsigned current-source Mac directory app was built; its `app.asar` SHA-256 is
`aef0cbea43106ea30a022f5389828400a9539aab296ebe28d707d54869a62be6`.
The current app's path/bytes name scan found zero matches, and two packaged
legal-text/About tests passed.

## Limits and next decision

This comparison covers one pinned reference commit and source-code file types,
not all old history, binary assets, visual similarity or unstated third-party
claims. Prior style and locale comparisons are separate evidence. The owner's
attestation covers their own/authorized code contributions, AX mark, four
language catalogs and four terminal palettes, but does not itself prove that a
fixed reference's expression was never adapted. Do not claim copyright
non-infringement from the scanner or
remove an applicable third-party notice merely to achieve a name-free tree.
The concrete candidates above have engineering retain/replace decisions for
this task. The full historical release board and later publication's qualified
rights, platform and signing reviews are not retroactively marked complete.
