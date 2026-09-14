# ADR-013: Runtime-owned terminal transfer protocol adapters

Status: Accepted  
Date: 2026-09-13

## Context

Electerm detects ZMODEM and trzsz control sequences inside terminal output and
implements XMODEM as an explicit terminal action. Its server handlers own the
wire state machines and local file streams, while the Renderer sends absolute
paths and protocol control messages over the terminal WebSocket. Axterm cannot
expose local paths to Renderer or add business messages to the Binary WebSocket.

`zmodem2` 1.4.0 and `trzsz2` 1.2.0 are pure JavaScript protocol engines used by
the pinned Electerm 5.5.0 baseline. The XMODEM implementation is maintained in
Electerm itself.

## Decision

Axterm adapts the pinned Electerm ZMODEM, XMODEM and trzsz state machines inside
the Runtime Adapter layer. `zmodem2` and `trzsz2` are exact Runtime dependencies.
The adapted source keeps the upstream MIT attribution and is recorded in
`docs/implementation/UPSTREAM.md`; protocol logging is replaced by a no-op facade
because upstream errors may contain private local paths.
The published `trzsz2` 1.2.0 package points its type export at a file it does not
ship, so a committed Bun patch redirects the declaration path to its shipped
`dist/esm/lib/index.d.ts`; runtime JavaScript is unchanged.

`TerminalService` remains the owner of terminal channels and Binary WebSocket
bytes. It exposes a narrow interceptor port to the terminal-transfer Application
Service. The interceptor may consume protocol frames, write raw protocol bytes,
publish a validated server control state, and is disposed whenever the terminal
closes. Normal bytes continue through the existing replay/backpressure path.

Renderer starts XMODEM or answers an automatically detected ZMODEM/trzsz selection
request through generated REST. Native selection returns only an opaque File Grant.
Runtime resolves that grant through Desktop Host immediately before opening a
stream. Public transfer state contains only file names, byte counts, speed, direction,
state and safe error codes. Absolute paths never enter Renderer, terminal controls,
Realtime events, logs or business SQLite.

At most one transfer runs per terminal. File and pending wire buffers, protocol
retries and timeouts are bounded. Cancel, terminal exit, socket loss, Runtime
shutdown and generation replacement close descriptors and streams, clear timers,
revoke temporary state and restore ordinary terminal output deterministically.
Partial downloads use a same-directory Axterm temporary file and are renamed only
after protocol completion; cancellation and failure remove it.

## Consequences

Terminal transfer protocols reuse Axterm's authenticated REST, File Grant and
Binary WebSocket boundaries while retaining Electerm-compatible wire behavior.
The pure JavaScript dependencies do not add a native ABI or helper process. Full
acceptance requires bidirectional protocol fixtures, cancellation, timeout,
bounded-memory tests, visible progress/error states and packaged evidence on all
three desktop platforms.

## Alternatives considered

- Sending paths in terminal WebSocket control messages was rejected because it
  exposes Desktop Host authority to Renderer and makes the data channel business RPC.
- Running protocol engines in Renderer was rejected because it would require direct
  filesystem access or whole-file browser buffers.
- Shelling out to `rz`, `sz`, `trz` or `tsz` locally was rejected because it adds an
  untracked executable dependency and platform-specific process boundary.
