# ADR-003: Electerm feature and UI/UX parity program

Status: Accepted  
Date: 2026-09-12

## Context

Phase 0–10 established Axterm's Level 1 process model, typed Runtime contract,
local terminal, SSH, SFTP, tunnels, AI, recovery and packaging boundary. That
foundation does not reproduce the breadth or interaction depth of Electerm.
Calling the current host list, tabs and file table “Electerm-informed” also makes
progress hard to judge: a feature can exist while its menus, states, keyboard
behavior, settings and failure handling remain substantially different.

The product direction is now to reproduce the desktop feature set and UI/UX of
the vendored Electerm baseline with Axterm's own technology stack. The selected
baseline is the submodule revision
`799bedef98c1deae676ae03041719de98d3b57f1` (Electerm package version `5.5.0`,
commit date 2026-09-10). A moving upstream branch cannot be an acceptance target.

## Decision

Axterm adopts an explicit Electerm parity program after the Phase 0–10
foundation. “1:1” means parity in user-observable behavior:

1. the same desktop information architecture, work areas and navigation;
2. the same supported connection and file-transfer workflows;
3. the same controls, menus, gestures, shortcuts and focus behavior;
4. the same meaningful loading, empty, success, warning, error and reconnect states;
5. the same configurable outcomes and import/export/sync behavior;
6. equivalent visual geometry, density, hierarchy and theming at reference viewports;
7. equivalent behavior in packaged macOS, Windows and Linux applications.

Axterm keeps its name, icons and product identity. Exact upstream wording may be
localized for Axterm, but the action, placement, default, state transition and
result remain equivalent. Platform-native title bars, dialogs, fonts and
accessibility affordances may vary where the operating system requires it.

Parity is implemented with React 19, TypeScript, Tailwind v4, shadcn/ui,
TanStack Query, Zustand and the existing Runtime contracts. It does not permit
Electerm's global mutable state, Renderer access to Node or vendor objects,
business IPC, `original-fs`, whole-file Base64 messages, unbounded buffers or
implicit unsafe fallback. User-visible features that originally depend on those
patterns receive new Application ports, adapters and REST/SSE/WS/stream
contracts.

The normative parity definition lives in
`docs/product/ELECTERM_PARITY_SPEC.md`. The auditable inventory and ownership
live in `docs/implementation/ELECTERM_PARITY_MATRIX.md`. A parity item can be
marked complete only when the matrix links its implementation and required
automated or manual evidence.

Phase 10 remains open until Windows, Linux and upgrade package smoke tests have
real evidence. Since these remaining checks require external operating systems,
work may proceed on Phase 11 while Phase 10 remains open. Phase 21 parity
certification cannot finish until both the parity matrix and the Phase 10
distribution gates are complete.

The same rule applies to explicit cross-phase feature dependencies. An earlier
shell row may remain open while its later protocol, file, widget, theme, sync or
platform implementation proceeds. The matrix records that dependency and the
earlier phase is not called complete until the integrated row is Certified. This
prevents an entry-only placeholder from blocking useful implementation or being
misreported as parity.

Future upstream adoption is deliberate. Updating the reference commit requires
a baseline-change ADR, a regenerated inventory and review of every affected
golden workflow and screenshot. Ordinary implementation work must not silently
follow the Electerm default branch.

## Consequences

The Phase 0–10 completion statements describe the Axterm foundation only. They
no longer imply product parity. The roadmap expands with dedicated phases for
the shell, bookmarks, terminal, SSH, files, additional protocols, automation,
settings/sync, AI/MCP and final parity certification.

Product review becomes evidence based. A screen that looks similar but lacks
its context menu, keyboard route, disabled state or recovery path is incomplete.
Likewise, an API with no matching desktop workflow is not functional parity.

The broader scope adds protocol adapters and native dependencies. Each one must
preserve the existing package, cleanup, security and architecture gates and must
be proven in a packaged application on its supported platforms.

## Alternatives considered

- Continue incremental visual inspiration without a fixed target: rejected
  because completeness remains subjective and feature gaps stay hidden.
- Build or embed the vendored Electerm application: rejected because it would
  bypass Axterm's Runtime contract, security model and chosen stack.
- Copy upstream subsystems wholesale and repair the architecture later: rejected
  because Renderer/Main coupling would become part of the product contract.
- Track Electerm's latest branch continuously: rejected because acceptance
  would move during implementation and make regressions irreproducible.

## Migration / rollback

Parity work lands as vertical slices behind existing contracts and migrations.
The Phase 0–10 foundation remains usable throughout the program. If an adapter
cannot meet cleanup, packaging or security requirements, keep the capability
disabled with an explicit status and leave its matrix item open; do not weaken
the boundary to satisfy a visual demo.
