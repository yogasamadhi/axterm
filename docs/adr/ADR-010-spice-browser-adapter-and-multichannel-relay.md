# ADR-010: SPICE browser adapter and bounded multichannel relay

Status: Accepted  
Date: 2026-09-13

## Context

Electerm 5.5.0 loads `spice-client` 1.2.0 in the Renderer and relays every SPICE
main/display/input/cursor/playback channel through WebSocket-to-TCP connections.
The browser library owns Canvas and input behavior and creates additional
WebSockets after the main channel advertises them. Electerm puts the token in the
URL and keeps global session/proxy maps with unbounded pending arrays.

## Decision

Axterm pins `spice-client` 1.2.0 behind a dedicated `SpiceCanvasAdapter`.
Runtime owns the Bookmark target, application-local Vault password resolution,
direct/custom-proxy/SSH-forward routing and an eight-session registry. Each
session accepts at most sixteen authenticated `spice.v1` channel WebSockets; each
channel receives its own bounded TCP stream and deterministic cleanup handle.

The exact-URL WebSocket registration may be consumed only sixteen times and is
removed when the adapter disconnects. Every channel carries the current Runtime
generation token in `Sec-WebSocket-Protocol`; credentials and auth tokens never
enter URLs. The password is provided by a single-use, no-store session bootstrap,
kept outside React/Query/Zustand/storage/logs, and cleared after the main SPICE
connection succeeds and its child-channel construction window ends, no later
than five seconds after success.

Renderer options map only to public `spice-client` APIs. View-only suppresses
input at the adapter DOM boundary. Scale mode uses the vendor `scale_view` option
and bounded CSS geometry. Pointer coordinates are corrected before vendor input
handlers observe a scaled Canvas. Runtime never imports the browser package and
Renderer never chooses a network destination.

## Consequences

SPICE remains an embedded session with no helper executable or Electron business
IPC. The production bundle must contain one separately loaded SPICE client chunk.
A live SPICE server and packaged platform journeys remain certification evidence.

## Alternatives considered

- A native helper process was rejected because the pinned baseline already uses
  the maintained browser client and no native feature is required.
- Reusing the VNC session endpoint was rejected because SPICE has different
  multi-channel ownership and authentication semantics.
- Query-string auth and unrestricted WebSocket interception were rejected because
  they would expose credentials or widen the Renderer trust boundary.

## Migration / rollback

SQLite adds one nullable SPICE Bookmark payload and Connection Profiles gain a
default empty SPICE password section. Existing rows parse with these defaults.
