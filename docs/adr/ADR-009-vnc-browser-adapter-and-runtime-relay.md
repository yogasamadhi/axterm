# ADR-009: noVNC browser adapter and Runtime byte relay

Status: Accepted  
Date: 2026-09-13

## Context

Electerm 5.5.0 embeds `@novnc/novnc` 1.7.0. noVNC owns the browser Canvas,
keyboard and pointer integration and speaks RFB over WebSocket. Electerm relays
that byte stream through its local server to a direct, proxied or SSH-forwarded
TCP target. Its visible settings include username/password, view-only, clipped
or scaled viewport, JPEG quality, compression, shared access and dot cursor.

The published noVNC client requires browser DOM APIs, so it cannot run inside
the Node Core Runtime. Letting feature components select an arbitrary WebSocket
target, own a vendor object or retain a saved password would violate Axterm's
client and credential boundaries.

## Decision

Axterm pins `@novnc/novnc` 1.7.0 and loads it only through a dedicated
`VncCanvasAdapter`. React receives typed state callbacks and controls; the
adapter alone owns the `RFB` object. Runtime owns the VNC Bookmark, resolved
Profile and application-local Vault references, target route and bounded
session. A `VncRelay` port streams opaque binary frames between an authenticated
`vnc.v1` WebSocket and a direct/proxied/SSH-forwarded TCP connection.

The WebSocket uses the generation token in `Sec-WebSocket-Protocol`; no secret
or bearer token enters a URL. Runtime chooses the only permitted target before
attaching. A single-use, authenticated, `no-store` bootstrap gives the adapter
the username/password required by noVNC and immediately clears the Runtime
copy. The adapter supplies it only to the RFB handshake, clears the transient
object as soon as the connection event proves authentication finished and never
puts it in React state, Query, Zustand, storage or logs. Reconnect creates a new
Runtime session and claim.

The relay caps client frames, socket queues, session count and connection time.
Every WebSocket, TCP/SSH stream, abort listener and owned hop is closed in
reverse order. View-only disables outbound pointer/keyboard and local clipboard
updates through noVNC itself. Renderer-visible settings map directly to noVNC's
public API; private upstream monkey patches are excluded.

## Consequences

VNC remains an embedded cross-platform session without a native executable or
Electron business IPC. Saved secrets remain encrypted in the application-local
Host Vault. The credential bootstrap extends the narrow browser protocol
adapter exception first established by ADR-008; it is not a reusable credential
read API.

F-05 can become Implemented with migration, session, relay, adapter, workspace,
form and production bundle evidence. Certification still requires a live VNC
fixture for authentication, view-only, clipboard, quality/compression and
scaling, plus packaged macOS/Windows/Linux visual evidence.

## Alternatives considered

- A Node RFB client was rejected because it would duplicate mature noVNC input
  and Canvas behavior and diverge from the pinned product baseline.
- A webview was rejected because it adds a second navigation/security surface.
- Electerm's token query and global RFB object were rejected because they expose
  authentication in URLs and hide ownership.

## Migration / rollback

SQLite adds one nullable VNC payload column. Existing rows remain valid.
Removing the feature drops no existing secret: orphaned local Vault entries use
the existing reference cleanup path.
