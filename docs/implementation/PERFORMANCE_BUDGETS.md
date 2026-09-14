# Phase 21 performance budgets

Updated: 2026-09-14

This ledger defines the J-09 response and capacity budgets. The limits are regression ceilings for
the slowest supported CI runner; they are deliberately higher than the normal interaction target.
Every profile uses production code paths and fixed input sizes so a faster developer machine cannot
hide an unbounded algorithm or DOM.

## Budgets

| Surface             | Fixed profile                                                                 |             Normal target |                Automated ceiling | Capacity assertion                                                                                |
| ------------------- | ----------------------------------------------------------------------------- | ------------------------: | -------------------------------: | ------------------------------------------------------------------------------------------------- |
| Bookmark tree model | Project 10,000 Bookmarks and search the final item                            |                    100 ms |      1,500 ms for each operation | 10,001 unique rows, one exact result, no recursion/cycle issue                                    |
| Bookmark tree UI    | Load, expand, search and scroll a 10,000-Bookmark tree in production Electron | 500 ms per visible update | 3,000 ms expand; 1,500 ms search | At most 64 tree rows mounted; full 260,026 px logical spacer retained                             |
| File table          | Filter and modified-time sort 10,000 local directory entries                  |                    100 ms |                         1,500 ms | Fixed 32 px rows and six-row overscan keep every tested window at 32 rows or fewer                |
| Terminal output     | Consume 64 MiB as 1,024 × 64 KiB binary chunks                                |                  1,000 ms |                         4,000 ms | Replay memory never exceeds `TERMINAL_REPLAY_MAX_BYTES` (80 KiB)                                  |
| Transfer history    | Query the visible history from 10,000 persisted records                       |                    100 ms |                         1,500 ms | Runtime returns at most 500 records; active work is capped at 32 and the center mounts at most 20 |

The file and bookmark surfaces calculate one virtual window shared by the production React
components and the profiles. Scroll positions beyond the data extent clamp to an empty terminal
window instead of producing an invalid slice. Terminal bytes continue directly to xterm/WS owners;
the profile observes only the Runtime replay buffer. Transfer history measures one bounded SQLite
read and does not materialize all 10,000 rows in Renderer state.

## Evidence

On the current macOS arm64 host, `tests/unit/performance-budget.test.ts` passed all four profiles.
The Vitest JSON reporter measured whole-test durations of 9.41 ms for tree projection/search,
28.14 ms for directory filter/sort/windowing, 61.47 ms for the 64 MiB terminal stream and 79.97 ms
for seeding plus querying the transfer history. These durations include assertions and fixture work,
so each measured operation is below the reported number.

`tests/e2e/performance.spec.ts` passed in 1.2 seconds for the complete production-Electron journey.
It loaded the Runtime-backed tree, expanded 10,000 children, kept 37 rows mounted at the default
1440×900 window, found the final Bookmark, cleared the filter and scrolled to the final row. The test
asserts the per-action ceilings and a cross-viewport maximum of 64 mounted rows. The three-platform
CI workflow runs the same project together with the desktop and accessibility projects.

Run the gates with:

```sh
bunx vitest run tests/unit/performance-budget.test.ts
bun run test:performance
```

Long-duration resource certification remains J-01. Real Windows/Linux installed-app measurements
remain J-04/J-05. A slower supported runner may motivate a documented platform-specific ceiling only
after its trace identifies platform overhead; an individual failing scene does not raise this shared
budget.
