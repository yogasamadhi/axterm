# ADR-012: Deep-link Runtime ingress and transient intent queue

Status: Accepted  
Date: 2026-09-13

## Context

Electerm registers SSH and auxiliary session schemes with Electron, receives
startup arguments, macOS `open-url` events and second-instance command lines,
then sends the parsed target to Renderer over business IPC. Axterm permits only
the narrow `desktop:bootstrap` Renderer/Main IPC and cannot add an `open-tab`
channel. Deep links may contain one-use credentials and can arrive before the
Runtime or Renderer is ready.

## Decision

Desktop Host registers `ssh`, `telnet`, `vnc`, `rdp`, `spice`, `serial`, `ftp`,
`axterm` and Electerm-compatible `electerm` schemes in packaged builds. It does
not register `http` or `https`. The Electron entry acquires the single-instance
lock before creating desktop resources and collects links from initial argv,
macOS `open-url` and `second-instance`. Inputs are capped at 16 KiB and the
pre-Runtime queue is capped at 32 entries.

Main forwards each input over loopback HTTP to an exact Runtime ingress route.
The ingress uses a separate random bearer token delivered only in the existing
generation startup envelope. It is unavailable in Headless mode and is not
given to Renderer. Main/Runtime process messages remain lifecycle-only.

Runtime parses the input with the platform-neutral bounded Quick Connect parser
and stores at most 32 two-minute, memory-only intents. Malformed inputs become a
secret-free rejected intent so the active window can show feedback. A normal
Runtime API atomically claims the next intent with `Cache-Control: no-store`;
Realtime SSE only signals availability. Renderer parses the claimed source once,
opens SSH directly through the existing Quick Connect flow, or opens the matching
protocol form with validated values prefilled. It clears the intent and any
temporary credential when the action closes.

Window focus/restore is a Desktop Host concern. Session creation, Bookmark forms
and error feedback remain normal Runtime/Renderer business behavior.

## Consequences

Deep links work before and after Renderer startup without business IPC or
persistent secrets. The private ingress is a new authenticated HTTP boundary and
must be covered by malformed, stale-generation, queue-capacity, startup-argv,
macOS event and second-instance tests. OS registration and installed-app behavior
remain platform certification evidence.

## Alternatives considered

- Renderer business IPC was rejected because it violates the Level 1 boundary.
- Adding intents to `desktop:bootstrap` was rejected because bootstrap is limited
  to Runtime discovery and authentication.
- Persisting pending links was rejected because links can contain credentials.
- Registering HTTP/HTTPS was rejected because it would compete with the user's
  default browser.
