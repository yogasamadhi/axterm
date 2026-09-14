# ADR-006: SSH proxy policy and lifecycle

Status: Accepted  
Date: 2026-09-12

## Context

Phase 15 must reproduce Electerm 5.5.0's global and per-session proxy behavior
without importing its global mutable settings, credential-bearing proxy URLs or
vendor socket ownership into Axterm. The feature changes the public Host and
Settings contracts, the product database, the SSH connection workflow and the
handling of a proxy password, so the boundary and lifecycle need an explicit
decision.

Axterm's existing architecture requires the Renderer to use the Runtime REST
contract, the Runtime to own the SSH workflow, and Desktop Host to own saved
credentials. ADR-004 fixes the credential implementation as the
application-local AES-256-GCM Vault. Proxy support must not probe or call any
operating-system credential facility.

## Decision

The global setting stores either `direct` or a `custom` proxy endpoint. Each SSH
Host and Quick Connect target stores one of:

- `inherit`, which resolves the current global setting when a connection starts;
- `direct`, which explicitly bypasses the global proxy;
- `custom`, which uses that Host or target's endpoint.

`inherit` is the Host default and `direct` is the global default. This preserves
Electerm's session-over-global priority while making an explicit per-session
bypass possible. The effective policy is resolved once at the beginning of each
connection attempt, including an automatic reconnect. For a jump chain, the
resulting proxy tunnel targets and is handed to the first SSH hop; later hops use
SSH `forwardOut` channels.

A custom endpoint contains a validated URL using `http`, `https`, `socks5` or
`socks5h`, an optional username, and an optional opaque `credentialRef`. Userinfo,
query strings, fragments and non-root paths are rejected in proxy URLs. A
username and credential reference must appear together. The password is resolved
only through the authenticated Host Capability API immediately before the proxy
handshake. The product database, REST responses, events and logs never contain
the password. Saved passwords use only the application-local Vault described by
ADR-004.

The Runtime owns a `ProxyService` application boundary and a `ProxyConnector`
port. `TcpProxyConnector` implements bounded HTTP/HTTPS CONNECT and SOCKS5
handshakes. It enforces connection/handshake timeouts, request and response size
limits, AbortSignal cancellation and typed proxy errors. No unbounded response
buffer is allowed.

Socket ownership transfers from `ProxyConnector` to the SSH transport only after
a successful proxy handshake. Before transfer, `ProxyService` destroys the
socket on test completion and `ConnectionService` destroys it on any failure or
cancellation. After transfer, the ssh2 client owns and closes the socket together
with its connection. Runtime shutdown and connection recovery therefore close
all direct, proxy and jump-chain resources deterministically.

The Runtime exposes a typed proxy test operation. It tests the effective global
or Host policy, or a validated unsaved custom endpoint, against an explicit
bounded target and always closes the resulting socket. An unsaved test password
may exist only in that authenticated request and call stack; it is not persisted,
returned or logged. Normal saved configuration always uses a `credentialRef`.

Migration 7 adds safe proxy metadata to Hosts and a `network` Settings section.
It is forward-only and leaves existing Hosts on `inherit`, with the global
setting on `direct`, so upgrading cannot unexpectedly route existing traffic
through a proxy.

## Consequences

Renderer forms can expose a clear global setting and a per-Host inherit/direct
override without accessing sockets, ssh2 or the Vault filesystem. Headless mode
can use proxies without credentials; resolving a saved proxy credential without
a Desktop Host returns a typed capability error.

Changing the global setting affects the next connection or reconnect attempt. It
does not mutate an already established SSH transport. Proxy URLs can be exported
as safe configuration metadata, while credential references remain opaque and
passwords remain outside the business database.

HTTP/HTTPS CONNECT and SOCKS5 are covered by authenticated local fixtures,
cancellation and resource-cleanup tests. Platform-packaged and full visual
evidence remain separate Phase 15 certification requirements.

## Alternatives considered

- Persist a single credential-bearing proxy URL like Electerm: rejected because
  it would place plaintext passwords in SQLite, events and forms.
- Let Electron Main open proxy sockets through business IPC: rejected because it
  would turn Desktop Host into a business backend and violate Zero Business IPC.
- Read environment proxy variables implicitly: rejected because the effective
  route would be invisible in the product configuration and difficult to test.
- Apply a separate proxy at every jump-chain hop: rejected because later hops are
  reached through the preceding SSH transport; the session proxy belongs at the
  first TCP hop.
