# Desktop native capability port

Private Host/shell code implementing ADR-043. The fixed version-1 protocol currently
contains twelve Vault capabilities; business service dispatch and plugin/package
management are absent. Each input and result has a strict schema. A generation UUID
and an inherited Node IPC channel bind one owner. Unrelated startup/control messages
are ignored. Frames are bounded at 8 MiB, each endpoint accepts at most 32 in-flight
requests, waits at most 30 seconds and retains at most 256 recent identities in
addition to active identities. Invalid native frames revoke the endpoint. Exceptions
become stable error codes without messages or causes.

`nodeIpcWire` supports the Electron RunAsNode child without importing Electron.
`ShellVaultCapabilities` owns the explicit fixed handlers, using an already selected
physical `EncryptedVault`. The shell closes this capability owner before closing
that Vault. Server ownership remains reserved until handler/resource drain finishes.
Client close, disconnect, cancellation and server close remove listeners/timers and
revoke pending calls. A native owner must supply cancellation-aware handlers.

Host-side `NativeVaultPort` implements the same credentials port as the local
provider. A record mutation acquires a shell-owned opaque address lease, runs its
callback in the Host and commits the replacement or releases without a write. The
shell holds the cross-process lock during that interval. Leases are limited to 32,
expire after 60 seconds, belong to that channel generation and are released on
shutdown/disconnect. Expired or already committed leases cannot write. Mutation
callbacks are not retried. Credentials-provider and direct-port disposal drain
accepted mutations before revocation. The port never exposes the master key.

The new desktop startup, window/protocol proxy and other native capabilities remain
separate migration work. This package does not change the shipped Electron entry,
expose raw IPC to Renderer/plugins or claim that M3 or the final cutover is complete.
