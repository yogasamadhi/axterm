# ADR-028: AI conversation and selected-terminal workspace

Date: 2026-10-06
Status: Accepted by repository owner; implemented and validated on macOS.

## Context

The owner requires the assistant to open directly in conversation, follow the selected
terminal tab, and chat after API-key/model configuration. Local tabs use their current
directory. SSH tabs use the local user's `~/.axterm` as the assistant workspace while
commands execute on the selected remote connection.

## Decision

- Keep Level 1 and REST/OpenAPI, SSE and utilityProcess/headless Runtime boundaries.
  Resolve workspace metadata in Runtime, using bounded live shell directory markers;
  Renderer cannot supply a filesystem execution target or import provider SDKs.
- Local workspaces follow their terminal directory. SSH assistant workspace files stay
  in local `~/.axterm`; command execution uses the ready SSH connection and its last
  reported remote directory, or the remote login directory when unknown. Never run an
  SSH-target command locally or inject it into a terminal's foreground CLI.
- Persist the exact terminal, connection and command-directory snapshot with an AI
  command proposal. Approval hashes bind these arguments; changing tabs cannot retarget
  an existing proposal. Closed targets fail visibly. Execution is bounded and cancellable.
- Add ordinary `chat` alongside existing specialized use cases. The right assistant
  presents the composer immediately, with provider setup as an explicit action. Plain
  chat sends directly on the user's Send action; optional context/attachment review and
  redaction remain available. Changing targets clears pending review and draft attachments.
- Extend ADR-027 only to one controlled command proposal per chat turn. Pi advertises
  a command proposal schema but its own executor remains blocked. Runtime validates
  the proposal and records the existing Tool/Approval/Audit lifecycle. Every command
  requires explicit approval. The result becomes a conversation message for follow-up;
  there is no autonomous tool loop, ambient credential lookup or hidden reasoning.
- Preserve existing terminal insertion and MCP tool behavior. A distinct `workspace.exec`
  Application tool executes assistant workspace commands through bounded local subprocess
  or the existing SSH Application Service interface.

## Validation

Cover selected local directories, split directory markers and bounds, SSH/local separation,
connection closure, cancellation/output limits, exact-target approval and model proposal
validation. Exercise direct conversation and API-key configuration in real Electron and
an isolated Mac package. Run the full gate; record evidence in STATUS without claiming
unrun Windows/Linux acceptance.

2026-10-06 evidence: real SSH integration covers host-key confirmation, approval before
execution, exact remote directory, local/remote file separation, redacted output and
conversation follow-up. Desktop journeys cover direct chat, current local directories,
selected-tab conversation isolation, directory snapshots, Pi configuration, four-language
context review and specialized tasks. The final isolated unsigned Mac directory package
passes five journeys, including the three CLI selection-copy regressions. The final full
gate passes 267 files / 1,390 tests, with 5 files / 38 conditional skips, plus 26 visual and
accessibility journeys. No Windows/Linux native or commercial-release acceptance is claimed.
Details are recorded in [STATUS](../implementation/STATUS.md).
