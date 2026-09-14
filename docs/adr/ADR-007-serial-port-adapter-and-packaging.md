# ADR-007: Serial port adapter and native packaging

Status: Accepted  
Date: 2026-09-13

## Context

Electerm 5.5.0 exposes a Serial terminal with a selectable device path, baud
rate, data bits, stop bits, parity, lock, hardware/software flow control and
transmit/receive line-ending conversion. Axterm needs the same observable
behavior without allowing the Renderer or Electron Main process to import or
own a SerialPort instance.

The maintained `serialport` package uses `@serialport/bindings-cpp`, a native
Node addon. The Desktop Runtime runs inside Electron's embedded Node, while the
headless Runtime uses the host Node. A bundled native addon cannot be loaded
from ASAR and must match the active Node ABI.

## Decision

Axterm pins `serialport` 13.0.0, matching the fixed Electerm baseline. The
Core Runtime owns a narrow `SerialTransport` port and a Node Adapter. Bookmark
and terminal Application Services depend only on the port. The Renderer uses
the existing REST terminal creation route and authenticated Binary WebSocket;
it never imports `serialport`, lists devices directly or receives a native
handle.

Serial device enumeration is a read-only Runtime operation exposed through the
versioned REST Contract. Opening a terminal validates every line setting,
registers one channel with `TerminalService`, bounds line-ending transforms and
closes the port deterministically on terminal close, Runtime shutdown, open
failure or generation change. Serial sessions do not claim resize support.

Saved Serial bookmarks contain device and line settings only. Serial has no
saved secret, so it does not add a credential storage path. Workspace snapshots
retain the Bookmark ID and show sessions from an old generation as disconnected;
reopening is always an explicit user action.

`serialport` remains external in both Runtime builds. Packaging includes the
minimal JavaScript packages and `@serialport/bindings-cpp` runtime files,
unpacks only its native binaries, and rebuilds that addon together with
`node-pty` for the target Electron version, platform and architecture. A mock
port implementation exercises open/data/write/line-ending/close behavior in
ordinary tests. Packaged native enumeration/load is required separately on
macOS, Windows and Linux before F-03 can be Certified.

## Consequences

Serial terminal behavior stays behind the Level 1 Runtime boundary and shares
the existing terminal buffering, WebSocket backpressure and cleanup rules. The
native package increases the installer and platform test surface, so Phase 10
and Phase 21 remain open until all three packaged targets load the rebuilt
binding and enumerate devices without relying on a system Node installation.

The mock evidence can move F-03 to Implemented, but cannot substitute for
physical-device or packaged native evidence. A platform that has no connected
serial device must still prove addon loading and an empty or system-provided
device list.

## Alternatives considered

- Access Web Serial from Chromium: rejected because support and permissions
  differ across packaged desktop platforms and would move the device owner into
  the Renderer.
- Invoke a command-line serial client: rejected because availability, byte
  framing, cancellation and lifecycle cannot be controlled consistently.
- Reuse Electerm's global session object: rejected because it bypasses Axterm's
  Application port, Contract and terminal ownership model.

## Migration / rollback

SQLite adds one nullable Serial payload column. Older rows continue to read as
non-Serial bookmarks. If the native addon cannot load, the Runtime reports the
Serial capability as unavailable with a typed error while all other terminal
and connection protocols remain usable. Removing the feature does not require
rewriting existing bookmark rows.
