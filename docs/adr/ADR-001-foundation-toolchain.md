# ADR-001: Phase 0 stable toolchain compatibility

Status: Accepted
Date: 2026-09-10

## Context

MASTER_SPEC §11–12 names Electron 44, electron-vite 5, electron-builder 27,
Bun 1.4 and stable releases. Registry verification on 2026-09-10 found Electron
44.3.0 and electron-vite 5.0.0 stable, but electron-builder 27 only has
`27.0.0-alpha.8` (`next`). The latest stable 26.x line is 26.16.1 (`v26`).
The electron-vite 5 peer range supports Vite 5/6/7, not Vite 8.
openapi-typescript 7 requires TypeScript 5.x.

Sources: [npm registry](https://registry.npmjs.org/electron-builder),
[electron-vite dependency handling](https://electron-vite.org/guide/dependency-handling),
[utility process builds](https://electron-vite.org/guide/dev#utility-process-and-child-process).

## Decision

Use Electron 44.3.0, electron-vite 5.0.0, Vite 7.3.6, TypeScript 5.9.3,
and temporarily electron-builder 26.16.1. Pin direct versions and commit the Bun
lockfile. This is a documented exception to the requested builder major, not a
claim that builder 27 stable is available. The packaging system remains
electron-builder. Keep the existing Level 1 process/transport/security boundaries.

Only Phase 0 dependencies are installed now. SQLite/Drizzle, PTY, SSH and AI
adapters are installed in their roadmap phases, with native/packaging checks.
Node 24.18.0 is the available development/test host; the desktop Runtime uses
Electron's embedded Node. The independent Node entry stays local-only.

## Consequences

A clean installation is reproducible using published stable packages. macOS
unsigned packaging can be tested now. The exact builder 27 baseline remains
pending a stable release. No installer signing, updater service, or native PTY
compatibility is implied by the foundation smoke test.

## Alternatives considered

- Install builder 27 alpha: rejected by the stable-only policy.
- Move electron-vite to an unrequested major or force Vite 8 peers: unnecessary.
- Block the entire foundation on an unpublished builder: avoidable.

## Migration / rollback

When builder 27 stable is available, upgrade it in a dedicated change, update
VERSIONS and the lockfile, and rerun all checks plus packaged/native smoke tests
on macOS, Windows and Linux. Revert that dependency change if it fails.
