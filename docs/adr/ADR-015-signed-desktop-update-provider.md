# ADR-015: Signed desktop update provider

## Status

Accepted

## Context

The Desktop Host already exposes a generation-authenticated updater status, but it always reports
`disabled`. Electerm parity row H-12 also requires the configured states for checking, available,
downloading, cancellation, ready and failure. Runtime and Renderer cannot own installer files or
import Electron update objects, and an official Axterm update service or production signing identity
does not exist yet.

## Decision

The Electron Main process continues to own updates behind `/host/v1`. A bounded updater controller
is enabled only when both `AXTERM_UPDATE_MANIFEST_URL` and
`AXTERM_UPDATE_PUBLIC_KEY_BASE64` are configured. Without both values it reports `disabled` and
performs no network request.

The configured endpoint returns a strict JSON manifest containing version, publication time, release
notes and one platform artifact. The artifact metadata is authenticated with an Ed25519 signature over
a canonical version/file/size/SHA-256 record. Manifest and artifact URLs must use HTTPS, except for
loopback integration fixtures, and the artifact must share the manifest origin. The Host streams the
artifact into a private `.part` file with exact byte, hash, size, timeout and cancellation limits, then
atomically renames it. URLs and local paths are never returned to Runtime or Renderer.

Runtime exposes typed REST status and action resources. It only forwards `check`, `download`, `cancel`
and `install` through the Host Capability client. Renderer uses the generated REST client and displays
the resulting state. The `install` action opens the verified platform package through the Desktop Host;
real replacement and restart remain installer/platform behavior.

## Consequences

- An unconfigured build preserves the 1.0 disabled-provider behavior required by the master spec.
- Test feeds can exercise availability, progress, cancellation, signature/hash rejection and installer
  handoff without a production service or secret signing key in the repository.
- Production release certification still requires a separately controlled signing key, HTTPS feed,
  signed package and installed macOS/Windows/Linux upgrade journey.
- Updater operations remain outside Electron Business IPC and do not add a Runtime-to-Electron import.
