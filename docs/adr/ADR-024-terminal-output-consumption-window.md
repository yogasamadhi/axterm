# ADR-024: Terminal output consumption window

Date: 2026-10-03
Status: Accepted; local acceptance and new Mac candidate verification passed under OP-09.

## Context

Visible production Electron measurements on macOS arm64 passed the fixed 1/4/8 native PTY
profiles: 8/32/64 MiB finite bursts, retained-tab search, real Ctrl+C and minimized-window recovery.
The initial finite-burst parser pending peak was at most 128 KiB. These observations do not impose
a hard bound under a slow parser: Runtime currently observes only `ws.bufferedAmount`, and updates
the client replay cursor when sending, before xterm has parsed the bytes.

The [xterm flow-control guide](https://xtermjs.org/docs/guides/flowcontrol/) describes its public
write completion callback and the need for consumption feedback across WebSocket. Parser completion
is distinct from painting. The profiles, machine conditions and fixed ceilings live in
`docs/implementation/PERFORMANCE_BUDGETS.md`; they are not raised for this decision.

## Decision

- Retain Level 1, REST business operations and Binary WS terminal data. No Electron business IPC,
  Main/Runtime RPC, dynamic plugin or new provider dependency is introduced.
- Negotiate consumption accounting with the additional non-secret `terminal-flow.v1` subprotocol
  alongside existing `terminal.v1`, client identity and generation-scoped authentication. Desktop
  Client requests it. Auth/origin/loopback checks remain unchanged. Existing headless/raw clients
  without the new subprotocol retain their existing transport behavior.
- A negotiated socket receives a fresh UUID stream identity in its validated `ready` control.
  Every replacement/generation starts new byte counters. Binary frames remain ordinary terminal
  bytes, at most 64 KiB each on the negotiated path. Replay counts against the same window.
- After xterm's public write callback, Renderer sends a Zod-validated text control containing that
  stream identity and cumulative consumed raw bytes. Counts are safe, nonnegative integers.
  They cannot decrease or exceed bytes sent by that exact live socket. Invalid or retired stream
  acknowledgements grant no credit and never reach PTY stdin.
- Runtime pauses the shared source when any negotiated attachment has at least 256 KiB outstanding,
  and resumes at or below 64 KiB only when all output/transport/recording pause owners permit it. Parser
  acknowledgements batch 32 KiB or flush within an owned 25 ms timer. The deadline releases
  tiny-frame producers below the batching threshold; no timer grants unconsumed credit.
- Outstanding output is hard-capped at 512 KiB per negotiated attachment. Frame checkpoints are
  separately bounded; tiny chunks cannot create an unlimited ledger. In-flight adapter overshoot or
  oversized source output that exceeds a hard cap produces an explicit terminal error and retires
  that attachment. It is not silently discarded or copied into an extra queue. Other clients retain
  their own identities, credit and cursors.
- Runtime advances negotiated replay cursors only for whole source chunks covered by parser
  acknowledgement. Reattach within retained history can replay unconsumed output. The existing
  128 KiB replay cap and explicit truncation notice remain; no full terminal history is promised.
- Renderer meters and guards raw bytes before decoding, bounds parser input, retains no extra byte
  queue and keeps bytes out of React/Zustand. Its delayed callbacks belong to one terminal lifetime;
  they cannot acknowledge a new socket or act after disposal. Parser metrics contain numbers only.
- Each socket attachment removes its owned message/open/close/error listeners deterministically.
  Detach, close and generation teardown release pause ownership. The bounded flush timer carries consumed counts only. No timer disconnects a legitimately
  suspended desktop or resumes output without consumption evidence.

## Validation required

Verify exact bytes and boundaries with delayed-parser tests: pause/resume hysteresis, partial and
duplicate consumption, wrong stream, over-acknowledgement, tiny-frame capacity, overshoot, multiple
clients, replay, old socket events, recording/transport ownership and shutdown. Run the same visible
1/4/8 Electron profiles and preserve their pre-change reports. Also run real SSH, reconnect/restart,
terminal-native transfer regressions, Architecture/Contract gates and `bun run check`. New Mac
candidate validation belongs to OP-09. Windows/Linux native acceptance remains unperformed.

## Consequences

Nominal throughput may include more small control frames; the fixed latency/throughput gates must
pass without changing their ceilings. A blocked consumer applies real backpressure to its source,
including a shared terminal with multiple viewers. This is explicit terminal streaming behavior,
not a business operation or a durable event. Negotiated state and cursors remain process-local;
tokens, terminal content and model reasoning are not persisted by this mechanism.

## Local acceptance

The [OP-03 evidence](../implementation/evidence/local-optimization/OP-03-2026-10-03.md)
records delayed-consumer boundaries, shared recording/transport ownership, real SSH/PTY desktop
regressions, before/after visible measurements and the final full gate. The final build passed the
unchanged 1/4/8 profiles and J-09; 1,276 unit/integration and 21 visual/accessibility tests passed.
Five files / 38 tests retained their existing conditional skips. New packaged and Windows/Linux
native acceptance are not inferred from these results.
