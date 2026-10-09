# ADR-029: Assistant chat/work modes and mentioned skills

Date: 2026-10-06
Status: Accepted by repository owner; implemented and validated on macOS.
Extends: ADR-028

## Context

The owner wants exactly two assistant modes, chat and work, with command/output
explanations and other focused tasks invoked as skills with `@` in the composer.
The former task selector mixes reply instructions with permission to propose commands.

## Decision

- Present only chat/work in the mode selector. Chat is the safe default, including
  requests from older clients that omit `mode`. Skills remain separate instructions:
  explain command, explain output, generate command/script, and diagnose.
- Add `mode: chat | work` to the existing authenticated AI request/preview contract.
  Runtime, rather than Renderer or a system prompt alone, decides whether Pi may
  propose a workspace command. Chat never advertises this tool and rejects a direct
  `workspace.exec` proposal. Work may propose one command for ordinary requests or
  diagnosis; explanation and command-generation skills always remain reply-only.
- The `@` picker supports localized filtering, keyboard selection, Escape, and IME.
  A chosen skill is visible and removable above the prompt. Known typed skill aliases
  are also accepted; email addresses and unknown mentions remain ordinary prompt text.
  Choosing a skill never sends a request, reads terminal output, or executes a command.
- Reuse the pinned Pi coding-agent `loadSkillsFromDir` and `stripFrontmatter` at build
  time for four bundled Agent Skills `SKILL.md` files. Embed the validated bodies in
  the engine and expose only their metadata over REST. Do not scan ambient skills or
  load extensions. Existing Pi AI/Agent/provider code remains the conversation engine.
- Prefer upstream Pi implementations for future Agent, protocol, skill and resource
  work. Keep only desktop/SSH integration and the required Runtime credential,
  approval, audit, bounded context and persistence adapters. Remove the retired
  handwritten model request/stream parsers; regression tests exercise Pi instead.
- Include mode in context-review receipt binding and persisted run request metadata.
  Mode changes invalidate a pending preview. Already proposed commands retain their
  exact target/arguments and explicit approval/cancellation lifecycle from ADR-028.
- Preserve selected-terminal workspaces, bounded/redacted context, Vault isolation,
  generated-command insertion, existing specialized API endpoints, and MCP approvals.
  No new plugin/extension host, business IPC, production dependency, or autonomous execution loop.

## Validation

Cover omitted/invalid modes, mode-bound receipts, disabled command proposals in chat
and explanation/generation skills, real SSH approval in work mode, mention boundaries
and keyboard/IME interaction. Exercise real Electron and an isolated Mac directory
package, then run `bun run check`. Record actual evidence in STATUS; do not infer
Windows/Linux native acceptance from macOS results.

Implementation evidence: the final full gate passes 1,394 tests plus 26 visual and
accessibility journeys. Source journeys cover all specialized tasks and the new
mode/skill flow; an isolated unsigned Mac directory package passes both the new flow
and Pi configuration/Vault import. The reuse audit removes the retired handwritten
protocol engine and records why each retained adapter is required. See
[the validation record](../implementation/evidence/pi-engine/2026-10-06-modes-and-reuse.md).
