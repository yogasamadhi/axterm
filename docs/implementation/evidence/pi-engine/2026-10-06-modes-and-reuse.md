# AI modes, mentioned skills and Pi reuse validation

Date: 2026-10-06
Platform: macOS arm64
Product version: 0.10.0
Decisions: ADR-027, ADR-028, ADR-029

## Implementation

The assistant exposes exactly chat/work modes, defaults to chat, and invokes four
bundled skills through `@`: explain-command, explain-output, generate-command and
diagnose. Skills are discovered and validated with pinned Pi `loadSkillsFromDir`;
their bodies are loaded with Pi `stripFrontmatter` and bundled in the engine.
Only metadata crosses authenticated REST `/api/v1/ai/skills`.

Runtime persists mode and binds it to context-review receipts. Chat rejects model
and direct workspace command proposals; explanation/generation skills remain
reply-only in either mode. Work permits one ordinary/diagnosis command proposal,
with the existing exact-target approval, SSH routing, timeout and output limits.
The model never runs its own command executor.

The reuse audit inspected Pi Agent, coding-agent SDK/session, model configuration,
provider composition, skills, tool validation and event-stream code. Conversations
already call Pi `runAgentLoop`, provider protocols and the pinned model catalog.
The retired handwritten OpenAI Chat/Responses/Anthropic request builders, SSE parser
and protocol event normalization were removed. Their tests now exercise the actual
Pi adapters, including fragmented tool arguments. The Runtime model port no longer
accepts those obsolete raw tool deltas. This removes about 300 lines of handwritten
production code while preserving legacy `/models` discovery and desktop proxy transport.

Required Axterm adapters retain REST/SSE, React UI, selected-terminal/SSH targets,
SQLite conversation/audit state, Host Vault references, strict proposal validation,
bounded redacted context and deterministic cancellation/backpressure. Full Pi CLI
session defaults would introduce file sessions, auth/settings/resource loading and
TUI/extension/tool integration outside these boundaries. The retained mapping and
policy reasons are documented in PI_AI_ENGINE.md. AGENTS.md now requires inspecting
and preferring existing Pi implementations before adding equivalent assistant code.
The upstream tracked submodule files remain unchanged.

## Executed validation

| Check                                                    | Actual result                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi protocol, legacy discovery, proxy and lifecycle tests | 3 files / 32 passed. All three old protocol tests now run Pi; fragmented text/tool arguments, usage, cancellation and safe failures remain covered.                                                                                                                    |
| Mode, skill, review, workspace and SSH tests             | 6 files / 31 passed; included in the final full gate. Hostile chat/reply-only skill command proposals create no tool, approval or execution.                                                                                                                           |
| Final `bun run check`                                    | Exit 0; 268 files / 1,394 tests passed, 5 files / 38 conditional skips; architecture, 264-operation contract, license/SBOM, source, localization, snapshot and build checks passed.                                                                                    |
| Visual/accessibility part of the final gate              | 26 passed.                                                                                                                                                                                                                                                             |
| Existing assistant desktop journeys                      | 7 passed: four-language context review, selection explanation/script insertion, bookmark, theme, tool cards, attachments and Pi configuration.                                                                                                                         |
| Final source mode/skill desktop journey                  | 1 passed; default chat, two options, reviewed Pi skill, exact-directory approval, tab isolation, keyboard/IME/caret behavior and 200% hit testing. Axe reported no violations in the assistant and portal menu.                                                        |
| Independent source copy                                  | Snapshot hygiene passed; frozen installation installed 689 packages, full Pi/Desktop/Runtime build and packaged layout check passed without Git or workspace output inputs.                                                                                            |
| Isolated unsigned Mac directory package                  | Wrapper exit 0; two packaged journeys passed (14.7s), covering mode/skills/workspace approval and Pi configuration/Vault headers. Each fixture asserts `app.isPackaged`, `app.asar`, a path outside the source checkout, temporary working directory and reduced PATH. |

The first source mode/skill journey identified insufficient selected-menu description
contrast after making the menu background opaque. The selected text was fixed and
the final source journey passed (10.5s); the final full gate includes that fix. The
independent build preceded only this text-color fix, with the same engine, adapters
and dependency inputs. The final Mac package includes the corrected CSS.

The temporary independent source and Mac package directories were removed after
validation. Installed applications, real user profiles and existing release artifacts
were not changed. No Windows/Linux native, signing/notarization, installer or formal
commercial-release acceptance is claimed.
