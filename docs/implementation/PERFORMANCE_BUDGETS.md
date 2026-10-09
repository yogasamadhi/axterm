# Phase 21 performance budgets

Updated: 2026-10-03

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
| Terminal output     | Consume 64 MiB as 1,024 × 64 KiB binary chunks                                |                  1,000 ms |                         4,000 ms | Replay memory never exceeds `TERMINAL_REPLAY_MAX_BYTES` (128 KiB)                                 |
| Transfer history    | Query the visible history from 10,000 persisted records                       |                    100 ms |                         1,500 ms | Runtime returns at most 500 records; active work is capped at 32 and the center mounts at most 20 |

The file and bookmark surfaces calculate one virtual window shared by the production React
components and the profiles. Scroll positions beyond the data extent clamp to an empty terminal
window instead of producing an invalid slice. Terminal bytes continue directly to xterm/WS owners;
the profile observes only the Runtime replay buffer. Transfer history measures one bounded SQLite
read and does not materialize all 10,000 rows in Renderer state.

## Earlier J-09 evidence

The following timings are retained from the earlier J-09 profiles; they do not describe the
optimized OP-03/OP-09 build. Current OP-03 limits and dated final measurements are below.

On the macOS arm64 host used for that recorded run, `tests/unit/performance-budget.test.ts` passed all four profiles.
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

## OP-03 production Electron profiles

The existing terminal row above observes Runtime replay retention. It does not certify xterm
consumption, browser receive queues, drawing, input latency or process RSS. The source constant is
128 KiB; the earlier 80 KiB prose was stale. Its existing 64 MiB / 4,000 ms gate remains unchanged.

The following ceilings are fixed before collecting the OP-03 baseline or changing flow control.
Baseline reports can fail these ceilings; they are measurements, not acceptance. A failing result
does not increase a ceiling. Final acceptance requires every profile below to pass.

| Profile                          | Fixed load and observation                                                                                                                                                                                                                | Acceptance ceiling                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 / 4 / 8 local terminals        | Fresh production Electron at 1440×900, 100% zoom; real native PTYs with isolated `/bin/sh` profiles; 8 MiB per terminal as repeated 64-byte ASCII/CRLF rows, released by one barrier file; one active tab and the remaining retained tabs | All write callbacks drain within 30s; aggregate throughput at least 1 MiB/s; no missing final marker                                                            |
| Parser consumption               | Count raw Binary WS bytes handed to xterm and acknowledge only its public `write` callback; no terminal text in metrics                                                                                                                   | Per-terminal pending input peak ≤512 KiB; all pending bytes return to zero after a finite burst; callback latency peak ≤2,000 ms                                |
| Process memory                   | Sum Electron `getAppMetrics()` working sets for the same app, including its utility Runtime; sample before, during and after the burst                                                                                                    | Peak growth above the post-startup baseline ≤256 / 512 / 768 MiB for 1 / 4 / 8 terminals; report absolute peak and process count as well                        |
| Input and interruption           | After the finite burst, input an exact generated marker; run `yes` in the active real PTY, then send Ctrl+C and a fresh marker                                                                                                            | Input echo and interrupt-to-new-marker each ≤1,500 ms; flood stops; no keystroke is silently dropped                                                            |
| Retained tab recovery and search | Activate every background tab after its burst, render its unique final marker, search the marker, return to the first tab                                                                                                                 | Each activation/marker and search ≤1,500 ms; retained instance ID and output preserved                                                                          |
| Window suspension and recovery   | In each 1 / 4 / 8 profile, run a second 8 MiB burst in the first terminal while minimizing the native window for 500 ms, then restore/focus the same window                                                                               | Same 512 KiB parser pending ceiling; restoration-to-final-marker ≤1,500 ms; exact profile bytes consumed and pending bytes return to zero                       |
| Ownership                        | Close the app and all fixture files/processes; separately test disposal while a write callback is pending and generation/socket replacement                                                                                               | No retained callback updates or resumes the disposed/replaced owner; counters/timers/listeners cleaned; old socket acknowledgements cannot release a new socket |

Run these profiles with a visible window. Record CPU model, logical cores, OS/architecture, total
RAM, load average, visibility, viewport, zoom, exact load, sampling interval and measurement method
in the report. A hidden run is useful for functional regressions, but cannot be substituted for the
visible baseline or final drawing/focus evidence. Mac arm64 results do not certify Windows/Linux.
Parser completion is distinct from painting; the marker/activation checks observe the subsequent
painted DOM. RSS is a sum of per-process working sets, not unique physical memory or a heap proof.

Flow-control changes that add WS controls require an ADR first. They must keep output as binary,
validate text controls with Zod, bound outstanding bytes, reject acknowledgement beyond what that
socket sent, and cover replay, multiple sockets, replacement, restart and transfer/recording pause
ownership. No extra unbounded Renderer queue or terminal bytes in React/Zustand are permitted.
