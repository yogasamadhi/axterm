# ADR-018: Independent terminal-transfer implementations

Status: Accepted for implementation

Date: 2026-09-22

Supersedes: ADR-013's Legacy Prototype-source and dependency decision; retains its
Runtime-owned terminal-byte, REST, File Grant and Binary WebSocket boundaries

Relates to: ADR-016, P-02 / IR-02 and IR-03

## Context

ADR-013 recorded the first-version choice to adapt Legacy Prototype protocol state
machines in Axterm's Runtime Adapter. That choice delivered a usable initial
terminal-transfer flow, but it conflicts with ADR-016's requirement to remove
direct Legacy Prototype-derived protocol code rather than merely rename or transcribe
it.

The current Runtime no longer contains the former
`packages/runtime/src/adapters/terminal-transfer/legacy-prototype/` sources or the
Legacy Prototype-named transfer adapter. Axterm's `xmodem.ts` is a separately authored
engine whose framing, acknowledgment and cancellation behavior was checked
against published XMODEM protocol descriptions. `zmodem.ts` and `trzsz.ts` are
Axterm adapters around the separately published `zmodem2` and `trzsz2`
packages. Those packages remain third-party dependencies with applicable
notices, and shared author names or package history are not enough to conclude
their source or distribution rights are independent; IR-02's source-rights
review remains required.

The protocol boundary itself remains necessary. Terminal bytes, temporary files
and selected file paths cannot move to Renderer merely because the implementation
provenance changes.

## Decision

1. Retain ADR-013's architecture: `TerminalService` owns terminal channels and
   Binary WebSocket bytes; the Runtime transfer Application service uses the
   narrow interceptor; Renderer starts or answers transfers through typed REST
   actions and receives only path-free control state; Host File Grants resolve
   selected files only inside the Runtime/Host boundary.
2. The product must not ship direct Legacy Prototype transfer engines or helpers.
   `xmodem.ts`, `zmodem.ts`, `trzsz.ts`, safe transfer naming, per-transfer
   nonce and staged-publication helpers are Axterm-owned implementation layers.
   A file rename, TypeScript transcription or a replacement that retains direct
   source structure does not satisfy this decision.
3. `zmodem2` and `trzsz2` remain exact Runtime-only pure-JavaScript third-party
   dependencies behind Axterm adapters. Their notices and the declaration-only
   `trzsz2` patch remain in source and packaged legal material. They are not
   described as Legacy Prototype-adapted engines, nor does this ADR claim their final
   source-rights review has passed.
4. Current product and packaging documentation must describe the XMODEM engine
   as Axterm-authored and the two library packages as separately published
   third-party dependencies with pending provenance review. Historical records
   may preserve the original source decision only when explicitly labeled
   historical; they are not release instructions.
5. The existing bounds continue unchanged: one transfer per terminal, bounded
   selection/wire buffers, no Renderer paths or secret-bearing logs, explicit
   cancellation, same-directory private staging, no-overwrite publish, and
   deterministic cleanup on error, channel loss, terminal close, Runtime
   shutdown and generation replacement.

## Consequences

- ADR-013 remains the architectural rationale for the interceptor and lifecycle
  boundary, but its direct Legacy Prototype-source decision is no longer authoritative.
- P-02 must preserve protocol and real-PTY/SSH/packaged regressions while the
  independent source tree excludes the deleted transfer directory and
  `@legacy-prototype/*` dependencies.
- Source rights, independently operated SSH interoperability and installed
  Windows/Linux application evidence remain IR-02/IR-03 release work. Passing
  source or packaged macOS tests does not accept them.
- Documentation and SBOM/notice checks distinguish third-party license
  compliance from a legal conclusion about original authorship or trademark.

## Alternatives rejected

- Keep ADR-013's source decision and call the TypeScript ports independent:
  rejected because ADR-016 explicitly disallows that reasoning.
- Move protocol engines into Renderer to create a visibly separate client:
  rejected because it violates the File Grant, terminal-byte and Node-access
  boundaries.
- Remove `zmodem2` and `trzsz2` solely because their provenance review is
  pending: rejected because that would silently remove functional protocols
  without a reviewed replacement or migration path. Their retained notices and
  review queue remain explicit instead.

## Verification plan

1. Maintain unit, protocol, real PTY, encrypted SSH fixture and packaged-app
   tests for XMODEM, ZMODEM and TRZSZ, including cancellation, malformed data,
   staging cleanup, limits and path redaction.
2. Make the independent snapshot and candidate check reject direct Legacy Prototype
   dependencies plus the retired terminal-transfer directory, locale/theme
   snapshots, FTP Adapter and generators; retain historical source references
   only in controlled documentation during the migration period. This does not
   reject the separately governed P-06 compatibility boundary.
3. Record source/provenance review, independently operated SSH testing and
   Windows/Linux installed-app evidence before accepting IR-02 or IR-03.
