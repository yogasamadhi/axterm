# Phase 21 long-run reliability

Updated: 2026-09-14

This ledger defines the repeatable evidence for Matrix J-01. The certification target is 30 minutes.
The former longer target and its pending exception have been deleted. The user explicitly accepted
the existing 31-minute run and directed that it must not be rerun.

## Workload

The test starts the production headless Runtime with a persistent SQLite profile and the real
`ssh2` and `node-pty` adapters. A digest-pinned disposable OpenSSH endpoint is used only by the
repository test; it is not part of the application, Runtime, installer or end-user prerequisites.
One SSH connection, SSH terminal, Binary WebSocket, realtime SSE subscriber and authenticated MCP
server remain open while a one-second cycle performs:

- local PTY create/close and an SSH terminal command round trip;
- Terminal Information sampling and SFTP directory browsing;
- a temporary static-file Widget request and deterministic shutdown;
- every second cycle, a streamed SFTP upload, completion check, remote deletion and history clear;
- every third cycle, a dynamic SOCKS tunnel start/stop;
- every fifth cycle, an authenticated MCP `system.inspectMemory` call.

Each cycle checks the Runtime diagnostic registry after transient work closes. The persistent owners
may account for one terminal, Trigger session, connection, Widget and SSE subscriber; the Terminal
Information cache may retain at most 64 sessions. Every other resource must return to zero. A normally
completed run closes all persistent owners and requires every resource except the single Desktop
lifecycle poll owner to be zero.

## Persistent bounds and budgets

Replayable Domain Events retain the newest 10,000 cursors. Pruning preserves monotonic cursor ids,
so a client behind the retained range receives the existing `cursor.invalid` reset event. Every
idempotent operation retains at most 2,000 receipts when its service does not declare a smaller cap.
Both defaults have direct SQLite tests.

The report applies these regression ceilings after explicit garbage collection at each checkpoint:

| Measurement                       | Ceiling |
| --------------------------------- | ------: |
| Peak RSS growth from baseline     | 256 MiB |
| Peak used-heap growth             | 128 MiB |
| SQLite + WAL + SHM growth         | 128 MiB |
| Event-loop delay p99              |  500 ms |
| Mixed-cycle operation latency p95 |     8 s |

The report writer stores only timestamps, counters, resource counts, process-memory values, database
sizes and latency summaries. Credentials, grants, terminal output and endpoint details are excluded.

## Commands

Run the reproducible one-minute fixture check with:

```sh
bun run test:soak:smoke
```

Run a new 30-minute certification only when explicitly requested:

```sh
bun run test:soak:30m
```

The 30-minute command writes `test-results/phase21-soak/latest.json` and then runs
`scripts/verify-phase21-soak.mjs`. The independent verifier accepts only a `passed` report whose
wall-clock and measured duration reach 30 minutes, whose workload contains at least 1,500 cycles and
30 continuous checkpoints, whose operation counters agree, whose five measurements stay below their
ceilings, and whose final owners are zero except for the single allowed Desktop lifecycle poller.
Unknown future owner names cannot bypass the zero-owner rule. A running, shortened, interrupted,
leaked or budget-violating report fails. `bun run test:soak:verify` rechecks a retained report without
starting the workload.

## Accepted evidence

The first extended macOS arm64 attempt exposed a real local-terminal lifecycle defect after 506
successful mixed cycles: node-pty's macOS `pty_posix_spawn` guard leaked one temporary descriptor per
spawn. Axterm now destroys and waits for each native PTY, and `patches/node-pty@1.1.0.patch` fixes the
native count/close indexes. A separate 100 ms regression then passed 729 cycles, 364 transfers, 243
tunnels and 145 MCP calls with no violations and final zero-owner cleanup.

The next macOS arm64 run started at `2026-09-14T00:21:19.745Z` and stopped at
`2026-09-14T00:52:47.412Z`. It ran for 31 minutes 27.667 seconds, and its last checkpoint elapsed
30 minutes 11.452 seconds. It completed 1,812 PTY/SSH/SFTP/Widget cycles, 906 transfers, 604 tunnels
and 362 MCP calls with zero recorded violations. Peak growth remained within every ceiling: RSS
3.42 MiB, heap 10.07 MiB and database 6.46 MiB; event-loop p99 was 22.61 ms and operation p95 was
232.00 ms.

That run was stopped under the former target, so it did not execute its normal final-close block. The
separate 729-cycle regression and 60-second smoke both completed normally and returned terminal,
connection, transfer, tunnel, Widget and SSE owners to zero. On 2026-09-14 the user replaced the old
target with 30 minutes, accepted this existing run plus the cleanup regressions, and explicitly directed
that no new long-run test be started. The composite, non-sensitive evidence is retained at
`docs/implementation/evidence/J01-30M-CERTIFICATION-2026-09-14.json`. J-01 is Certified against the
current 30-minute target.
