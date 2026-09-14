# ADR-008: RDP WASM canvas adapter and Runtime relay

Status: Accepted  
Date: 2026-09-13

## Context

Electerm 5.5.0 implements its embedded RDP session with `ironrdp-wasm` 1.1.0.
The browser-side protocol engine renders to an `HTMLCanvasElement` and sends
RDCleanPath frames over WebSocket to a local relay, which owns the TCP, X.224 and
TLS connection to the RDP server. It supports CredSSP, keyboard and pointer
input, clipboard, dynamic desktop size and the cross-platform Canvas surface.

Running this package directly from ordinary React feature code would give the
UI a vendor session object and an unscoped transport URL. Running it inside the
Node Runtime is not possible because the published binding requires browser
WebAssembly, `HTMLCanvasElement` and WebSocket APIs. Launching an external
platform RDP client would also break the embedded Electerm session behavior and
make packaging depend on software installed outside Axterm.

The RDP protocol engine also needs a plaintext credential while building the
CredSSP session. Saved credentials remain owned by the application-local Desktop
Host Vault and the product database continues to retain only `credentialRef`.

## Decision

Axterm pins `ironrdp-wasm` 1.1.0 and wraps it in one dedicated Renderer
`RdpCanvasAdapter`. The Adapter owns the private vendor builder/session objects;
React receives only typed lifecycle callbacks and never stores those objects in
component state, Zustand, TanStack Query or browser storage. The WASM asset is
packaged with the Renderer and loaded under the production CSP's existing
`wasm-unsafe-eval` allowance. No remote script or webview is introduced.

The Core Runtime owns an `RdpSessionService` and `RdpRelay` port. An authenticated
REST command creates a bounded session from a saved Bookmark, resolves Profile,
proxy/jump and Vault references, and returns secret-free metadata. A separate
authenticated, no-store bootstrap claim supplies username/password/domain to
the Canvas Adapter once. The Adapter keeps those strings in local variables only
until `SessionBuilder.connect()` has consumed them; it does not return them to
React or retain them for reconnect. Reload creates a new Runtime session and a
new single-use claim. This is the narrow RDP protocol-bootstrap exception to the
general rule that saved secrets are never returned by product resource APIs.

RDP relay WebSockets use the normal per-generation auth token in
`Sec-WebSocket-Protocol`, never a URL query. A small WebSocket constructor
wrapper adds `rdp.v1` and the auth protocol only for an exact, registered Runtime
URL and consumes that registration on construction. All other WebSocket calls
retain the native behavior. Runtime checks loopback host, explicit Renderer
origin, session ownership and the expected destination parsed from the first
RDCleanPath frame before opening any network connection.

Runtime performs bounded X.224/TLS setup and then streams opaque binary RDP
frames between one WebSocket and one target stream. Direct and configured proxy
routes use existing Runtime ports; SSH hopping owns an ordinary SSH connection
and one `forwardOut` channel. Each session has one attachment, finite handshake
and frame limits, cancellation, idle/absolute expiry and deterministic reverse
cleanup. Renderer never receives a TCP/TLS/SSH object.

## Consequences

RDP remains an embedded cross-platform session and saved secrets continue to use
the application-local AES-GCM Vault rather than any system credential service.
The credential bootstrap is deliberately narrower than a reusable credential
read API: it is authenticated, bound to one Runtime generation and RDP session,
single-use, `Cache-Control: no-store`, excluded from generated logs and erased
from Runtime session memory after the claim.

The browser WASM boundary and RDP relay add hostile binary parsing and memory
pressure surfaces. DER elements, X.224 response, WebSocket frames, pre-relay
messages and session counts therefore have explicit limits. A protocol or
network failure closes both sides and never retries a mutating input sequence.

F-04 can become Implemented after deterministic relay fixtures, Canvas adapter
tests and packaged WASM loading pass. It remains uncertified until a real Windows
RDP fixture covers CredSSP, resize, input and clipboard, and macOS, Windows and
Linux packaged applications have evidence.

## Alternatives considered

- `node-rdpjs`: rejected because its published stack lacks NLA/CredSSP support
  required by current Windows RDP servers and is GPL-3.0.
- `ironrdp-viewer` or another external executable: rejected because it opens a
  separate native window and would require platform binaries and process-level
  credential delivery instead of the pinned embedded UX.
- Exposing Electerm's global RDP session and token-in-query URL: rejected because
  it bypasses typed ownership and puts a bearer token in a URL.
- Keeping saved passwords in Renderer memory for reconnect: rejected because it
  creates a second credential store and survives longer than the one required
  bootstrap operation.

## Migration / rollback

SQLite adds one nullable RDP payload column. Existing rows remain valid. If WASM
initialization or the Runtime relay is unavailable, RDP creation returns a typed
capability error and other protocols continue normally. Removing RDP requires no
credential migration: orphaned Vault entries follow the existing reference
cleanup path.
