# Implementation status

Updated: 2026-09-14  
Product version: `0.10.0`  
Normative sources: [MASTER_SPEC](../architecture/MASTER_SPEC.md),
[ELECTERM_PARITY_SPEC](../product/ELECTERM_PARITY_SPEC.md)  
Execution ledger: [ELECTERM_PARITY_MATRIX](ELECTERM_PARITY_MATRIX.md)
Implementation route: [ELECTERM_PARITY_ROADMAP](ELECTERM_PARITY_ROADMAP.md)

## Delivery target

The only current delivery target is a user-observable 1:1 reproduction of the
pinned Electerm 5.5.0 desktop baseline using Axterm's Level 1 architecture and
technology stack. Phase 0–10 is the reusable foundation; Phase 11–21 and all 122
matrix rows define the remaining product delivery. Saved credentials use only
the application-local Host Credential Vault, and a fresh desktop profile opens
at 1440×900.

## Current result

Phase 1 through Phase 9 are implemented and accepted on macOS arm64. Phase 10's
build, native-module, icon, CSP, signing-boundary and updater-boundary work is in
place. The macOS arm64 app, DMG and ZIP were built and the packaged app passed
local-terminal, SSH-terminal, SFTP, SQLite, restart-persistence and old-schema/local-Vault upgrade tests.

Phase 10 and the Desktop 1.0 Definition of Done remain open because Windows x64
and Linux x64 packages have not been run on those operating systems, and a signed
test-channel binary-to-binary upgrade has not been exercised. A public
release, real signing identity and update server are outside this delivery.

The product identity is now consistently `Axterm`: the root package, desktop
metadata and executable, `dev.axterm.desktop` application ID, `axterm` deep-link
scheme, `AXTERM_*` environment variables, product-specific HTTP headers,
database/sync filenames and parity evidence paths use the renamed identifier.
No dependency or process-boundary change was required.

The Phase 1–9 acceptances describe the Axterm architecture and baseline feature
set. They do **not** mean the desktop product has Electerm feature or UI/UX
parity. ADR-003 now fixes Electerm package version 5.5.0 at submodule commit
`799bedef98c1deae676ae03041719de98d3b57f1` as the parity target.

The parity ledger contains 122 observable capability rows: 1 Certified,
116 Implemented pending full evidence, 5 Partial and 0 Missing. Phase 11 is
complete. Phase 12 A-01 through A-04 and A-11 have closed their later-phase implementation
dependencies. Phase 15 SSH/proxy/hopping now has D-01 through D-12 implemented; active implementation
has passed Phase 16 File Manager. E-01 local/remote/split workspace parity and E-02 address
history/bookmarks/terminal-folder navigation, E-03 file-table behavior, E-04 hidden-file/filter
behavior, E-05 multi-selection, E-06 context operations, E-07 same-pane clipboard/drag behavior
and E-08 cross-pane drag transfer are implemented. E-09 remote-to-remote streaming and E-10's
recursive boundary, E-11 interactive conflict decisions, E-12's transfer-center controls and
E-13's internal editor through E-18's native file operations are implemented. Phase 16 now has E-01 through E-18 implemented. Phase 17 F-01 FTP/FTPS through F-08 Deep Links and C-16 terminal transfer protocols are implemented. Phase 18 G-01 Quick Command tree through G-12 command-line entry and Phase 19 H-01 through H-10 are implemented. H-11 localization now has its complete 15-locale/410-key foundation, immediate persisted switching, fallback and RTL behavior. Every Renderer surface uses catalog text, including Shell controls, application orchestration, terminal UI/models, host and protocol forms, bookmark tunnels/startup/hops, file management/transfer/conflict/permission flows, sync, migration, proxy, histories, remote desktop, shortcuts and recovery. The exact AST inventory has fallen from 2,495 to 0 direct CJK literals. Three-viewport LTR/RTL reference and candidate captures now exist on macOS arm64; all six pass at 96.660%–97.143% similarity and their seven machine-readable hard-defect checks pass. Packaged platform certification remains active.
The last seven Missing defaults are now implemented: startup Bookmark/workspace selection, global
proxy enable semantics, external editor selection, xterm screen-reader mode, SFTP refresh on open,
terminal-cwd following and the SSH/SFTP split-view default. The settings map is now 50 Implemented,
22 Partial and 0 Missing. Electerm short Bookmark IDs are remapped to Axterm IDs in the import
transaction instead of being persisted as stale references.
C-08 global Terminal Profile,
C-12 reconnect, C-13 shortcut bar, C-14 command suggestions and C-15 file drop are
implemented and remain open for their platform/fault/touch/SSH, visual and packaged evidence.
Phase 20 I-01 through I-10 are implemented; I-08 has complete read-only and approval-bound Agent
Tool Card behavior with a production Electron screenshot and real PTY execution evidence. The locally
actionable Phase 21 package work now includes a repeatable verified-DMG macOS installation gate after J-03 completed the macOS packaged golden journey;
J-04/J-05 recorded their external-platform evidence blockers, J-06 completed old-profile migration
and J-08 completed the automated accessibility gate.
The current J-07 corpus contains 48 real product states at three viewports: all 144 comparisons pass
with 95.089% or better similarity, and all 1008 automated hard-defect checks pass. Three real Phase 15
SSH Bookmark surfaces now cover PrivateKey/Certificate authentication at 97.834%–98.354%, Settings
network controls at 97.346%–97.975%, and saved-Bookmark tunnel configuration at 96.641%–97.705%.
Together they expose proxy, ProxyCommand, connection-policy, algorithm, X11, startup-script,
certificate-import and tunnel entry points. The editable Shortcut registry remains at
96.081%–96.866%; the UI Themes scene still covers the complete 310-theme Electerm MIT catalog and
matching ten-item pagination flow. Three real Phase 16 scenes use an authorized local directory and
Docker OpenSSH/SFTP: dual-pane browse/selection/context operations pass at 95.213%–97.196%, a real
128 MiB streaming upload with transfer-center/history UI passes at 95.171%–96.928%, and remote
text edit/search passes at 96.513%–98.166%.
Seven Phase 17 protocol forms pass at 95.642%–97.513%; a real 256 KiB File Grant/XMODEM/local-PTY
progress state passes at 97.933%–98.935%.
Phase 18 adds actual Quick Command/Batch, Trigger, Terminal Information/Monitor and Static File Server
Widget surfaces at 95.089%–98.460%; its compact capture also exposed and fixed a clipped English
`Manage` action. Side-by-side review of all 144 pairs confirms stable hierarchy, selected states, menus, forms,
terminal surfaces and LTR/RTL direction without a blocking visual defect.
J-01 now has real bounded persistence and a repeatable long-run harness. Domain Events retain the
newest 10,000 cursors and default idempotency receipts retain 2,000 rows per operation. The macOS
arm64 60-second repository-test smoke and a 729-cycle accelerated regression completed without a
budget violation and returned terminal, connection, transfer, tunnel, Widget and SSE owners to zero.
The existing formal profile ran for 31 minutes 27 seconds and completed 1812 cycles with zero
violations, exceeding the user-defined 30-minute target. The normally completed 729-cycle accelerated
regression and 60-second smoke provide final zero-owner cleanup evidence. The user accepted this
composite evidence and explicitly directed that the long-run test must not be rerun; J-01 is Certified.
The complete production-Electron desktop regression now passes 65/65 runnable journeys with one
platform-gated Docker SSH journey skipped in that invocation. The same closeout also passes both
accessibility journeys and the 10,000-Bookmark performance journey. It found and fixed three real UI
defect groups: AI Inspector now opens the visible AI workspace from full-window Settings/Widgets; SSH
Bookmark edit mode assigns distinct React keys to the jump-chain and tunnel editors so fields and DOM
ids cannot be duplicated after switching from create to edit; and the AI Provider setup closes after a
successful save and no longer covers a pending Agent approval when no Provider exists.
Phase 10 may wait for external Windows/Linux/upgrade evidence, but Phase 21 cannot
complete until Phase 10 also closes.

## Blocker Register

| Task          | Matrix row                                            | State                              | Exact cause and last evidence                                                                                                                                                                                                                                                                          | Completed portion                                                                                                                                       | Unblock condition and resume point                                                                                                                     |
| ------------- | ----------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| J04-WIN-X64   | J-04 Windows x64 NSIS installed parity workflow       | External platform evidence blocked | The current workspace is macOS arm64, has no committed Git remote and has no reachable Windows x64 desktop runner. The local repository cannot execute or inspect an installed NSIS application; last local evidence is the validated builder target and matrix CI definition.                         | NSIS metadata/icon/signing entry point and a `windows-latest` CI route for checks, Desktop E2E, package creation and packaged golden journeys exist.    | Run the committed workflow or the same journey on Windows x64, retain artifact/log/screenshots/native-module evidence, then resume J-04 certification. |
| J05-LINUX-X64 | J-05 Linux x64 AppImage/deb installed parity workflow | External platform evidence blocked | The current workspace is macOS arm64, has no committed Git remote and has no reachable Linux x64 desktop runner. An arm64 container cannot provide x64 Electron desktop, AppImage/deb installation, PTY or GUI evidence; last local evidence is the validated builder target and matrix CI definition. | AppImage/deb metadata/icons and an `ubuntu-latest` Xvfb CI route for checks, Docker SSH, Desktop E2E, package creation and packaged SSH journeys exist. | Run the committed workflow or the same journey on Linux x64, retain artifact/log/screenshots/native-module evidence, then resume J-05 certification.   |

If another task becomes objectively blocked, this section must record its task ID,
Matrix row, cause, last evidence, completed portion, unblock condition and resume point
before work continues with the next item.
The accepted implementation delivery line is at least 121/122 Certified or approved
Not applicable rows; at most one registered Blocked row may remain. A blocked release
gate keeps Phase 10, Phase 21 formal certification and Desktop 1.0 open.

## Phase status

### Phase 0 — Repository Foundation

- [x] Bun workspaces, strict TypeScript, lint/format, Vitest and Playwright.
- [x] Root Desktop launcher forwards arguments, signals and child exit status.
- [x] Electron Main desktop host, sandboxed Renderer and minimal Preload.
- [x] Independent Runtime utilityProcess and Node headless entry.
- [x] Loopback Hono bootstrap/auth, generated OpenAPI client and architecture gate.
- [x] electerm registered as a pinned Git submodule.

Acceptance: complete.

### Phase 1 — Persistence / Contract / Host Manager

- [x] Runtime-owned `node:sqlite` with Drizzle schemas, checksummed migrations,
      serialized transactions, backup, integrity check and restore.
- [x] Host, Group and Settings CRUD with transactional persistent events.
- [x] ETag/`If-Match` optimistic concurrency and typed Problem Details.
- [x] Host management UI and 91-operation OpenAPI/generated-client boundary.
- [x] Runtime Connection Manager handles bootstrap auth, version negotiation,
      generation changes, cancellation and Query cache invalidation.

Acceptance evidence: restart persistence, stale ETag rejection, invalid request
errors, backup/restore and Contract drift tests pass. Renderer has no DB access.

### Phase 2 — Local Terminal

- [x] `PtyPort`/node-pty adapter, terminal application service and bounded registry.
- [x] Local PTYs default to the operating-system home directory (`/Users/<user>` on macOS)
      when no explicit Terminal Profile cwd or granted working directory overrides it.
- [x] Unconfigured Windows PTYs try the standard PowerShell 7 install and per-user WindowsApps
      alias before `pwsh.exe` on `PATH`, then safely fall back at spawn time to `ComSpec`;
      Terminal Settings puts the global default Profile and primary Profile/Shell fields before
      appearance, advanced and recovery controls.
- [x] Binary WebSocket data channel; Zod-checked text controls for resize/exit/error.
- [x] xterm with Fit, Search, Web Links and WebGL-to-canvas fallback.
- [x] IME input, clipboard/browser behavior, terminal search, status feedback and
      configurable local shell profiles.
- [x] Backpressure, bounded recent output and deterministic WS/PTY/listener cleanup.

Acceptance evidence: real Node PTY integration, utilityProcess E2E and packaged
PTY tests pass; output bytes never enter React State or Zustand.

### Phase 3 — SSH Terminal

- [x] ssh2 adapter and connection state machine with timeout, keepalive, abort and cleanup.
- [x] Password, private key, key passphrase, Keyboard Interactive and platform agent inputs.
- [x] Desktop application-local Credential Vault encrypts saved secrets with AES-256-GCM;
      business rows contain only `credentialRef` and no system keychain is used (ADR-004).
- [x] Contract exposes only `storage: local`; the architecture gate rejects system
      credential APIs, commands and direct dependencies across product code and automation,
      and rejects Renderer TypeScript/JSX/HTML/locale copy that offers or asks about a
      system credential store.
- [x] Unknown Host Key confirmation and remembered key; changed key uses high severity.
- [x] SSH shell channels reuse the terminal Binary WebSocket protocol.

Acceptance evidence: pinned Docker OpenSSH covers password, Host Key and SSH PTY;
unit tests cover private key/passphrase, Keyboard Interactive, jump channels and
changed-key rejection.

### Phase 4 — SFTP / File Grant / Transfer

- [x] Native open/save dialog and expiring, operation-scoped File Grant registry.
- [x] SFTP browse/stat/mkdir/rename/delete with a controlled channel per operation.
- [x] Streaming upload/download, bounded recursive traversal, progress, cancel and retry.
- [x] Batch conflict policy supports skip, overwrite and rename; symlinks are skipped by default.
- [x] UTF-8 remote editor up to 2 MiB preserves line endings, checks remote version and
      commits with same-directory temporary rename.
- [x] Non-recursive chmod UI/API with typed permission failures.

Acceptance evidence: stream cancellation removes temporary files, idempotency is
persisted, repeated channels close, editor conflicts preserve drafts, and no whole
file uses Base64 JSON.

### Phase 5 — Productivity Workspace

- [x] Multi-tab workspace, split panes, focus switching and persisted layout.
- [x] Recent hosts, command palette, keyboard shortcuts and terminal search.
- [x] Quick Commands insert into a chosen terminal without automatic execution.
- [x] SSH Config import through a File Grant, terminal profiles and jump-host selection.
- [x] Jump-chain cycle validation and safe external URL routing through Desktop Host.
- [x] Empty/loading/error/reconnect and stale-session feedback.
- [x] Electerm-informed activity rail, contextual host/session explorer, searchable host list,
      draggable/renamable session tabs, tab action menu and global transfer center.

Acceptance: complete for the Phase 5 foundation scope. A copied macOS arm64 package now also
passes the Phase 12 shell journey: seven-entry rail, sidebar collapse/reopen, menu validation,
keyboard tab reorder, pin/rename, four live panes, pointer resize, pane maximize/restore, named
workspace restart, exact 1440×900 launch and full-screen enter/exit. Foreground windows retain native
fullscreen; macOS focus denial uses state-visible simple fullscreen instead of accepting a no-op. Reviewed evidence is
`tests/parity/screenshots/axterm/packaged/{phase12-shell,phase12-restart}.png`. Windows/Linux
certification remains under J04/J05. This does not certify the remaining cross-platform Electerm
parity evidence.

### Phase 6 — SSH Tunnels

- [x] Saved local, remote and dynamic SOCKS profiles with start/stop/status UI.
- [x] Local listeners default to loopback; non-loopback requires explicit capability.
- [x] Port conflicts and invalid states return typed errors.
- [x] Connection loss, stop and Runtime shutdown close listeners, channels and sockets.

Acceptance evidence: unit leak tests and Docker OpenSSH banner tests cover all
three tunnel types and repeated lifecycle cleanup.

### Phase 7 — AI Foundation

- [x] Provider/Model resources, OpenAI-compatible adapter and Vault API-key references.
- [x] Streamed Explain Command, Explain Output, Generate Command and AI Inspector.
- [x] Bounded/redacted inspectable context and stream cancellation.
- [x] Generated commands default to copy/insert and are never silently executed.

Acceptance: complete. Renderer imports no provider SDK and cannot read back API keys.

### Phase 8 — AI Diagnosis / Agent

- [x] Persisted AiRun, Tool Call, Approval and audit metadata.
- [x] Explicit read-only diagnostic allowlist and central risk policy.
- [x] First mutation tool `terminal.exec` calls the Application Service.
- [x] Approval binds exact argument hash, target, run and expiry; changed arguments invalidate it.
- [x] Approval/audit UI and cancellation.

Acceptance evidence: redaction, allowlist, exact-hash approval, rejection and audit
tests pass. Hidden model reasoning is neither exposed nor persisted.

### Phase 9 — Reliability Hardening

- [x] Persistent-event SSE replay, cursor-invalid reset and separate realtime SSE.
- [x] Client reconnect with generation replacement, old-request abort and event de-duplication.
- [x] Persistent idempotency results for task creation and mutation operations.
- [x] Migration checksum/integrity failure paths, backup recovery and typed diagnostics export.
- [x] Runtime crash backoff, Renderer reattachment and stale terminal/task state handling.
- [x] Log/diagnostic redaction, bounded consumers and deterministic resource shutdown.

Acceptance evidence: fault-injection kills the utilityProcess and verifies a new
generation, persisted database recovery and invalidation of old sessions. SSE,
terminal, transfer, tunnel and AI cleanup tests pass.

### Phase 10 — Packaging / Desktop 1.0

- [x] electron-builder targets: macOS DMG/ZIP, Windows NSIS, Linux AppImage/deb.
- [x] Product icon, identifiers, metadata, hardened-runtime entitlements and signing inputs.
- [x] Production CSP keeps scripts self-only and permits the inline styles required by xterm/CodeMirror.
- [x] Explicit node-pty-only Electron ABI rebuild; optional ssh2 `cpu-features` is excluded.
- [x] ASAR layout includes Runtime, ssh2/ws and unpacked executable native PTY files.
- [x] Updater remains disabled without a provider; a configured signed source exposes check,
      progress, cancel, ready/error and installer handoff through the authenticated Host boundary.
- [x] macOS arm64 `.app`, DMG and ZIP built locally without a signing identity.
- [x] macOS packaged local PTY, Docker SSH/SFTP, SQLite writable path and source independence pass.
- [x] Old-profile schema migration preserves Hosts, Quick Commands and application-local Vault data.
- [ ] Windows x64 NSIS package and installed-app smoke on Windows.
- [ ] Linux x64 AppImage/deb package and installed-app smoke on Linux.
- [ ] Signed test-channel binary-to-binary upgrade smoke.

Acceptance: **open** until the three unchecked items have real evidence.
See [PACKAGING](PACKAGING.md) for the commands and signing/update boundaries.

## Electerm parity status

Phase 11 acceptance evidence:

- [x] Baseline guard verifies Electerm 5.5.0 at
      `799bedef98c1deae676ae03041719de98d3b57f1`.
- [x] Forty-nine scenarios cover all 122 matrix IDs and declare screen/modal/menu/state
      variants, upstream sources and three fixed viewports.
- [x] Reproducible reference preparation and launch stay below ignored submodule build
      directories; Electerm is absent from the Axterm package layout.
- [x] macOS reference capture blocks upstream system-CA/`safeStorage` paths and never
      asks for a system keychain; both targets emit three PNGs and Playwright traces.
- [x] Pixel diff emits per-viewport evidence. All 36 implemented Phase 12–13
      comparisons pass the former, stricter 1.5% limit and therefore the current 95% rule; the worst result is compact
      `bookmarks.forms` at 1.3613%. Golden images live below
      `tests/parity/screenshots/{electerm,axterm}`
      and the machine-readable result is `test-results/parity-diff/report.json`.
- [x] All 72 upstream setting keys and 23 active default shortcuts are mapped. The
      machine report has zero unmapped entries and exposes 0 settings plus 0 actions
      whose implementation is still missing. The settings inventory contains 50
      Implemented and 22 Partial entries.
- [x] Thirty-one design tokens and the protocol fixture ownership/cleanup interface are
      documented and covered by tests.

Phase 12 implementation evidence (acceptance remains open):

- [x] A-01 persists the exact seven Electerm `leftSideBarIcons` entries through
      versioned Runtime Settings. Common Settings can enable, disable and reorder
      them; Electerm data import/export maps the original key, and production
      Electron verifies every destination plus cold-restart ordering.
- [x] A-02 retains the mounted contextual sidebar while collapsed and restores its
      selected section/state. Production Electron covers direct rail routing and
      repeated collapse/reopen behavior.
- [x] A-03/A-04 expose the local action, selected Terminal Profile, saved SSH targets
      and a universal Quick Connect input in one menu. The shared bounded parser
      accepts local, SSH, Telnet, Serial, FTP/FTPS, RDP, VNC, SPICE, HTTP/HTTPS and
      wrapper URLs; production Electron routes every non-SSH protocol to its typed,
      prefilled live form without retaining embedded secrets.
- [x] The capture driver gives every viewport a fresh profile, applies its size before
      rebuilding the scenario, waits for ten consecutive stable layout/xterm samples
      and reopens transient menus only after the long-lived geometry settles.
- [x] `shell.chrome-empty` now closes every startup tab in both products and verifies
      the real no-session surface. Reference-sized 32 px actions, history control and
      Axterm's aligned branding footprint plus live Runtime history pass at compact
      0.581%, reference 0.459% and wide 0.287%.
- [x] Workspace tabs use content-sized 100–200 px bounds, and the first macOS pane
      reserves the reference 72 px title-bar safety area.
- [x] A-05/A-06/A-08/A-09 now have real application paths rather than shell-only
      controls: pane-scoped drag/focus/overflow, every reference tab context action,
      eight resizable one-to-four-pane layouts with swap/clone, and named workspace
      save/overwrite/load/delete. Their packaged and reference visual matrices remain open.
- [x] A-05 keyboard behavior now uses roving tab focus: unmodified arrows/Home/End
      select and focus a pane tab, while Alt+Shift+Left/Right reorders within the
      pinned or unpinned group and keeps focus on the moved tab.
- [x] A-07 now assigns stable monotonic session numbers, shows them by default,
      supports a persisted opt-out, and keeps hover switching disabled until the user
      enables it. Hover never changes tabs during a drag; both global and pane strips
      consume the same Runtime settings. A sparse-update Contract regression test
      prevents one preference write from resetting other workspace fields.
- [x] A-06 desktop state coverage now exercises live, pinned and generation-stale
      tabs through the real menu and PTY lifecycle. Pinning only changes display order,
      matching Electerm: explicit close-other/right/all actions also release pinned
      tabs in that pane instead of silently retaining them.
- [x] A-09 now has a cold Electron restart test for four-pane assignment, tab numbers,
      pin/rename state and named workspaces. Old runtime IDs restore as disconnected;
      only an explicit reload creates a replacement PTY. Packaged platform evidence
      remains open.
- [x] A-10 replaces its decorative history controls with the Runtime connection-history
      aggregate. Recent/frequency ordering, row deletion, clear and reconnect paths are
      live, New bookmark opens the SSH editor, and all four empty-state actions have
      keyboard E2E. The configurable default-tab startup switch remains Phase 19 work.
- [x] A-11 exposes Terminal/Web/remote-desktop mode, connection state, session selection,
      swap, terminal search and maximize/restore on every pane. Local `Terminal / File Manager`
      and remote `SSH / SFTP` are now true secondary views of their owning session: switching
      keeps the top-level tab, connection and pane, preserves each session's mode and mounted
      terminal, and never creates a Files section tab. Sidebar, Transfer Center, command-palette
      and terminal-cwd file entry points activate the same in-session view. Phase 14/16/17/18
      integration supplies keepalive settings, real file/protocol surfaces, Batch Input,
      terminal information and remote monitoring. Unit and production Electron E2E assert the
      per-session state, ARIA tab/panel relationship and absence of a separate section tab.
- [x] Visual metadata now records a bounded, text-free geometry and typography snapshot
      for tabs, panes, xterm rows, footers and transient menus alongside each trace. This
      makes font/cell-metric drift reviewable without retaining terminal contents.
- [x] The current 12-image report passes 12 of 12 comparisons without changing the
      1.5% threshold or adding masks. Compact/reference/wide `shell.layouts` are
      1.2134%/1.1256%/0.7364%; the remaining shell scenes range from 0.2870% to
      1.1228%. Recorded geometry confirms reference pane boundaries, live split
      session sizing, xterm rows and workspace/context-menu footprints. Phase 12
      remains open because its non-visual interaction and packaged evidence are not
      yet complete; this result does not mark any matrix row Certified.
- [x] A-12 Desktop Host foundation persists strict app-local window preferences with
      atomic replacement and corrupt-file quarantine.
- [x] Authenticated Host/Runtime REST and generated client expose custom/system title
      bar, opacity, zoom and display-corrected bounds; title-bar changes explicitly
      report `requiresRestart` while the active window still uses the prior mode.
- [x] Electron Main applies saved presentation and geometry at creation, saves normal
      move/resize bounds through a bounded throttle and flushes them during shutdown.
- [x] A fresh desktop profile opens at 1440×900; after the first move or resize, the
      application-local saved bounds continue to take precedence on later launches.
- [x] Runtime/Settings includes a non-polling typed window-preferences editor with
      validation, read-only bounds, reset, save failure and restart-required feedback.
- [ ] A-12 is Implemented pending packaged macOS/Windows/Linux interaction and
      restart evidence; it is not yet Certified.

Phase 13 implementation evidence (acceptance remains open):

- [x] B-02/B-05 add edit, duplicate, confirmed delete, group, color and description
      behavior to every non-SSH Bookmark card and form. Production Electron verifies
      the FTP create/edit/duplicate/delete path, colored title indicator, description,
      group placement and final SQLite state; the same typed controls are shared by
      Telnet, Serial, RDP, VNC, SPICE and Web.
- [x] B-11's full-window protocol selector now routes Ssh/Sftp, Telnet, Serial,
      Local, Vnc, Rdp, Ftp, Web and Spice to live forms or sessions. No new-protocol
      choice is a disabled placeholder. The selector action matrix and refreshed
      three-viewport Bookmark form corpus pass.
- [x] ADR-005 separates authoritative SSH Host connection facts from Bookmark
      placement and presentation; saved secrets remain application-local Vault
      entries referenced only by opaque `credentialRef` values.
- [x] Checksummed migration 3 converts existing flat groups and Hosts into nested
      Bookmark rows, normalizes duplicate legacy sort values into dense sibling
      positions and asserts the resulting ordering invariant before commit.
- [x] Runtime REST and the typed client expose nested CRUD and before/inside/after
      moves behind one tree revision/ETag; descendants, stale writes and missing
      preconditions return typed errors and all tree events share the transaction.
- [x] Saving and deleting an SSH destination coordinate Host and Bookmark repositories
      through one SQLite Unit of Work with nested savepoints. Creation cannot leave an
      orphan Host; deletion validates both Host and tree ETags and advances the tree once.
- [x] An SSH Bookmark row can atomically update its authoritative Host connection facts
      together with title, color, description, profile and group placement. Both Host
      and tree ETags are validated before writes; cross-group moves compact the source,
      append to the destination and advance the tree revision exactly once.
- [x] Single-row SSH deletion removes the Host only after the selected Bookmark is gone
      and no Bookmark, jump chain, recent connection or tunnel still retains it. The
      typed result reports remaining Bookmark IDs and retention reasons, and a late Host
      cleanup failure rolls back row deletion, reindexing, events and revision.
- [x] The Renderer has a bounded virtual tree with persistent expansion, ancestor reveal,
      safe hostname/user/port search, highlight, keyboard result navigation and cycle-aware
      drop feedback. Terminal bytes and credentials never enter its tree state.
- [x] Bookmark and group rows now support pointer drag/drop plus keyboard-accessible context
      actions. SSH rows connect, open the aggregate editor, duplicate into an independent Host
      and delete only the selected row; the Electron E2E covers cross-group drag, edit fields,
      color/description rendering, duplicate and retained-original deletion behavior.
- [x] The SSH form exposes Save, Save and Connect and Save and Create New. Save and Create New
      commits the aggregate and remounts a clean form, while connection startup uses the saved
      Host and selected Terminal Profile through the typed Runtime client.
- [x] The SSH Bookmark editor now follows the pinned full-window Bookmarks information
      architecture: category tree, search/creation toolbar, protocol selector, responsive form
      geometry and the Auth/Settings/Quick commands/Triggers/Ssh tunnel/Connection hopping tab
      map. All six tabs and all nine protocol choices are live. Mouse and keyboard navigation retain values; password,
      private-key/passphrase, Keyboard Interactive and Agent controls keep saved secrets in the
      application-local Vault. Invalid hidden connection options activate their owning tab before
      native validation feedback.
- [x] The built Electron Bookmark workflow covers the three implemented tabs, conditional
      authentication controls, cross-tab validation, Save and Create New reset, cancellation
      discard and edit/reopen behavior. Its pinned Electerm/Axterm corpus passes
      compact/reference/wide at 1.3613%/1.2687%/1.2094% without changing the 1.5% threshold.
      Bookmark-scoped Commands, Triggers and Tunnels plus all non-SSH Phase 17 forms are connected,
      so B-11 is Implemented pending the remaining tab-specific visuals and packaged evidence.
- [x] Bookmark group creation and editing now expose the pinned nine-color palette and
      a bounded description instead of silently writing `color: null` and an empty string.
      These fields round-trip through the existing tree ETag operation; group rows render
      their color as the reference category square, while SSH rows retain their dot and
      omit the redundant SSH badge used only for non-default protocols upstream.
- [x] B-01 is Implemented with migration, rollback, restart, 10,000-row model and HTTP
      precondition tests. Its pinned Electerm/Axterm tree corpus now covers the same
      nested default/Production/Region/Archive hierarchy at 1280×800, 1440×900 and
      1920×1080. All three comparisons pass at 1.139%/0.812%/0.550%; packaged
      interaction evidence remains open, so B-01 is not Certified and Phase 13 remains open.
- [x] The B-01 visual pass fixed product behavior rather than masking drift: the Hosts
      sidebar now uses the reference 300 px track, occupies the full window height,
      leaves sessions in the global tab strip and gives its virtual tree the remaining
      height. Bookmark rows use the reference 26 px density; the empty search keeps its
      accessible label without non-reference placeholder noise. No visual threshold or
      mask changed. A separate filtered corpus follows the pinned keyboard-selection
      behavior and keeps result counts available to assistive technology without adding
      a non-reference visible toolbar.
- [x] B-03 is Implemented with ancestor-revealing connection-field search, highlight,
      keyboard result navigation and the 10,000-row projection test. The sidebar also cycles
      title/host ascending, descending and persisted-order views without mutating Runtime
      order; focused model and built Electron interactions cover the sort behavior. Its
      dedicated filtered corpus passes at 1.155%/0.826%/0.602% for compact/reference/wide.
      Packaged interaction evidence remains open, so B-03 is not Certified.
- [x] B-04 now has a dedicated real-component drag target corpus. Both products receive
      `dragstart` and `dragover` through their own handlers and show the before-position
      insertion line without committing the move. It passes at 0.979%/0.813%/0.550% for
      compact/reference/wide; packaged interaction evidence remains open.
- [x] SSH Config import now creates compatible Hosts and missing SSH Bookmarks in one
      SQLite Unit of Work, requires the tree ETag and advances the tree revision once
      for the whole batch. Alias-based ProxyJump chains are resolved before writes;
      stale trees, conflicting aliases, missing hops and late database failures roll
      back Hosts, Bookmarks, events and revision together.
- [x] The typed import report distinguishes imported, linked, unchanged and skipped
      entries. A generation-local, ten-minute editable preview maps Host/Bookmark
      names, descriptions, authentication mode, explicit proxy mode, bounded
      ProxyJump chains and connection/keepalive/compression/reconnect options before
      the user confirms one tree-ETag transaction. Missing/conflicting/cyclic jumps,
      wildcard or multi-alias blocks, IdentityFile, ProxyCommand and invalid options
      carry explicit bounded reasons before any write.
- [x] Root SSH Config selection and every Include use independent Desktop File Grants.
      Include expansion is capped by depth, file, byte and request counts, ignores
      symlinks and detects ancestor cycles. Renderer metadata contains stable Include
      IDs plus basenames/glob patterns only; absolute, home-relative and Windows paths
      remain inside the Runtime. Replacing an Include revokes its grant and descendant
      grants immediately; dialog close/unmount and generation teardown revoke the rest.
- [x] Preview commit is intentionally one-shot and is never retried automatically after
      an ambiguous response. A stale tree leaves the preview reusable; a successful
      commit consumes it. If the response is lost, the user runs a fresh preview; the
      resulting full import remains repeat-safe and produces no writes or revision
      change for already imported entries. This is batch convergence, not request-level
      durable idempotency.
- [x] Checksummed migrations 5–6 upgrade legacy recent rows into at most fifty
      secret-free SSH target aggregates and collapse prior option-sensitive rows.
      Stable identity is normalized hostname, port and username; later auth, jump-host
      or connection-option changes update the safe snapshot and increment the same row.
      Only a connection which reaches `ready` is recorded, while transport recovery
      within the same live Connection does not inflate frequency.
- [x] Runtime REST/OpenAPI and the generated client expose revision-bound recent/frequency
      paging, item ETags for reconnect/delete/promotion and a collection ETag for clear.
      Durable delete, clear and history-to-Bookmark commands require idempotency keys.
      Promotion validates the independent tree ETag and commits any Host creation,
      history link, Bookmark, both revisions, events and idempotency receipt in one UoW.
      Reconnect receipts are capped at 128 and generation-local because their returned
      Connection IDs cannot be replayed after Runtime restart; duplicate keys return the
      original result, changed input conflicts, and clients do not cross-generation retry.
- [x] The default privacy setting retains connection metadata but never terminal bytes,
      commands or authentication material. Disabling connection history atomically
      clears existing rows and prevents subsequent successful sessions from recording.
      Repository, migration, rollback, generated-client and real loopback Runtime tests pass.
- [ ] B-06 remains Partial: the live Bookmark sidebar now exposes Electerm-style
      Bookmarks/History tabs, 35 px single-line targets, switch-based frequency sorting and
      whole-row reconnect with hover Bookmark/delete actions. Its typed controller loads
      history/settings/tree, opens a
      reconnected SSH result as a terminal, refreshes connections/history, publishes and
      refreshes promoted Bookmarks/Hosts, deletes or clears rows, and persists the privacy
      switch. Twenty-one focused model/Runtime tests and the built Electron desktop
      navigation/privacy scenario pass; the packaged OpenSSH scenario covers
      reconnect/promotion/delete when executed by the fixture gate. A secret-free transient
      password/interactive row requests one bounded
      one-time answer without persisting it; a transient private-key row keeps its actions
      visible and directs the user to promote/configure the key. Saved Hosts remain on the
      credentialRef/Runtime interaction path without an extra history prompt. Its pinned
      history corpus passes at 1.151%/1.041%/0.634% for compact/reference/wide; completed
      packaged restart evidence remains open.
- [ ] B-07 is Implemented: the footer popover matches Electerm's search, recent/frequency
      sort, count, copy, delete and clear interactions and inserts a selected command into
      the active terminal without executing it. Collection is explicitly opt-in and uses
      in-memory bash/zsh/fish OSC 633 hooks instead of reading the xterm buffer or guessing
      at Enter presses. Leading-space commands and a conservative credential-bearing command
      set are discarded before persistence; history is capped at 200 exact command aggregates,
      and every idempotency receipt stores only a command hash and bounded result metadata.
      Repository/Application/Runtime tests, real local shell capture, Docker OpenSSH capture
      and the built Electron workflows cover sorting, search, count, insertion without replay,
      delete/clear, disable-and-clear and a cold restart using the same desktop profile. The
      exact aggregate and count persist across a new Runtime generation. The populated,
      frequency-sorted footer corpus passes at 1.138%/0.935%/0.627% for
      compact/reference/wide. Its fixture uses the same three command aggregates in isolated
      temporary profiles and keeps the popover visible over a deterministic terminal backdrop;
      no user terminal bytes are captured. The visual pass also fixed a collapsed-sidebar
      implicit-grid defect, and the opt-in/disable control now lives in the Runtime settings
      surface instead of adding a non-reference popover footer. Packaged restart evidence
      remains open, so B-07 is not Certified.
- [ ] B-08 is Implemented: Connection Profiles are a separate aggregate from Terminal
      Profiles and preserve Electerm's SSH/Telnet/VNC/RDP/FTP/SPICE section model. Checksummed
      migration 9, Repository/Application Service and five REST/OpenAPI operations provide
      deterministic default promotion, case-insensitive unique names, nested sparse PATCH,
      item ETags, persistent events and deletion protection while a Bookmark is assigned.
      The business database stores only opaque credential references; plaintext is accepted
      only by the uncontrolled desktop form and written through the application-local Vault.
- [x] The desktop Profile editor follows the reference list-left/form-right interaction with
      protocol tabs, default state, saved-field retention, explicit clearing and safe rollback
      of newly created credential entries after failed writes. New SSH Bookmarks select the
      default Profile, while Terminal Profile and Connection Profile assignments remain
      independent. SSH create/retry, connection history reconnect, tab duplication and layout
      recovery preserve the selected Connection Profile and use a connection-time snapshot.
- [x] PrivateKey and Certificate file import uses a Desktop File Grant followed by an
      authenticated Runtime REST read. The adapter accepts only a readable regular-file grant,
      reads at most 128 KiB, requires strict UTF-8 and closes both the file handle and grant on
      success, rejection or cancellation; file paths and plaintext never enter browser storage.
- [x] Focused Contract/Repository/Connection Service/Runtime restart tests pass, and the built
      Electron workflow creates multi-protocol credentials, assigns the Profile to a Bookmark,
      verifies reference-only SQLite data and confirms that neither SQLite nor local Vault files
      contain the plaintext values. Its pinned list/editor corpus passes at
      1.2695%/1.1415%/0.9092% for compact/reference/wide without changing the 1.5% threshold.
      SSH certificates and all six protocol sections now apply through their owning connection
      services. Packaged three-platform evidence remains open, so B-08 is not Certified.
- [ ] B-09 is Implemented: the Desktop workflow follows Electerm's item-level JSON
      edit/exclude interaction, adds safe Include authorization and status totals, and
      commits through the typed Runtime client. The bookmark sort menu exposes the same
      import route, while its root-level modal survives a collapsed sidebar and preserves
      the active terminal surface underneath. Focused Contract/Application/Runtime,
      Renderer-model and Electron flows cover edits, nested grants, path redaction,
      stale rollback, repeat convergence and grant cleanup. The pinned preview/item-action
      corpus passes at 1.0012%/0.8326%/0.5992% for compact/reference/wide without changing
      the 1.5% threshold. Packaged platform evidence remains open, so B-09 is not Certified.
- [ ] B-10 is Implemented: checksummed migration 10 records stable Electerm source-to-target
      mappings without storing source payloads. The generation-local preview reads only a
      bounded regular file granted by Desktop Host, rejects incomplete reports, detects
      duplicate IDs, cycles and missing dependencies, and reports every mapped/omitted field
      before any product write.
- [x] The commit route requires the preview's Bookmark tree ETag and creates nested groups,
      five-section Connection Profiles, SSH Hosts/Bookmarks and Quick Commands in one SQLite
      transaction. Repeating an unchanged file produces unchanged entries without duplicate
      data; changed source identities are retained as explicit skips. Credentials are created
      directly in the application-local Vault before commit, represented in SQLite only by
      opaque references and deleted again if the transaction fails.
- [x] The Runtime/OpenAPI/generated client expose preview, cancel, one-shot commit and atomic
      export operations. Portable JSON retains Electerm's `bookmarks`, `bookmarkGroups`,
      `profiles`, `quickCommands` and `config` keys while omitting credential values. The
      desktop panel uses native open/save grants, revokes both grants deterministically,
      displays a searchable bounded mapping report and never places source data in browser
      storage.
- [x] Contract and Application tests cover strict/bounded reports, nested hierarchy,
      repeat convergence, changed identities, cycles, transactional rollback, credential
      cleanup, plaintext exclusion and export shape. The built Electron workflow verifies the
      complete open → preview → commit → save round trip, database mappings, grant cleanup and
      absence of plaintext in SQLite, Vault files and the exported JSON. Later-phase settings,
      theme, workspace and non-SSH dataset mapping plus pinned-reference and packaged evidence
      remain open, so B-10 is not Certified.
- [x] B-12 is Implemented: the real Docker OpenSSH suite now drives the desktop form's
      Save-and-Connect action with a persisted password, Unknown Host Key confirmation and a
      live command round trip. It verifies that one Host and Bookmark are committed before the
      SSH terminal opens, only an opaque credential reference reaches SQLite, and the secret is
      absent from browser storage, the business data directory and encrypted Vault files. The
      pinned form corpus passes all three viewports; packaged evidence remains open, so B-12 is
      not Certified.
- [x] B-02, B-05 and B-11 are Implemented with non-SSH protocol actions, shared
      metadata fields, the live protocol selector and bookmark-scoped Commands/Triggers/Tunnels.
- [x] B-06 is Implemented: the copied macOS arm64 package records a real Docker SSH connection,
      promotes it to a Bookmark, cold-restarts, reconnects with the application-local Vault
      credential and persists history deletion across a second restart. The reviewed evidence is
      `tests/parity/screenshots/axterm/packaged/history.png`; Windows/Linux remain certification work.
      B-04 is Implemented with pinned visual evidence. Complete later-phase data mapping,
      additional fixed states and packaged interaction evidence remain, so Phase 13 is not Certified.

Phase 14 implementation evidence (acceptance remains open):

- [x] T14-01 validates every Renderer text frame with the shared
      `terminalServerControlSchema`; malformed or oversized controls produce bounded
      feedback while subsequent binary output continues directly into xterm.
- [x] Every keyboard, paste and quick-insertion input uses one UTF-8-aware sender:
      32-KiB frames stay below the Runtime 64-KiB limit, a single input and pending
      queue are each capped at 1 MiB, and disconnect disposes the retry timer and queue.
- [x] Runtime replay retains at most 128 KiB of complete vendor chunks, reports
      truncation through a typed control frame and tracks at most 64 stable Renderer
      cursors so reattach does not duplicate already delivered output.
- [x] node-pty 1.1.0 runs with `encoding: null`; a real POSIX PTY fixture proves invalid
      UTF-8 bytes survive the Adapter and Binary WebSocket boundary unchanged.
- [x] T14-02 makes Terminal Profiles effective end to end. New-session and SSH Bookmark
      paths pass `profileId` through REST; the Runtime applies shell/ordered args/cwd,
      bounded non-secret environment, TERM and LANG to local PTY or SSH shell channels.
- [x] Each Terminal Session carries an immutable appearance snapshot. Workspace restore,
      reload and duplicate preserve its font family, size, line height and cursor style/blink,
      and xterm consumes those values instead of hard-coded presentation settings.
- [x] The unconfigured appearance now matches the pinned Electerm baseline: its font fallback
      chain, xterm default line height and four-sided 10 px terminal inset are preserved, while
      explicit per-profile appearance values still override that baseline.
- [x] Profile create/edit UI exposes every implemented field and keeps PATCH sparse. Contract
      defaults normalize legacy JSON rows on read; a real POSIX PTY test and the Docker OpenSSH
      fixture inspect effective cwd/environment/TERM/LANG and profile presentation metadata.
- [x] T14-03 replaces the one-way search box with the pinned interaction model: previous/next,
      case sensitivity, whole-word and regex toggles, live bounded result counts, Enter,
      Shift+Enter and Escape. Empty results and invalid or empty-matching regexes receive explicit
      feedback before xterm search runs; query length is 512 and highlighted matches are capped at
      1,000.
- [x] T14-04 adds a viewport-clamped keyboard-navigable xterm context menu for copy, paste,
      select-all, clear and search. Copy follows current xterm selection state; copy/paste use the
      Browser Clipboard API, report permission failures in the terminal surface and keep paste on
      xterm's existing bounded Binary WebSocket input path.
- [x] Renderer model tests cover search validation/count bounds, option state, menu availability,
      positioning and clipboard failures. A real Electron/node-pty E2E covers every search mode,
      buttons and shortcuts, selection gating, copy/paste, clear, menu-opened search and denied
      clipboard access.
- [x] T14-05 persists paste protection in Terminal Profiles and snapshots it into restored terminal
      tabs. Multiline or >500-character clipboard text opens an accessible, bounded review dialog;
      cancellation sends no terminal input, while confirmation stays on xterm `terminal.paste()` and
      the unified Binary WebSocket sender. Clipboard input above 1 MiB is rejected, and Windows SSH
      CRLF normalization is covered explicitly without exposing Node/Electron to Renderer.
- [x] T14-06 loads a disposable xterm OSC 52 parser with an explicit profile switch and independent
      deny-by-default read/write policy. Only target `c` is accepted; Base64, decoded UTF-8 and
      response bytes are bounded, invalid targets/encoding, limits, permission errors and timeouts
      produce visible feedback, and clipboard read responses return through the existing Binary WS
      sender rather than business IPC.
- [x] Terminal clipboard model tests cover paste thresholds, bounded previews, Windows remote
      newlines, strict OSC 52 parsing, independent policy, size limits, timeout and disposal. The
      Runtime persistence integration test retains all policy fields across a sparse update. A real
      macOS arm64 Electron/node-pty E2E proves review/cancel/confirm, OSC 52 write, malformed-payload
      feedback and the exact OSC 52 read-response escape sequence.
- [x] T14-07 persists a bounded scrollback size, DOM/WebGL preference, Unicode 6/11 choice,
      ligature switch and image-sequence switch in Terminal Profiles and immutable workspace tab
      snapshots. Defaults match the pinned Electerm outcome: 3,000 lines, DOM, Unicode 11,
      ligatures enabled and SIXEL/iTerm images disabled.
- [x] The desktop bundles `@fontsource/maple-mono` 5.3.0 at weight 400 and waits at most two seconds
      for the local face before mounting the workspace. Font readiness/fallback is explicit, xterm
      refits after FontFaceSet readiness, and the Electron fixture checks both the loaded face and
      the resulting terminal row metric instead of relying on an installed system font.
- [x] TerminalView dynamically loads the fixed stable xterm 6 Unicode11, Ligatures, Image and WebGL
      addons only for the selected capabilities, sets the active Unicode provider and disposes every
      addon and WebGL context-loss subscription with its terminal. WebGL initialization or context
      loss visibly falls back to the built-in DOM renderer; unsupported Unicode, ligatures or images
      also report a bounded user-facing failure.
- [x] ImageAddon limits each SIXEL/IIP sequence to 4 MiB, one decoded image to 4,194,304 pixels and
      retained RGBA data to 32 MiB per terminal. Capability model tests cover selection, load order,
      failures, late async disposal and context loss; Runtime restart/sparse-update coverage retains
      the profile settings, and a real macOS arm64 Electron/node-pty fixture emits a Unicode 11 glyph,
      ligature text and iTerm image sequence into the configured terminal.
- [x] T14-08 completes C-06 with a pure Unix timestamp selection model matching the pinned 9/10-digit
      seconds and 13-digit milliseconds rules and 2000–3000 date bounds. TerminalView reads only the
      live xterm selection, formats it in the desktop locale and renders the reference tooltip geometry
      near the latest mouse position with measured viewport clamping.
- [x] Only the active, visible terminal can publish a timestamp tooltip. Invalid or cleared selections,
      terminal focus loss, pane/window resize, hidden tabs and terminal disposal remove it and every
      xterm/DOM/window subscription is released. Table-driven boundary/format/position tests and a real
      Electron/node-pty scenario cover seconds, millisecond precision, invalid input, blur, resize and
      tab-switch cleanup.
- [x] T14-09 persists Electerm's exact terminal word separator, `^?`/`^H` Backspace mode and
      bounded Shift+Enter text in Terminal Profiles. Legacy profiles receive the pinned defaults;
      Runtime returns appearance and behavior together as the immutable terminal-session snapshot,
      so Renderer never rebuilds a live session from a subsequently edited profile.
- [x] TerminalView passes the configured word separator directly to xterm and intercepts only
      unmodified Backspace/Shift+Backspace and Shift+Enter. Backspace uses the selected control byte
      and Shift+Backspace its inverse; Shift+Enter decodes only Electerm's `\\n`, `\\r`, `\\t` and
      `\\\\` forms before using the existing bounded Binary WebSocket sender. Pure model tests cover
      every mapping and boundary, persistence integration covers sparse updates and restart, and a
      real macOS arm64 Electron/node-pty scenario proves `^H` erase plus Shift+Enter execution.
- [x] T14-10 adds Electerm's complete 43-entry terminal encoding list and `displayRaw` to the
      Terminal Profile Contract. Renderer uses one streaming `TextDecoder` per live terminal, keeps
      split multibyte characters intact and falls back visibly to UTF-8 if Chromium does not support
      a pinned label. The status bar can replace only the active decoder without remounting xterm or
      losing its scrollback; the override is bounded by the live tab registry and is not persisted.
- [x] SSH input is transcoded from bounded UTF-8 WS frames with `iconv-lite` 0.7.2 immediately
      before the owned SSH Channel write; local PTY input stays UTF-8 like Electerm. Runtime recent
      output uses the session encoding for bounded AI context. Raw display converts ESC to the pinned
      literal `\\033` form while preserving upstream's DCS exception. Model/Runtime tests cover split
      GBK output, SSH versus local input bytes, raw/DCS behavior and restart persistence. A real macOS
      Electron/node-pty flow covers GB18030 Chinese, a supplementary-plane glyph, live UTF-8 switching,
      raw display and immutable old/new session behavior.
- [x] T14-11 implements Electerm-style per-session Save terminal log and Record actions through a
      Desktop File Grant. Save includes the bounded 128-KiB recent-output window and then continues;
      Record starts with future output. Existing files are appended without truncation, terminal
      escape sequences are interpreted by `@xterm/headless` before completed visual lines are written,
      and the selected Terminal Profile can prefix each line with a millisecond timestamp.
- [x] Runtime exposes only the selected file name and active/stopped/error metadata; the absolute path
      remains inside Host/Runtime grant resolution. A 1-MiB hard pending cap, stream high/low water
      marks and channel pause/resume prevent unbounded logging. User stop, terminal close/exit and
      writer failure flush or close the parser, file stream and listeners deterministically. Unit tests
      cover append, split GBK input, ANSI/cursor output, timestamping, partial-line close and overflow;
      Terminal Service tests cover recent/live output, duplicate start, state controls and redaction;
      a built Electron/node-pty E2E covers Save, Record, Stop and File Grant revocation.
- [x] T14-12 adds the two pinned global terminal settings with defaults off: automatic reconnect and
      restore terminal state on reload. Repository sparse updates and restart persistence retain them.
      Per-Host bounded reconnect remains an explicit override; the global switch applies to established
      SSH connections only, so an initial connection failure never begins an unattended retry loop.
- [x] The Runtime owns reconnect countdowns and cancellation. A typed REST operation cancels the owned
      timer, the timer rechecks the effective setting before connecting, attempt limits remain bounded,
      and close/generation cleanup prevents a delayed connection from escaping its owner. Renderer shows
      the pinned `自动重连: Ns` treatment with immediate retry and cancellation.
- [x] When reload restoration is enabled, TerminalView serializes the normal xterm buffer, appends a
      bounded alternate-buffer snapshot and captures only a validated OSC 633 working directory. The
      state stays in a capacity-limited in-memory registry, is consumed once by the replacement SSH
      terminal, quotes cwd as explicit shell input and is cleared on Runtime generation change. It never
      enters React/Zustand, browser storage or SQLite, and never replays a modifying operation.
- [x] Contract/client generation, Repository restart tests, connection timer/failure/cancel tests,
      shell-integration cwd parsing and terminal reload-state bounds/quoting/consume-once tests pass.
- [x] T14-13 implements the pinned defaults-on touch shortcut bar with all 34 default buttons,
      fixed collapse/edit controls, 44 px reserved layout space and horizontal compact overflow.
      Real visual-viewport keyboard signals distinguish overlay keyboards, recent-touch Android
      layout resizing, rotation and ordinary mouse-driven window resizing; collapse reopens only
      after a terminal touch/focus once a soft keyboard has actually been observed.
- [x] The editor supports candidate search, add/remove/reset, drag ordering, accessible previous/next
      ordering and a two-modifier custom key builder. Configuration uses bounded, unique-ID Runtime
      Settings rather than localStorage; legacy settings receive pinned defaults and sparse updates do
      not write unrelated terminal preferences.
- [x] Shortcut clicks resolve cursor/Home/End CSI versus SS3 bytes from xterm's live DECCKM state and
      use TerminalView's existing bounded Binary WebSocket input sender for the active pane. Model,
      Contract and SQLite restart tests cover defaults, combos, bounds, ordering and detection; a real
      Electron/node-pty flow covers editing, persistence writes, Enter execution, collapse/reopen and
      compact-window overflow without Renderer Node access or terminal bytes in React state.
- [x] T14-14 adds the pinned default-off command-suggestion setting and a trusted input model that
      becomes active only inside an OSC 633 shell prompt. It handles bounded printable input,
      Backspace/Delete/Home/End/left/right and common line-edit controls; unknown controls, prompt
      exit, inactive panes, blur, resize, disable and terminal disposal close the surface and cancel
      every timer or AI request. Password and OTP prompts are outside the trusted prompt lifecycle.
- [x] The 80 ms suggestion refresh queries the Runtime command-history aggregate, keeps Electerm's
      exact-prefix/source de-duplication and frequency order, reverses a 200–300 px list above the
      cursor when needed, supports Escape, cyclic arrow selection and history deletion, and sends
      only cursor-right movement plus the unmatched suffix over the existing bounded Binary WS.
      Selection never sends Enter. History and explicit AI caches have a 32-key LRU bound and clear
      on history revision changes; AI is available only by user action and runs through the Runtime
      Provider with redaction, a 20-second timeout and AbortController cancellation.
- [x] Pure input/ranking/insertion/AI-parser/cache tests, OSC prompt lifecycle tests, Contract sparse
      default tests, SQLite restart persistence and a real Electron/bash E2E cover frequency order,
      keyboard insertion without execution, Escape, deletion and cache refresh. Phase 18 will attach
      the predeclared Batch and Quick Command sources when their real aggregates exist.
- [x] T14-15 implements the persisted ask/upload/path-insert file-drop preference on the active
      terminal. Browser `File` bodies stream through authenticated Runtime HTTP into Desktop Host
      temporary File Grants; the Renderer sees only grant IDs, names and expiry metadata. Grants are
      generation-bound, expire after one hour and delete their private temporary files on revoke,
      failure, cancellation, generation replacement or Host shutdown.
- [x] The reference-sized 400 px decision dialog lists up to 32 files, traps keyboard focus and
      disables upload unless the active SSH terminal has a ready connection. Path insertion uses a
      bounded Runtime terminal input method and never appends Enter. Upload reuses the existing
      idempotent SFTP queue at the current validated OSC 633 directory; its progress and cancel path
      stay in the global transfer center. Directories, unsafe names, files above 4 GiB, batches above
      8 GiB and unavailable SFTP fail explicitly.
- [x] Pure validation/path tests, Host import/revoke/private-path tests, Contract sparse-update and
      SQLite restart tests, Terminal Service no-execution coverage and a real Electron/bash flow cover
      ask, disabled upload, cancellation cleanup, path insertion, explicit execution and no-SFTP.
- [x] The pinned Docker OpenSSH desktop journey now drops a real file into a ready SSH terminal,
      waits for the queued SFTP upload and reads the exact payload from the remote shell. The same
      journey cancels a 128 MiB upload through the transfer-center UI and verifies that neither the
      final target nor an `.axterm-*.part` file remains.
- [x] T14-16 adds a nullable, persisted global default Terminal Profile. Every local, SSH,
      Quick Connect, history and new-session-menu path now resolves an explicit selection first,
      then a Bookmark profile, then the global profile and finally platform defaults. Once the
      profile collection is loaded, deleted references fall through instead of breaking session
      creation; the Runtime rejects a newly assigned unknown reference.
- [x] The settings surface lists live Profiles and shows a missing-reference recovery option; the
      new-session menu distinguishes an explicit selection from `全局默认（Profile）`. Pure
      precedence/Contract tests, SQLite restart persistence and the real terminal-profile Electron
      flow prove that leaving the menu selector at its default applies the configured PTY snapshot.
- [ ] C-02 remains Implemented pending long-running stress and packaged evidence on all
      three platforms. C-01 and C-03 are Implemented pending Windows/Linux packaged evidence and
      three-platform IME/clipboard certification. C-04 and C-05 are Implemented, pending
      three-platform keyboard, clipboard and visual evidence. C-06 is Implemented pending
      three-platform packaged selection and reference visual evidence. C-07 is Implemented pending
      Windows/Linux packaged glyph/image, renderer-fault and reference visual evidence. C-08 is
      Implemented pending Windows/Linux packaged key and word-selection evidence. C-09 is Implemented pending real non-UTF-8 SSH evidence
      and Windows/Linux packaged raw-byte certification. C-11 is Implemented pending its pinned
      recording-menu/state screenshots and packaged Windows/Linux evidence. C-12 is Implemented pending
      real network-loss/reload/sleep, reference visual and packaged-platform evidence. C-13 is
      Implemented pending fixed screenshots, physical touch keyboards and Windows/Linux packaged
      evidence. C-14 is Implemented with the Phase 18 Batch/Quick sources attached, pending its
      command-suggestion-specific fixed visual and packaged
      Windows/Linux evidence. C-15 is Implemented pending a real SSH drop-upload/transfer-cancel
      fixed visual and packaged Windows/Linux evidence. C-10 belongs to Phase 19 and C-16 to Phase 17.
      Phase 14 visual/macOS packaged evidence is the active queue; Phase 14 remains open.

- [x] The 2026-09-13 Phase 14 recapture includes `terminal.basic`,
      `terminal.productivity` and the completed H-04/C-10 `terminal.addons-settings` surface at
      compact/reference/wide viewports. All nine images pass the current 95% similarity rule;
      `terminal.addons-settings` records 96.396% / 96.645% / 97.154% similarity. The broader
      current 48-scene corpus passes 144/144 visual comparisons and 1008/1008 hard-defect checks, so
      T14-VIS-03 is closed.
- [x] The unsigned macOS arm64 `.app`, DMG and ZIP were rebuilt and the copied packaged
      app passed local PTY, SQLite and real Docker SSH terminal journeys. Windows/Linux
      packaged evidence remains open, so Phase 14 is not Certified.

Phase 15 implementation evidence (acceptance remains open):

- [x] D-04 persists strict per-Host SSH `connectionOptions` for connection timeout,
      keepalive interval/count, compression and a bounded manual/automatic reconnect policy.
      Defaults match the pinned Electerm 5.5.0 outcomes: 50-second connect timeout,
      10-second keepalive, 10 unanswered probes, compression preferred, automatic reconnect off
      and a 3-second delay when enabled.
- [x] D-04 has built desktop evidence against a real in-process SSH server and stable
      Host Key. The test opens a terminal, closes the listener and live SSH socket, observes the
      live reconnect countdown, restores the same endpoint and proves immediate retry recreates
      both connection and terminal output. A second interruption proves `停止重连` clears the
      owned timer and settles the visible connection as `RECONNECT_CANCELED`.
- [x] Checksummed migration 4 backfills compatible defaults for existing Host rows and adds
      SQLite range/enum checks. Repository nested patches preserve unspecified values, carry one
      Host ETag/event transaction and roll back with their outer Unit of Work.
- [x] ConnectionService applies each jump/target Host's effective timeout, keepalive and
      compression settings through `SshTransport` to ssh2. Automatic reconnect owns a bounded
      attempt counter, next-attempt timestamp and timer; close/abort/unexpected disconnect remove
      listeners, cancel the timer and close every partial or ready jump-chain handle.
- [x] Contract, migration/restart, Repository rollback, ssh2 config-capture and reconnect cleanup
      tests cover defaults, overrides, invalid bounds and runtime/persistent state separation. The
      pinned Docker OpenSSH fixture passes with explicit timeout, keepalive and compression options.
- [x] The SSH Bookmark create/edit form exposes every bounded connection timeout, keepalive,
      compression and reconnect-policy field. A real Electron workflow verifies create, edit and
      reopen persistence through the generated client.
- [x] D-05 adds explicit global `direct`/`custom` and per-SSH-Bookmark
      `inherit`/`direct`/`custom` proxy policy. Migration 7 backfills existing Hosts to inherit and
      global settings to direct; URL validation accepts only HTTP, HTTPS, SOCKS5 and SOCKS5h
      origins and rejects embedded credentials, paths, queries and fragments.
- [x] Proxy passwords use the application-local Host Credential Vault exclusively. Settings,
      Hosts, OpenAPI responses, logs and Renderer query state retain only `credentialRef`; the test
      endpoint may carry a password for one authenticated request and never persists or echoes it.
- [x] `ProxyService` resolves effective policy at connection time and hands one bounded,
      abortable proxy socket to the first SSH hop. Connection and ssh2 failure/close paths destroy
      every pending or transferred socket; later jump-chain hops continue through SSH `forwardOut`.
- [x] Global settings and the SSH Bookmark editor expose proxy policy, endpoint, local credential
      save and target-aware connection tests. Contract/model tests plus authenticated HTTP and
      SOCKS5 adapter fixtures, a real loopback Runtime HTTP CONNECT fixture, migration/restart,
      typed error and jump-chain cleanup tests pass.
- [x] D-06 adds a strict per-Bookmark ProxyCommand resource: one executable and at most
      32 bounded argument templates with required `%h` and `%p`, optional `%r`, and literal
      `%%`. Unknown placeholders and control lines fail Contract validation.
- [x] Migration 11 persists the executable and argument array without rebuilding the existing
      Host table. `StdioProxyCommandRunner` uses `spawn(..., { shell: false })`, preserves every
      substituted value as one argv item, streams bytes directly to ssh2, caps stderr at 8 KiB
      and owns abort/exit/error cleanup. Typed errors never echo process stderr through REST.
- [x] Unit tests cover placeholder and injection boundaries, duplex backpressure, non-zero exit,
      missing executable and cancellation. Runtime/service tests cover first-hop selection;
      a real Electron form saves the command, and the pinned Docker OpenSSH test completes an
      authenticated SSH connection through a Node relay ProxyCommand.
- [x] D-07 migration 12 stores an ordered, unique list of at most eight saved jump Hosts while
      preserving the legacy single-link field for existing data and SSH Config imports. Editing
      a legacy chain materializes its complete path into the new list without modifying hop Hosts.
- [x] The SSH Bookmark hopping tab adds, reorders and removes entries with a live path preview.
      Repository validation rejects duplicates/self cycles, deletion removes dangling references,
      and Runtime establishes the exact first-to-last sequence. Close now waits target-to-first-hop
      sequentially, preventing nested ssh2 compressed channels from writing after their parent closes.
- [x] Repository/service and Electron tests cover persistence, reorder, path rendering and socket
      ownership. `bun run test:ssh` now launches three isolated OpenSSH containers and proves two
      `forwardOut` hops followed by terminal/SFTP use with no unhandled close error.
- [x] D-08 migration 13 persists ordered KEX, cipher, server Host Key and HMAC lists. The advanced
      SSH Bookmark controls keep empty lists on ssh2 defaults, and Runtime passes each configured
      list plus compression to its owning hop. Contract/repository/Adapter/Electron tests and the
      Docker OpenSSH accepted/unsupported negotiation cases pass.
- [x] D-09 migration 14 persists the startup directory, bounded non-secret environment and ordered
      login/run script rows with per-item delay. The Bookmark editor supports adding and removing
      reusable script rows. Runtime waits for Shell Integration, then queues environment, login
      scripts, a POSIX-quoted directory change and run scripts through the terminal's existing
      bounded/encoded input path; queue overflow closes the new terminal.
- [x] D-09 Contract, migration/restart, sparse-patch, exact-order/quoting, Electron persistence and
      real Docker OpenSSH marker tests pass. The real fixture proves the saved environment, login
      script and `/config` directory are visible to the final run script.
- [x] D-10 migration 15 and the SSH Bookmark editor persist an opt-in local DISPLAY. The ssh2
      adapter accepts local display numbers/socket paths, probes the endpoint, resolves xauth with
      a bounded `spawn(..., { shell: false })`, requests X11 on the shell and multiplexes incoming
      channels through one connection-owned listener.
- [x] Closing the last X11 terminal removes its listener and destroys every local/remote socket.
      Unit tests cover display restrictions, missing endpoints and ownership; Contract,
      migration/restart and Electron persistence pass. The real Docker OpenSSH fixture enables X11
      and pipes `D10_X11_PIPE` from its allocated remote DISPLAY through ssh2 to a local TCP fixture.
- [x] D-11 replaces the placeholder Bookmark tunnel tab with CRUD for saved local, remote and
      dynamic profiles, using profile ETags and exact-Host ready-connection gating. The global tunnel
      center exposes the same profiles with useful Host/type/bind/target details, actual ephemeral
      ports and active/failed state, and supports start, stop and failure dismissal.
- [x] Tunnel start failures remove their SSH-owner subscription. A bound-port collision produces a
      typed `CONFLICT` plus inspectable `TUNNEL_PORT_IN_USE`; SSH owner loss produces
      `SSH_CONNECTION_CLOSED` and releases local servers, remote forwards, channels and sockets.
      Runtime lifecycle tests, the real Bookmark editor Electron CRUD journey and `bun run test:ssh`
      pass; the latter retains real local, remote and dynamic OpenSSH forwarding coverage.
- [x] D-12 adds a real shared-transport load assertion: while a 256 MiB SFTP upload remains
      `running`, an already-open PTY completes a constructed, non-echo marker round trip below
      1.5 seconds. The fixture then validates all 268,435,456 transferred bytes, removes the remote
      file and closes the terminal/connection through their normal paths.
- [x] Each transfer owns and closes its own SFTP handle, keeps at most four file streams active and
      the Runtime now rejects a 33rd active task with typed `TRANSFER_FAILED`. A capacity test holds
      32 owners concurrently, verifies rejection and drains the service to zero on shutdown.
- [x] D-01 makes the three pinned Bookmark auth choices functional: Password and
      PrivateKey/Certificate use Host credentials, while Profiles immediately exposes the real
      connection Profile selector on the Auth surface. MFA/OTP preserves a password as an opaque
      application-local Vault reference under Keyboard Interactive and never echoes it on reopen.
- [x] Runtime auto-answers only a matching single hidden Password challenge, then exposes every
      follow-up challenge with a monotonic attempt number, target identity and exact fields. The
      ssh2 Adapter uses an explicit method order and resets it on partial success. Service tests
      cover an automatic Password response plus two UI responses; a real ssh2 server proves the
      Password → OTP protocol sequence, Electron verifies local-only persistence, and the Docker
      password/Host-Key/terminal/SFTP suite remains green.
- [x] D-02 migration 16 persists a separate certificate credential reference and strict Agent
      enabled/path object. The Host form stores private keys, passphrases and certificates as
      independent application-local Vault entries; duplicate, edit and delete workflows preserve
      or clean every reference without putting secret values in the product database or browser
      storage.
- [x] `POST /api/v1/ssh/agent/probe` reports Runtime-platform status through the generated REST
      contract. Unix probes require an actual socket and support `SSH_AUTH_SOCK` or an explicit
      path; Windows supports Pageant and validates named-pipe syntax. The form exposes enable,
      path, probe and actionable available/unavailable/invalid feedback.
- [x] ConnectionService resolves direct-Host and Connection-Profile certificate references and
      composes Agent fallback without collapsing authentication modes. The ssh2 Adapter validates
      the OpenSSH v01 certificate envelope and embedded key against the private signer before use.
      A real ssh2 server observes the unsigned certificate request followed by the signed request;
      mismatch and wrong-passphrase cases fail before network authentication.
- [x] Contract bounds, migration/backfill/SQLite checks, sparse Repository restart, Unix socket and
      Windows capability models, credential cleanup, Runtime resolution and built Electron
      persistence/status/reopen tests pass on macOS arm64. The production bundle was also checked
      against Electron's CommonJS loading boundary after adding the certificate parser.
- [x] D-03 promotes saved Host Keys to a versioned REST resource. The Common settings surface lists
      target, algorithm, SHA256 fingerprint and first/last verification times; revocation requires a
      user decision, uses If-Match, emits `known-host-key.revoked` and makes the next connection return
      to the Unknown flow.
- [x] Unknown identity interactions now show user/host/port, key algorithm and the presented
      fingerprint. Changed identity interactions use high severity, show both stored and presented
      fingerprints, name interception risk and require an explicit checked acknowledgement before
      “替换密钥并连接”. Repository version/event tests, service detail assertions and built Electron
      list/revoke persistence pass.
- [x] D-04 is Implemented. Fixed reconnect screenshots, sleep/resume behavior and packaged
      macOS/Windows/Linux evidence remain certification work; these evidence gaps do not remove
      the verified live Runtime/Renderer behavior.
- [ ] D-05 is Implemented pending the Electerm-reference screenshot/interaction suite and packaged
      macOS/Windows/Linux proxy evidence. It is not Certified, and no system credential facility is
      part of this path.
- [ ] D-06 through D-11 are Implemented pending their pinned form/status visuals, real desktop X
      Server/fault/reconnect scenarios, tunnel restart-after-reconnect behavior and packaged
      macOS/Windows/Linux evidence. D-12 has its real shared-channel load evidence; fixed UI and
      packaged load evidence remain. D-01 is Implemented pending challenge/form visuals and
      packaged cross-platform evidence. D-02 is Implemented pending fixed auth/status visuals and
      packaged Pageant/OpenSSH-Agent fixtures on Windows/Linux. D-03 is Implemented pending fixed
      unknown/change/revocation visuals and packaged cross-platform evidence. D-04 has real
      network-loss/recovery/cancel evidence; its sleep/resume, fixed visual and packaged evidence
      remain open.

Phase 16 implementation evidence (acceptance remains open):

- [x] File Manager is mounted inside its owning session instead of opening a second top-level
      workspace tab. A local session exposes `Terminal / File Manager`; an SSH session exposes
      `SSH / SFTP` and pins the remote pane to that session's connection. The file view remains
      scoped to the active pane, while switching back reveals the same live terminal instance.
- [x] The fixed `files.browse-operate`, `files.transfers` and `files.edit-inspect` parity drivers
      connect both products to the same disposable Docker OpenSSH target at 1280×800, 1440×900 and
      1920×1080. They exercise real local directory authorization, SFTP listing, multi-selection,
      context actions, a 128 MiB streaming upload and remote UTF-8 editor/search. All nine visual
      comparisons pass at 95.171%–98.166%; all 63 candidate hard-defect checks pass. Manual review
      found no clipped primary action, escaped overlay, overlap or unreadable state. The first
      capture exposed an undersized dark context menu and a card-sized workspace; production styles
      now use the upstream blue selected state, readable menu density and full-height SFTP surface.

- [x] E-01 provides local-only, remote-only and split file views with independent pane headers,
      address bars and tables. The 25–75% split supports pointer and keyboard resize and retains its
      width across view switches in workspace UI state.
- [x] Local directory access crosses a generation-bound Desktop File Grant. On first entry the
      Host grants the operating-system home directory, so macOS opens at `/Users/<user>` without a
      picker. The address field displays the canonical absolute directory and accepts another valid
      absolute directory, replacing and revoking the prior grant. File operations still submit only
      the grant ID plus normalized relative paths; Host containment rejects escapes. Listings remain
      capped at 10,000 entries with metadata reads in batches of 32.
- [x] An SSH session now resolves its initial SFTP address with the authenticated channel's
      `realpath('.')`, so the remote pane opens the account home instead of `/`. Explicit file intents,
      remembered per-connection navigation, FTP initial directories and terminal-cwd following take
      precedence. A failed home lookup falls back to `/` with visible feedback, and each lookup owns
      and closes its SFTP channel.
- [x] The Docker OpenSSH desktop journey shows a real authorized local directory and a real remote
      SFTP directory in the same split workspace. Fixed viewport visuals and packaged Windows/Linux
      directory-grant/resize evidence remain certification work.
- [x] E-02 provides editable local and remote absolute addresses with explicit Enter-to-navigate
      behavior, root, parent, refresh, bounded history and favorites. Local navigation state remains
      relative to the active directory grant internally while the UI consistently renders the
      grant's canonical absolute root plus that relative path. Remote favorites are scoped by Host
      and persist in Runtime Settings behind ETag-protected REST rather than browser storage.
- [x] The active SSH terminal contributes its validated in-memory OSC 633 cwd without exposing
      terminal bytes or adding IPC. Contract/Runtime restart tests cover settings persistence; the
      built Electron local tree covers history, favorites and traversal rejection, while the real
      Docker OpenSSH desktop journey covers terminal-folder navigation, remote history/favorites,
      SQLite persistence and invalid remote addresses. Fixed viewport and packaged Windows/Linux
      evidence remain certification work.
- [x] E-03 replaces the fixed metadata rows with a shared local/remote table modeled on Electerm's
      `list-table-ui` and `paged-list`: directories remain first, all columns sort in both
      directions, nine metadata columns are selectable, and adjacent columns resize by pointer or
      keyboard. The upstream default name/size/modified-time columns plus independent pane sort
      state persist in Runtime Settings with legacy backfill.
- [x] Desktop Host and SFTP entries now carry access time, owner and group. A 32 px fixed-row,
      six-row-overscan virtual window bounds mounted rows and reports its displayed range. The
      built Electron test proves 362-entry virtualization, sort, column choice, keyboard resize
      and SQLite persistence; the real Docker OpenSSH/SFTP journey still passes. A measured 10k
      budget, fixed screenshots and packaged Windows/Linux evidence remain certification work.
- [x] E-04 uses Electerm's default-on hidden-file preference. Local and remote panes have
      independent eye toggles and case-insensitive name filters that commit on Enter/confirm,
      clear explicitly and reset only when their own path changes. The most recent hidden toggle
      becomes the ETag-protected Runtime default for future workspaces.
- [x] Contract and Runtime restart tests cover the preference and legacy backfill. The built
      363-entry local fixture proves dotfile show/hide, mixed-case matching, clear and path reset;
      real Docker SFTP proves the remote equivalent. Fixed visuals and packaged Windows/Linux
      evidence remain certification work.
- [x] E-05 keeps bounded pane-scoped selection sets, anchors and focused rows over each pane's
      current sorted/filtered view; selecting on the other side clears the prior side. Plain click
      replaces selection, platform Cmd/Ctrl toggles,
      Shift click expands or shrinks the contiguous range and Cmd/Ctrl+A selects all listed paths.
      Arrow keys, Shift+Arrow, Home/End, Enter, Space and Escape provide a roving keyboard path that
      scrolls virtual rows into view; selected rows expose `aria-pressed` and the footer reports count.
- [x] Pure model tests cover toggle, range shrink, select-all, wrap and out-of-pane rejection. The
      built 363-entry Electron workspace covers mouse modifiers, range, keyboard range, full virtual
      selection and clear; real Docker OpenSSH covers remote modifier/range/keyboard behavior and
      cross-pane clearing. Fixed visuals and packaged three-platform modifier/focus evidence remain open.
- [x] E-06 adds one keyboard-navigable context menu for local and remote rows plus pane background.
      It exposes open/enter, new file, new directory, rename, single or multi-path copy, delete,
      information, select-all and refresh; remote entries also expose chmod. Right-clicking a selected
      row preserves its multi-selection while right-clicking another row replaces it.
- [x] Local create/rename/delete/open/copy operations cross authenticated Runtime REST into Desktop
      Host File Grants. Canonical containment and generation/read-write checks prevent grant escape;
      absolute local paths stay inside Host and reach only the native application launcher or clipboard.
      Remote empty-file creation, rename, deletion and metadata use isolated SFTP channels. The write
      completion boundary waits for ssh2's remote file-handle close, avoiding the zero-byte OPEN/CLOSE
      race found by the real Docker fixture.
- [x] Host unit coverage includes file/directory creation, conflicts, rename, delete, traversal rejection,
      native open and multi-path clipboard behavior. Built Electron covers the complete local action
      matrix and native clipboard; pinned Docker OpenSSH covers remote create/info/rename/copy/delete
      alongside the existing SSH/SFTP journey. Fixed visuals, packaged Windows/Linux behavior and a
      broader permission-error corpus remain certification work.
- [x] E-07 adds bounded internal copy/cut state for one local grant or one SSH connection, context-menu
      actions and platform Cmd/Ctrl+C/X/V shortcuts. Renderer receives only the active directory
      Grant's display root; clipboard and mutation payloads retain grant IDs plus relative paths.
      State invalidates when the grant/connection changes, keeps copied items available
      for repeated paste and clears cut state after a successful move.
- [x] Rows can drag the selected batch onto a directory, the pane background or `..`; same-pane drops move
      through the same typed operation boundary and expose an explicit target highlight. Same-directory
      copies use `(copy-N)` conflict names, source-to-descendant moves are rejected, recursive operations
      cap traversal at 20,000 entries and skip symbolic links without following them.
- [x] Desktop Host tests cover file and recursive-directory copy, collision rename, move and self-descendant
      rejection. Runtime SFTP tests cover the same file/directory operations and channel cleanup. Built
      Electron and pinned Docker OpenSSH desktop journeys both cover keyboard copy/paste, cut/paste and
      drag-to-folder; the local journey also exposed and fixed root-level parent navigation. Fixed drag/
      clipboard visuals, cancellation/failure cases and packaged three-platform evidence remain open.
- [x] E-08 accepts a validated private multi-row drag payload across the local/remote pane boundary and
      opens an explicit upload/download decision before creating work. The dialog states direction,
      item count, destination and rename-on-conflict behavior; Escape/cancel creates no transfer and a
      batch is limited to 32 independently cancelable queue entries.
- [x] The remote table also accepts ordinary operating-system `Files` drops on its background, a file
      row, `..` or a directory row. Each file streams into a temporary generation-bound grant and is
      queued immediately to the selected destination with existing progress, cancellation and conflict
      handling. Unsafe names, empty drops, more than 32 files, files over 4 GiB, batches over 8 GiB and
      direct folder drops return explicit feedback; folders remain available through Upload directory.
- [x] Cross-pane requests contain only an opaque local directory-grant ID plus a normalized relative
      path. Runtime asks Desktop Host to resolve each source or write target immediately before streaming;
      Host rejects stale generations, insufficient permission, traversal and symlinks, and the absolute
      path never enters Renderer state, browser storage or a public API response. Existing recursive,
      bounded HTTP/FS/SFTP streams and transfer cleanup are reused.
- [x] The pinned Docker OpenSSH desktop journey drags a real local file into a remote directory, then
      multi-selects two remote files and drags them into a local directory. It verifies both directions'
      final bytes and queue feedback. Host/Transfer/SFTP tests cover the resolution boundary and owned
      channels; successful-transfer refreshes are revision-deduplicated. Fixed dialog/drag visuals,
      injected partial-batch failure and packaged Windows/Linux evidence remain certification work.
- [x] E-09 adds a typed `remote-copy` transfer whose source and target are explicit ready SSH
      connection IDs and absolute remote paths. Runtime opens separately owned source and target SFTP
      channels, pipes bytes directly between them with backpressure and one cancellation signal, commits
      through a target-side temporary file, and closes both channels on success, failure or cancellation.
- [x] Same-connection copies still use two independent SFTP channels. Recursive copies preserve the
      20,000-entry and four-stream limits, skip symlinks, create bounded destination directories and
      reject a same-connection source copied into its descendant. Transfer history, progress, cancel and
      retry use the existing persistent task model without a local staging directory.
- [x] The remote file context menu opens an explicit target-connection/path dialog for up to 32 selected
      entries. Runtime unit fixtures prove same-server, cross-server and recursive final bytes plus exact
      channel cleanup; the pinned Docker desktop journey proves the user-visible same-connection flow
      against real OpenSSH/SFTP. A real two-server Docker UI journey, fault injection, fixed visuals and
      packaged Windows/Linux evidence remain certification work.
- [x] E-11 adds `ask` as an explicit transfer conflict policy. A real collision moves its task to the
      typed `awaiting-decision` state with a bounded safe target label; the generated REST client can
      choose skip, overwrite/merge or rename and can apply that decision to later conflicts in the same
      recursive task. Static policies remain available for automation.
- [x] Ask-mode tasks serialize their four-stream worker pool until a policy is chosen, preventing
      concurrent dialogs. Cancellation rejects the pending decision and enters normal canceled cleanup;
      successful decisions restore the preceding preparing/running state. File-over-directory and
      directory-over-file overwrites remove the old tree with the same 20,000-entry ceiling.
- [x] The file workspace presents one conflict at a time with path, entry type, the three decisions and
      an apply-to-all checkbox. The global transfer center counts waiting tasks as active. Runtime tests
      cover a recursive merge-all decision and final bytes; the real Docker UI pauses on an existing
      remote target, applies rename and verifies the new file. Mixed upload/download batches, injected
      disconnects, fixed visuals and packaged Windows/Linux evidence remain certification work.
- [x] E-12 adds a real `paused` task state. Runtime gates the next Transform chunk behind a resume
      promise, so Node/SFTP backpressure stops further source reads with at most one bounded chunk held;
      resume continues the same pipeline and cancel releases the gate before aborting all owned streams.
      Pause/resume reject invalid task states rather than silently changing completed work.
- [x] Migration 17 persists measured bytes per second. Transfer responses now include bounded safe
      source/destination descriptors, while local absolute paths remain absent. The transfer center shows
      active count, aggregate progress, per-task progress/speed/paths and state, plus pause, resume,
      cancel, retry and transactional clearing of completed persistent history.
- [x] Unit coverage proves pause/resume/cancel cleanup, final speed persistence and history clearing.
      The real 128 MiB Docker OpenSSH desktop upload pauses, visibly reaches `已暂停`, resumes and then
      cancels with target/temporary-file cleanup. Long-duration speed accuracy, restart/fault screenshots
      and packaged Windows/Linux evidence remain certification work.
- [x] E-13 adds create-then-edit and existing-file editor entry points backed by one CodeMirror
      surface. It loads at most 2 MiB of UTF-8, preserves LF/CRLF, exposes dirty state, bounded search,
      full-draft copy, explicit save and Cmd/Ctrl+S, and confirms before discarding an unsaved draft.
- [x] Editor revisions include both remote metadata and content bytes, so same-size changes inside one
      server timestamp tick still produce `REMOTE_EDIT_CONFLICT`. The current draft remains visible and
      offers reload or Save As. Save writes a same-directory temporary file, retains the existing mode and
      uses the OpenSSH POSIX atomic-rename extension; servers without that safe capability return a typed,
      actionable error and leave the original intact.
- [x] SFTP stream ownership now survives beyond pipeline/iterator listeners until each ssh2 stream closes,
      then closes the Channel. This fixes a real delayed `No response from server` read-stream error that
      previously crashed and restarted Runtime. Unit tests cover empty files, LF/CRLF, metadata-stable
      conflicts, unavailable atomic replace and channel cleanup; the pinned Docker desktop journey creates,
      edits, searches, copies, saves and reopens exact bytes without losing the SSH session. Fixed editor/
      conflict visuals, permission/disk faults and packaged Windows/Linux evidence remain certification work.
- [x] E-14 creates an expiring, generation-bound editable File Grant in a private Desktop Host
      directory and opens the safe, extension-preserving temporary name with the system default editor.
      Renderer receives no local path. Runtime owns at most eight memory-only sessions containing the remote
      revision, original line-ending policy and a local baseline hash; its typed status detects saved local
      bytes while upload remains an explicit user action.
- [x] External upload reuses E-13's content-aware conflict and atomic-replace guarantees. A conflict leaves
      the local draft and session intact, while completion, one-hour expiry, generation change and Runtime/
      Host shutdown revoke the grant and recursively remove its private directory. Host and service tests
      cover private-path hiding, change detection, conflict state and cleanup. The Docker desktop journey
      mocks only native launch, edits the real Host file, observes the changed state, pushes explicitly, proves
      cleanup and reopens exact remote bytes over SFTP. Fixed conflict/expiry states, open failures and packaged
      Windows/Linux default-editor evidence remain certification work.
- [x] E-15 adds a typed local/remote file-comparison service and modal with reference-shaped Information
      and Content tabs. Local sources are resolved through a generation-bound directory File Grant; remote
      sources use an independently owned SFTP channel. The comparison request remains grant-relative and
      its public response contains no local path beyond the File Manager's separately visible directory root.
- [x] Comparison distinguishes exact UTF-8 `equal` and `different` results, extension/content-detected
      binary and directory `unsupported` results, and 2 MiB or 10,000-line `too-large` results. Unsupported
      and oversized responses omit contents. Unit fixtures cover every state and strict response parsing;
      the Docker OpenSSH desktop journey keeps one selection in each pane and verifies both real file bodies
      in the visible split diff. Fixed state visuals, injected read faults and packaged Windows/Linux evidence
      remain certification work.
- [x] E-16 unifies local and remote metadata in a file-information modal showing type, path, size,
      symbolic/four-digit octal mode, owner, group and access/modify timestamps. Non-symlink entries expose
      an owner/group/other `rwx` grid and validated octal input; changes apply explicitly to one item, without
      recursion or privilege escalation.
- [x] Local chmod stays inside Desktop Host, canonicalizes the active directory grant and refuses symlinks;
      remote chmod performs `lstat` through a separately owned SFTP channel and also refuses symlinks. Host/
      SFTP tests cover successful modes and link refusal. The Docker desktop journey changes a real remote
      file from 0600 to 0640 and reopens the exact `rw-r-----` state. Fixed denial/symlink visuals and packaged
      three-platform evidence remain certification work.
- [x] E-17 adds a directory-only compressed upload/download option to both file-pane context menus. Runtime
      creates one private tar stream, reports its bytes through the existing persistent transfer queue and
      extracts into a same-parent temporary directory before an atomic rename. Overwrite keeps a backup until
      the new directory has committed, so extraction or rename failure restores the original target.
- [x] Local packing skips symbolic links; local extraction rejects symbolic and hard-link entries and relies on
      `node-tar` path containment. Remote commands quote every path, refuse filesystem roots and report a
      missing `tar` as `CAPABILITY_UNAVAILABLE`. Archive, extraction, backup, stream and SFTP resources are
      task-owned and cleaned on success, failure or cancellation. Unit coverage proves missing-tool cleanup;
      the Docker OpenSSH desktop journey downloads a real nested directory and verifies both extracted files.
      Fixed progress/failure visuals, large-tree cancellation/fault injection and packaged Windows/Linux
      evidence remain certification work.
- [x] E-18 adds local `Reveal in File Manager` plus local/remote `Open Terminal Here` actions to
      directory rows and pane backgrounds. Native reveal runs only in Desktop Host after canonicalizing the
      active generation-bound directory grant; local terminal creation resolves the same opaque grant plus
      relative path inside Runtime immediately before opening node-pty. Renderer displays the directory
      Grant root in the address bar but does not persist it in browser storage or send it in the action.
- [x] Remote working directories are bounded absolute paths that override a bookmark's saved startup folder
      through the existing quoted SSH startup sequence. Both local and SSH actions honor the default Terminal
      Profile and create ordinary workspace tabs. Host tests cover canonical root/child resolution and reveal;
      Connection Service tests cover quote-safe override ordering; the Docker desktop journey verifies the
      native canonical path and exact `pwd` from real local PTY and SSH terminals. Packaged Windows/Linux
      file-manager and shell evidence remains certification work.

Phase 17 implementation evidence:

- [x] F-01 adds protocol-specific FTP bookmarks with plain FTP, explicit FTPS and implicit FTPS,
      TLS verification, initial directory and seven control encodings. Passwords use the application-local
      Host Vault; SQLite migration 18 persists only the opaque `credentialRef` and strict connection metadata.
- [x] Runtime adapts pinned Electerm's per-operation client pattern through a `FtpTransport` port and
      `basic-ftp` Adapter. Browse/create/rename/delete and file or recursive directory upload/download use
      typed REST, existing File Grants and the persistent transfer queue. Each client serializes its control/data
      operations; listing and streams are bounded and every connection, stream and abort path is closed.
- [x] The Host manager exposes FTP/FTPS cards and a protocol form; Save-and-Connect opens the shared dual-pane
      file workspace with FTP/SFTP connection selection, progress, conflict, pause, cancel and retry behavior.
      Unsupported FTP terminal, remote editor, archive and remote-copy actions are visibly disabled instead of
      being sent to SSH/SFTP routes.
- [x] Tests cover migration/restart, local credential resolution, Connection Profile override behavior, FTP/FTPS
      option mapping, legacy encoding, streaming transfer routing and cleanup. A real loopback FTP control/data
      fixture performs directory listing, upload and download. A real TLS fixture, fixed visual states and packaged
      macOS/Windows/Linux journeys remain certification evidence, so F-01 is Implemented rather than Certified.
- [x] F-02 adds a Telnet Bookmark payload with host, port, username, prompt regular expressions, encoding,
      timeout and an application-local Vault reference. SQLite migration 19, the Repository/Unit of Work and
      generated Contract persist and return only the opaque credential reference. Connection Profile username
      and password fields override Bookmark values without copying secrets into Runtime business storage.
- [x] The `TelnetTransport` port and Node Adapter implement bounded prompt detection, Electerm-compatible raw
      or `/pattern/flags` prompt syntax, legacy text encoding, IAC command parsing, terminal-type negotiation,
      NAWS resize, IAC escaping, connect cancellation/timeout and deterministic socket cleanup. Terminal data
      continues over the existing authenticated Binary WebSocket and bypasses React/Zustand output state.
- [x] The Host manager now creates, edits, duplicates, deletes and Save-and-Connects Telnet cards, including
      replace/remove-password behavior, Terminal/Connection Profile assignment and restored disconnected tabs.
      Telnet sessions share xterm search, copy/paste, encoding, shortcuts and explicit reload behavior while
      correctly omitting the SFTP/file-mode action.
- [x] A real loopback Telnet fixture verifies login/password prompts, IAC negotiation, UTF-8 output, input,
      resize and close. A deterministic pending socket verifies timeout destruction and listener cleanup;
      service and migration tests prove Vault resolution, secret-free metadata, restart persistence and channel
      ownership. Fixed visual/error-state and packaged macOS/Windows/Linux evidence remains, so F-02 is
      Implemented rather than Certified.
- [x] F-03 adds a Serial Bookmark payload with device path, baud/data/stop bits, parity, exclusive lock,
      RTS/CTS, XON/XOFF/XANY, independent TX/RX line-ending policies, terminal encoding and a bounded
      graceful-close sequence/delay. SQLite migration 20, Repository/Unit of Work and generated Contract
      persist the strict payload while keeping terminal bytes outside React/Zustand state.
- [x] ADR-007 records `serialport` 13.0.0 as a Runtime-only native Adapter. `SerialTransport` keeps the
      domain independent of the package; the Node Adapter maps all line settings, bounds enumerated device
      metadata, handles split RX conversions, expands close escapes, drains output before close and removes
      listeners on open cancellation, data error, close and Runtime shutdown.
- [x] The Host manager enumerates current ports with a manual-path fallback and supports Serial card create,
      edit, duplicate, delete and Save-and-Connect. Serial sessions use the existing authenticated Binary
      WebSocket, xterm search/copy/paste/encoding, explicit reload and disconnected layout restoration, while
      terminal file actions stay limited to protocols that implement them.
- [x] Adapter fixtures verify exact settings, TX/RX conversion, close sequence and listener cleanup; the
      maintained `SerialPortMock.binding` performs a real adapter loopback. Service and migration tests prove
      terminal ownership and restart persistence. The copied macOS arm64 `.app`, isolated from checkout and
      system Node, loads the rebuilt Electron ABI 149 binding and enumerates serial devices. Physical-device,
      fixed-visual and Windows/Linux packaged evidence remains, so F-03 is Implemented rather than Certified.
- [x] F-04 adds an RDP Bookmark payload, SQLite migration 21 and generated REST resources for bounded
      RDP session create/list/read/resize/close and the single-use credential bootstrap. Destination, domain,
      local Vault reference, Connection Profile, proxy, SSH jump, timeout, desktop size, scale and clipboard
      settings survive restart while public session metadata remains secret-free.
- [x] ADR-008 pins `ironrdp-wasm` 1.1.0 behind `RdpCanvasAdapter`. The adapter owns the WASM vendor
      session and Canvas input; Runtime owns the RDP lifecycle, exact destination authorization, bounded
      RDCleanPath/X.224/TLS relay and direct/proxy/SSH-forward network route. WebSocket authentication uses
      a consumed exact-URL subprotocol registration; bearer values never enter URLs or persistent UI state.
- [x] The Host manager exposes RDP cards and a create/edit/Save-and-Connect form. Workspace tabs provide
      keyboard, pointer and wheel input, resolution changes, scale-to-viewport, text clipboard sync,
      Ctrl+Alt+Del, split-pane placement, layout restoration and explicit reconnect. Every Runtime session,
      relay, stream, listener, expiry and owned SSH hop has deterministic cleanup and bounded capacity.
- [x] Migration, session ownership, one-time credential, DER framing, pre-network target rejection and
      authenticated WebSocket registry tests pass. The production Renderer build emits the separately loaded
      IronRDP WASM asset and the packaging gate requires it. A live Windows RDP fixture, auth-failure retry,
      fixed visuals and packaged macOS/Windows/Linux journeys remain, so F-04 is Implemented rather than Certified.
- [x] F-05 adds a VNC Bookmark payload, SQLite migration 22 and generated REST resources for bounded
      VNC session create/list/read/close plus a single-use credential bootstrap. Destination, local Vault
      reference, Connection Profile, proxy, SSH jump, timeout, view-only, clipping, scaling, quality,
      compression, shared access, dot cursor and clipboard settings survive restart; public metadata is secret-free.
- [x] ADR-009 pins `@novnc/novnc` 1.7.0 behind `VncCanvasAdapter`. The adapter owns the browser RFB
      object and Canvas input; Runtime fixes the target from the Bookmark and owns the raw RFB relay,
      direct/proxy/SSH-forward route, session cap and reverse-order cleanup. WebSocket authentication uses
      an exact-URL one-shot subprotocol registration, and the transient credential copy is cleared on connect.
- [x] The Host manager exposes VNC cards and a complete create/edit/Save-and-Connect form. Workspace tabs
      provide keyboard/pointer input, Ctrl+Alt+Del, clipboard, live view-only/clip/scale/quality/compression
      controls, explicit server-identity approval, split-pane placement, restoration, duplication and reconnect.
- [x] Migration, session ownership, one-time credential and bidirectional binary-relay tests pass. A production
      Electron journey proves local password persistence without UI disclosure. The production Renderer emits
      an independent noVNC `rfb` chunk and the packaging gate requires it. A live authenticated VNC fixture,
      fixed visuals and packaged macOS/Windows/Linux journeys remain, so F-05 is Implemented rather than Certified.
- [x] F-06 adds a SPICE Bookmark payload, SQLite migration 23 and generated REST resources for bounded
      SPICE session create/list/read/close plus a single-use credential bootstrap. Destination, local Vault
      reference, Connection Profile, proxy, SSH jump, timeout, view-only and scale settings survive restart;
      public session metadata remains secret-free.
- [x] ADR-010 pins `spice-client` 1.2.0 behind `SpiceCanvasAdapter`. The adapter owns the browser Canvas
      and input lifecycle; Runtime fixes the destination and owns direct/custom-proxy/SSH-forward routing,
      an eight-session registry and at most 16 independently cleaned TCP relay channels per session.
      Every exact-URL WebSocket uses `spice.v1` plus the current generation token without putting auth in a URL.
- [x] The Host manager exposes SPICE cards and a complete create/edit/Save-and-Connect form. Workspace tabs
      provide pointer/keyboard input, view-only, viewport scaling, Ctrl+Alt+Del, split-pane placement, restored
      disconnected state, duplication and explicit reconnect. The claimed ticket stays outside React/Query/
      Zustand/storage/logs and is overwritten after the bounded child-channel setup window.
- [x] Migration, Profile override, one-time credential, multi-channel ownership, bidirectional binary relay and
      bounded exact-URL WebSocket tests pass. A production Electron journey proves local ticket persistence
      without UI disclosure. The production Renderer emits an independent `spice-client` chunk and the packaging
      gate requires it. A live SPICE fixture, fixed visuals and packaged macOS/Windows/Linux journeys remain,
      so F-06 is Implemented rather than Certified.
- [x] F-07 adds Web Bookmark metadata, SQLite migration 24 and generated Runtime resources for
      create/list/read/presentation/action/authentication/close. ADR-011 assigns native `WebContentsView` ownership
      to Desktop Host while Runtime owns the eight-session registry; Renderer receives no Electron object or Host token.
- [x] Web views preserve sandbox, context isolation and web security, reject URL credentials, permissions, downloads,
      unsafe navigation and implicit popups, and expose explicit validated external-open actions. HTTP Basic responses
      are challenge-bound, expire after two minutes and are never stored. Window/generation/Host/session cleanup removes
      views, callbacks and timers; inactive pane geometry is hidden.
- [x] Host cards and forms persist URL, optional User-Agent and address-bar visibility. Workspace tabs provide
      back/forward/reload/stop, address copy, zoom, popup feedback, transient authentication, split placement, restore,
      duplication and reload. Migration/Application/native-controller tests pass, and a production Electron loopback
      journey proves custom User-Agent, page content and child-WebContents cleanup. Fixed state visuals and packaged
      three-platform journeys remain, so F-07 is Implemented rather than Certified.

- [x] F-08 adds ADR-012's Desktop deep-link ingress without broadening Renderer/Main IPC. Packaged
      metadata registers `axterm`, compatible `electerm`, SSH and auxiliary session schemes but never
      HTTP/HTTPS. Main acquires the single-instance lock, restores/focuses the active window and accepts
      bounded links from startup argv, macOS `open-url` and second-instance command lines.
- [x] A fresh 32-byte token in the existing startup envelope authenticates Main to one exact Runtime
      generation. Runtime parses links with the shared bounded Quick Connect parser, stores at most 32
      two-minute memory-only intents and publishes only a secret-free availability event. Receipt, rejection,
      logging and business SQLite never contain the source or temporary credential.
- [x] Renderer claims one intent through normal authenticated REST, sends SSH through the existing temporary
      Quick Connect path and opens the matching FTP/Telnet/Serial/RDP/VNC/SPICE/Web form for explicit review.
      Every supported form receives validated protocol fields; closing it clears the temporary input. The
      initial check completes before the default local terminal is created, so a startup link cannot be hidden.
- [x] Parser, intent-service, bridge and Runtime HTTP tests cover encoded fields, malformed input, FIFO, expiry,
      capacity, stale generation/secret rejection and one-time claim. A production Electron test covers startup
      argv plus the real Main `open-url` and `second-instance` handlers and verifies temporary credentials stay
      outside browser storage. Installed protocol activation, fixed visuals and Windows/Linux package evidence
      remain, so F-08 is Implemented rather than Certified.
- [x] C-16 adds ADR-013's Runtime-owned ZMODEM, XMODEM and trzsz protocol boundary. The
      `TerminalService` remains the sole terminal-byte owner and calls a narrow interceptor before
      replay, recording or Renderer broadcast; protocol bytes therefore stay out of React/Zustand,
      terminal history and session logs. Exact `zmodem2` 1.4.0 and `trzsz2` 1.2.0 pure-JavaScript
      engines plus the adapted Electerm XMODEM state machine remain behind a Runtime Adapter.
- [x] ZMODEM and trzsz detect split protocol headers automatically. XMODEM send/receive appears in
      the terminal context menu. Automatic selection, explicit starts and cancellation use generated
      REST actions and Desktop File Grants; only grant IDs and safe file metadata cross the public
      Contract, while local paths remain inside Desktop Host/Runtime. Binary WS text controls carry
      a strict path-free progress state and terminal bytes remain binary frames.
- [x] A terminal owns at most one active protocol transfer. Selection waits expire after 60 seconds
      and consume at most 4 MiB; protocol engines cap their own pending buffers and streams. Received
      files write to uniquely named `.part` files and commit only after stream completion; cancel,
      error, terminal close and Runtime shutdown destroy protocol managers, timers, streams and partials.
- [x] A real in-process XMODEM sender/receiver fixture transfers binary data through bounded packets.
      Adapter fixtures cover chunked ZMODEM/trzsz detection; Application tests cover progress, cancel,
      memory rejection, exact grant validation, cleanup and absence of local paths in replay/control
      state. The Phase 17 corpus now captures all seven protocol forms at three fixed viewports; their
      ranges are FTP 96.342%–97.152%, Telnet 96.146%–97.319%, Serial 96.553%–97.513%, RDP
      96.413%–96.831%, VNC 96.602%–97.501%, SPICE 96.236%–97.144% and Web/Deep Link
      95.642%–97.341%. Entering a protocol keeps the Electerm-style bookmark directory and protocol
      context visible behind the focused form; close/save returns to the main workspace and
      Save-and-Connect opens the real session. A separate 97.933%–98.935% scene streams a 256 KiB file into a generation-bound
      File Grant, starts the actual Runtime XMODEM engine and uses the local PTY as its CRC peer so the
      visible progress/cancel state is real. Live `rz`/`sz`/`trz`/`tsz`, connected/failure visuals and
      packaged Windows/Linux evidence remain, so C-16 is Implemented rather than Certified. Phase 18
      continues below.
- [x] G-01 replaces the flat Quick Command list with a Runtime-owned ordered aggregate. SQLite
      migration 25 adds nested folders, command placement and an independent tree revision; every
      create, update, delete and drag move checks the tree ETag, commits content plus a safe Domain
      Event in one transaction, reindexes siblings and rejects cycles or stale clients. Folder deletion
      promotes its direct children. The aggregate is limited to 5,000 nodes, 32 steps per command and
      128 KiB of command text.
- [x] The Renderer now provides the Electerm Quick Command editor behavior through Axterm's generated
      REST client: recursive search over names, descriptions, labels and step text; folder and command
      CRUD; tree/step drag ordering; duplicate; shortcut/input-only fields; frequency count; multi-line
      commands; and visible `clipboard`, `date` and `time` templates. Templates remain stored as source
      text and expand only after an explicit Insert action; line endings are flattened to one `&&`
      input line so no command executes before the user presses Enter.
- [x] Electerm data import/export now retains legacy one-command records and the current multi-command,
      labels, shortcut, input-only and frequency fields. Application/repository/migration and Renderer
      model tests cover stale ETags, cycle rejection, promotion, legacy migration, ancestor search,
      template expansion and drop zones. A production Electron journey creates two steps, creates and
      drags into a folder, searches, duplicates, closes the app and verifies the nested SQLite snapshot.
      The shared Quick Command/Batch three-viewport scene passes at 95.089%–97.253%; packaged
      Windows/Linux evidence remains, so G-01 is Implemented rather than Certified.
- [x] G-02 adds Electerm-compatible per-Bookmark Quick Commands without merging their lifecycle
      into the global aggregate. SQLite migration 26 persists up to 64 local `{name, command}` entries;
      create, update, duplicate, reopen and Electerm import/export retain their order. Persistent events
      contain only the count, so command bodies do not enter the replay log.
- [x] The SSH Bookmark editor's Quick commands tab now provides add, edit, remove and keyboard-friendly
      ordering. The terminal footer merges the active Bookmark's local list ahead of global commands,
      searches both sources and offers explicit Insert and Send controls. Insert converts expanded
      multi-line content into one `&&` line without Enter; Send preserves step delays, honors input-only,
      can be canceled and uses the existing active Terminal Binary WS writer. Clipboard denial and
      disconnected terminals return visible feedback. Migration/reopen, event redaction, Electerm
      round-trip and a production Electron/node-pty insert/send journey pass. The shared Quick
      Command/Batch visual passes at 95.089%–97.253%; packaged Windows/Linux evidence remains, so G-02
      is Implemented rather than Certified.
- [x] G-03 adds the Electerm Batch Input footer surface for connected local, SSH, Telnet and
      Serial terminals. It defaults to the active terminal, removes closed or unsupported targets, keeps
      at least one selection, and offers per-target selection, Select all and Current only. Enter sends the
      bounded 16 KiB draft plus one carriage return to each target; Shift+Enter stays in the editor.
- [x] Batch writes use a focus-free Terminal handle backed by each session's existing Binary WebSocket
      sender, so hidden terminals receive the same bytes without changing the active tab. The panel has
      outside/Escape dismissal, partial-send feedback and a duplicate-free 50-command run-local history;
      the history resets on Renderer restart to honor the default no-terminal-history policy. Pure model
      tests cover eligibility, cleanup and order. A production Electron test proves all/current routing
      across two real node-pty shells, focus preservation and dismissal without send. The shared Quick
      Command/Batch visual passes at 95.089%–97.253%; packaged Windows/Linux evidence remains, so G-03
      is Implemented rather than Certified.
- [x] G-04 adds a Runtime-owned Batch Operation aggregate and Commands workspace. Users can search
      and select 1–64 SSH Bookmarks, edit and reorder 1–32 command steps, choose concurrency 1–8,
      set bounded step delays and opt into continue-on-error. The results pane retains aggregate
      counters and expandable per-target/per-step state, timestamps, exit codes and stable errors.
- [x] SQLite migration 27 persists task summaries. Creation requires an idempotency key; Runtime
      allows at most four active operations, owns a separate SSH connection per target and closes it
      in `finally`. Cancel aborts connection, wait, delay and exec work, marks remaining items canceled
      and never replays them. Reopening the database converts queued/running/canceling work to
      interrupted. Command text, stdout/stderr and credentials are excluded from histories and Domain
      Events; captured output is bounded to 128 KiB and discarded after exit status is recorded.
- [x] Application tests prove ordered multi-target execution, a concurrency ceiling of two, cancel,
      restart recovery and event redaction. A production Electron journey runs a command through
      three real SSH connections at concurrency two, checks all target results in the UI, waits for
      connection cleanup, reopens SQLite and verifies persisted success plus command-body redaction.
      The shared Quick Command/Batch three-viewport scene passes at 95.089%–97.253%; packaged
      Windows/Linux evidence remains, so G-04 is Implemented rather than Certified.
- [x] G-05 adds a Runtime-owned streaming Trigger engine and a revisioned global Trigger aggregate.
      SQLite migration 28 stores up to 256 global rules and up to 32 ordered rules on each Bookmark;
      global CRUD/atomic JSON replacement uses ETag checks, while Bookmark updates remain part of the
      Bookmark tree transaction. Electerm import/export retains Bookmark rules with new Axterm UUIDs.
- [x] The engine strips ANSI/OSC/CSI sequences across chunk boundaries, normalizes CR/CRLF, keeps a
      bounded 64 KiB matching window and supports text/regex, case sensitivity, repeat/once/cooldown,
      notification, explicit text send, Enter and control-character notation. Unsafe regex constructs
      are rejected. A session combines global rules with only its bound Bookmark rules; actions use the
      existing Terminal Application Service and never obtain an ssh2/PTY vendor handle.
- [x] Commands now includes the global Triggers Beta library with presets, enable/duplicate/edit/delete
      and atomic JSON import. The six-tab SSH Bookmark form enables its Triggers editor with ordered
      local rules and presets. Runtime caps firing at 1,000 actions per terminal, keeps output/action text
      out of Domain Events and cleans decoders/engines on terminal close or Runtime shutdown. Unit tests
      prove split escape sequences, cooldown/once/disable, regex rejection, replacement atomicity,
      Bookmark isolation and cleanup; a production Electron/node-pty journey proves persistence and a
      real streamed-output response. The Trigger three-viewport scene passes at 95.092%–97.147%;
      packaged Windows/Linux evidence remains, so G-05 is Implemented rather than Certified.
- [x] G-06 extends each SSH Bookmark login/run step with an explicit Enter/raw send mode, fixed-delay or
      output-idle continuation, a quiet window and a bounded timeout. Runtime waits for Shell Integration,
      then applies the merged environment, login steps, startup directory and run steps in that order.
      Startup replacement, terminal close and Runtime shutdown abort pending waits and never replay steps.
- [x] Input arriving from the user, Quick Commands or Triggers while startup is active remains in the
      existing bounded Terminal queue and is released in arrival order after the last startup step. This
      prevents an immediately opened Binary WebSocket from overtaking initialization. Unit tests prove
      ordering, delay, output-activity reset, queued user input, close cancellation and cleanup. Contract
      and migration tests prove old stored script JSON receives safe defaults; the production Electron
      editor persists all wait/send controls, and the Docker OpenSSH fixture proves the real environment →
      login → directory → run result together with immediate client input and X11. The shared Trigger/script
      three-viewport scene passes at 95.092%–97.147%; packaged Windows/Linux evidence remains, so G-06
      is Implemented rather than Certified.
- [x] G-07 adds a typed, read-only Terminal Information snapshot and a session side panel. SSH sessions
      report system, uptime, CPU/history, memory, users, network rates, disks and redacted activities;
      local sessions expose system facts and explicitly mark remote-only groups unsupported. Every group
      reports `ready`, `stale`, `unsupported` or `error`, so a refresh failure can retain the last safe
      value without presenting it as current.
- [x] Runtime reuses the ready SSH connection and only executes its own fixed commands. It limits command
      output to 64 KiB, timeout to five seconds and concurrency to two; caches are bounded to 64 live
      sessions, CPU history to 60 points and result lists to fixed sizes. Per-group TTLs and in-flight
      de-duplication share polling work. Renderer polls only while the panel is visible and the SSH session
      is ready; terminal close and Runtime shutdown clear owned state. Parser/cache tests, the real Linux
      Docker OpenSSH fixture and production Electron B-12 panel journey pass. The Terminal Information/
      Monitor three-viewport scene passes at 96.724%–98.460%; packaged Windows/Linux evidence remains,
      so G-07 is Implemented rather than Certified.
- [x] G-08 adds Electerm's default-off, SSH-only 28 px remote monitor row between the terminal and
      footer. Its nine ordered items show hostname, CPU, CPU history, memory, upload/download rates,
      uptime, users and disks. Hover or keyboard focus opens details, click pins them, Escape closes them,
      and warning/critical colors expose CPU, memory and disk pressure. Details cover system identity,
      current/average/min/max CPU, memory/swap plus top processes, interfaces, user sessions and disks.
- [x] Monitor enabled state, item order and G-07 information groups persist through the Runtime Settings
      aggregate with safe defaults for older profiles. The bar and full panel share one TanStack Query key
      and Runtime sample cache; only the visible ready SSH surface polls, and hiding, switching surfaces,
      opening full information or disconnecting stops it. Pure threshold/format tests, repository restart,
      real Docker sampling and production Electron settings, 28 px geometry, details, navigation and SQLite
      checks pass. The shared Terminal Information/Monitor visual passes at 96.724%–98.460%; packaged
      Windows/Linux evidence remains, so G-08 is Implemented rather than Certified.
- [x] G-09 adds a Runtime-owned built-in Widget catalog and an eight-instance generation-bound registry.
      The Electerm-style Widgets/Running instances surface provides search, real type-specific forms,
      running counts, inline rename, safe hover details, URL copy/open, confirmed stop and ten-second
      detailed notices. Shutdown closes every instance, and a fresh Runtime generation exposes no stale
      running state.
- [x] File Renamer retains Electerm's number/name/extension/date/time/random/parent templates while adding
      a two-minute exact preview, source-version and conflict checks, required idempotency, 1,000-file and
      32-level traversal bounds, symlink skipping, two-stage temporary rename and best-effort rollback.
      Renderer sees only grant-relative labels and reviewed results. Application and real Runtime tests plus
      a production Electron preview/execute/restart journey pass.
- [x] G-10 implements a streaming Static File Server behind a generation-bound Desktop Directory Grant.
      Its form exposes bind/port/cache/header/index/redirect/dotfile/range controls, defaults to loopback
      and port 0, supports GET/HEAD and byte ranges, validates lexical plus real paths, caps sockets and
      timeouts, and destroys clients before close. Adapter and production Electron tests prove headers,
      traversal rejection, live fetch and process cleanup.
- [x] G-11 implements authenticated FTP and SSH/SFTP Server Widgets. FTP wraps Electerm's pinned MIT
      `@electerm/ftp-srv` 1.0.5 with a confined FileSystem, passive-port/connection bounds and anonymous or
      transient-password authentication. SSH reuses ssh2/node-pty with an ephemeral Ed25519 host key,
      transient-password authentication, PTY shell, exec and bounded read/write SFTP. Both default to
      loopback/port 0, require a read/write Directory Grant and deterministically release clients, PTYs,
      processes, handles, streams and listeners. Passwords never enter responses, URLs, notices, events,
      SQLite or browser storage. Real basic-ftp, ssh2 and production Electron tests pass. The Static File
      Server Widget form now has a matched three-viewport Electerm/Axterm scene at 95.623%–97.233%;
      remaining Widget states and packaged Windows/Linux evidence keep G-09 through G-11 Implemented.
- [x] G-12 adds one bounded command-line parser shared by the root launcher and packaged Electron Main.
      It accepts Electerm-compatible connection flags, typed opts, direct protocol URLs, quoted values,
      local working directories, transient passwords/private keys/passphrases, SSH environment,
      SFTP-only, Batch Operation and `--new-window`. Startup and second-instance requests use the existing
      private generation-authenticated deep-link ingress; Main turns every local path into an opaque
      generation-bound File Grant, and no business IPC or absolute Renderer path is introduced.
- [x] Native Batch Operation JSON executes through the existing idempotent Application Service. A bounded
      command-only Electerm workflow can map its connect step to an existing SSH Bookmark; inline secrets
      are discarded in favor of the application-local saved credential. Electerm SFTP batch steps require
      the separate file-grant workflow, and fixed `--server-port` is rejected because Runtime remains on
      loopback with an OS-assigned port. Parser/translation/grant tests and a production Electron journey
      prove quoted cwd/title, single/second-instance routing, new windows, typed Telnet options, transient
      secret browser-storage exclusion and batch-action dispatch. The manifest marks CLI dispatch as
      non-visual; packaged Windows/Linux invocation evidence remains, so G-12 is Implemented rather than
      Certified. Phase 19 begins at H-01.

### Phase 19 — Settings / Themes / Sync / Localization

- [x] H-01 provides the six Electerm settings categories—Common, Terminal, Shortcuts, Setting sync,
      AI and Password—in a searchable, keyboard-navigable workspace. Arrow navigation wraps, Home/End
      jumps and an explicit empty state appears for unmatched searches. Password shows only application-
      local Vault type/label/time metadata and never exposes secret values.
- [x] The Common privacy control persists `privacy.hideAddresses`, backfills older settings to false and
      applies Electerm-compatible IPv4/hostname masks to host cards, the new-session list and connection
      history while Runtime keeps the canonical destination. Schema/repository/navigation/mask tests and a
      production Electron search, keyboard, Vault-empty, persistence and masked-address journey pass.
      Fixed visuals and packaged Windows/Linux evidence remain, so H-01 is Implemented rather than
      Certified. At the H-01 checkpoint, 23 of the 72 mapped settings remained Missing.
- [x] H-02 pins all 72 `default-setting.js` keys in `tests/parity/electerm-settings-map.json` and
      makes the generated parity audit fail on missing, duplicate or stale upstream keys. The current
      `test-results/parity-audit.json` reports zero unmapped and zero Missing settings while retaining
      22 open settings as explicit Partial work. Cross-platform packaged release evidence remains, so
      H-02 is Implemented rather than Certified.
- [x] The final seven Missing defaults now have concrete owners and behavior. Ordinary cold startup
      ignores the previous tab/connection layout and creates one fresh local terminal; migration 33
      clears legacy automatic restore/startup defaults while retaining named workspaces.
      `workspace.startupSessions` explicitly opens up to 20 selected Bookmarks or one named workspace;
      Electerm's short Bookmark IDs are remapped during transactional import. `network.proxy.mode`
      represents `enableGlobalProxy`; `fileManager.externalEditor` is validated by Desktop Host and
      launched with the granted temp file as one non-shell argument. File Settings also persist refresh-
      on-open, terminal-cwd follow and SSH split-view defaults, while `terminal.screenReaderMode` updates
      current and future xterm sessions. Contract, SQLite, migration, Host and service tests plus three
      production Electron settings/startup journeys pass. The 72-key map is now 50 Implemented,
      22 Partial and 0 Missing.
- [x] H-03 adds migration 29 and a Runtime-owned Terminal Theme resource with immutable Electerm dark/
      light defaults and ETag-guarded custom rows. The Electerm-aligned workspace supports list/search,
      current/new state, terminal/ANSI/UI preview, all 33 color roles, create, clone, edit and two-step
      delete. Import/export use bounded `key=value` parsing plus Desktop File Grants and atomic writes;
      Renderer receives no absolute path. Repository restart, stale update, parser and file round-trip
      tests plus a production Electron end-to-end workflow pass. Fixed visuals and packaged platform
      evidence remain, so H-03 is Implemented.
- [x] H-04/C-10 persist one typed terminal visual policy with global and current-session scopes. The
      theme editor previews palette, text/image background and opacity/blur/brightness/grayscale/
      contrast changes directly in the live xterm, then applies through Workspace state or an
      ETag-guarded Runtime Settings write. Background images use Desktop File Grants; Runtime validates
      PNG/JPEG/GIF/WebP headers, caps input at 16 MiB, copies in 64 KiB chunks to private app-local
      storage and exposes only authenticated streaming content. Renderer retains no local path and
      revokes every Blob URL. Contract defaults/validation, SQLite restart, asset import/delete and a
      production Electron live-preview/session/global/restart journey pass. Fixed screenshots and
      packaged Windows/Linux evidence remain, so H-04/C-10 are Implemented. At the H-04 checkpoint,
      the settings audit had 13 Missing keys.
- [x] H-05 maps all 23 pinned Electerm actions into one typed Registry with macOS and
      Windows/Linux defaults, physical-key and modifier normalization, keyboard/wheel capture,
      two editable combinations and protected read-only copy/paste/middle-click behavior. The
      editor detects collisions with effective built-in actions, Quick Commands and reserved
      Axterm navigation before it writes a sparse, ETag-guarded Runtime Settings override.
- [x] The shared dispatcher replaces the old hard-coded new/close/tab-switch paths and applies
      reload current/all, clone to pane, duplicate, new bookmark/session, full screen, window zoom,
      previous/next tab, terminal clear/copy/paste/search/selection/normal-buffer/font zoom and SFTP
      cwd following. Normal-buffer capture is capped at 2,000 lines and 256 KiB; terminal font size
      remains within 8–72 px. Contract/conflict/platform tests, SQLite generation restart and a
      production Electron edit/conflict/dispatch/middle-click/font/restart/reset journey pass.
      Fixed visual and packaged Windows/Linux modifier/clipboard evidence remains, so H-05 is
      Implemented rather than Certified.
- [x] H-06 adds Electerm's default `Control+2` application visibility accelerator to the
      application-local Desktop window preferences and exposes its registration state through
      the existing Host REST boundary. Electron Main registers after readiness, toggles focused
      windows to minimized and restores/shows/focuses hidden windows, replaces an accelerator
      without dropping the prior working registration on conflict and unregisters on shutdown.
- [x] The Shortcuts surface captures and formats the global chord, checks it against built-in
      actions, Quick Commands and reserved navigation, and supports apply, disable and default.
      Controller lifecycle, Host 409/persistence, Contract and production Electron default/change/
      restart/conflict/disable tests pass on macOS arm64. Packaged Windows/Linux and physical OS
      accelerator evidence remain, so H-06 is Implemented rather than Certified. The settings
      audit had 12 Missing keys at the H-06 checkpoint.
- [x] H-07 extends the application-local window document with exit confirmation and multi-instance
      policy. Electron Main reads the policy before acquiring the single-instance lock; changing it
      or title-bar mode reports restart-required, while opacity and zoom apply live. The native close
      guard serializes repeated requests, keeps canceled windows and allows one approved close.
- [x] Bounds persistence keeps the 1440×900 first-launch default, throttles and flushes normal
      move/resize state, ignores maximized/fullscreen geometry and corrects saved rectangles across
      primary, right, left and upper work areas or centers a disconnected display. Store/schema/guard/
      geometry tests and a production Electron live-apply, restart restore, simultaneous-instance and
      cancel/confirm journey pass on macOS arm64. Fixed visuals and packaged three-platform evidence
      remain, so H-07 is Implemented rather than Certified. At the H-07 checkpoint the settings audit
      had 10 Missing keys; Phase 19 continued at H-08 data import/export and later reduced that count
      to zero.
- [x] H-08 extends the bounded Electerm product-data flow to a version 2 portable format. Export
      includes Runtime settings, application-local window preferences and Vault metadata limited to
      kind, label and timestamps; credential refs and values are omitted. Preview compares supported
      fields, lists device-bound omissions and reports credential metadata without creating empty
      secrets. Axterm-exported entity IDs resolve to their current targets during re-import, so a
      round trip does not duplicate bookmarks, groups, profiles or Quick Commands.
- [x] Commit rechecks the Settings ETag and full Desktop preference snapshot, writes database-backed
      entities and settings in one transaction, and restores any already-applied Desktop preference
      patch if the transaction fails. Secret-like metadata fields are rejected. Contract/Application
      tests cover settings round trip, stale version compensation, redaction and unsafe metadata; the
      production Electron journey uses native File Grants, changes Runtime/window state, restores both,
      preserves Vault files byte for byte and proves grant cancellation/revocation. Fixed report visuals
      and packaged Windows/Linux native-dialog evidence remain, so H-08 is Implemented.
- [x] H-09 adds migration 30 and a Runtime-owned synchronization domain. One versioned profile per
      provider stores the eight selected data categories, auto interval/direction, last result, opaque
      remote revision and recoverable review state; public resources expose only credential-configured
      booleans. Settings, Bookmarks, Terminal Themes, Quick Commands, Profiles, file address Bookmarks,
      named workspaces and Triggers use their existing Application/Repository boundaries and content hashes.
- [x] Manual compare/upload/download, cancellation and automatic scheduling share one bounded path. An
      automatic or manual download creates a ten-minute preview that Renderer can reopen and must confirm;
      it is invalidated on Runtime generation change. Optional AES-256-GCM+scrypt encryption resolves its
      password from the application-local Vault for one operation and zeroes the derived key afterward.
- [x] H-10 implements GitHub/Gitee Gist, WebDAV and Electerm-compatible custom-server adapters. Access
      credentials remain in HTTP headers, endpoints cannot contain embedded credentials/query/fragment,
      responses cap at 24 MiB, and ETag/content revisions reject stale writes. Provider auth/offline errors
      return stable redacted codes. Repository/service/provider tests, a real loopback WebDAV integration,
      an eight-category two-database round trip and a production Electron Vault/compare/upload/conflict/
      download/commit/delete journey pass. Fixed sync/provider visuals, live opt-in GitHub/Gitee/custom
      evidence and packaged Windows/Linux evidence remain, so H-09/H-10 are Implemented. At that
      checkpoint the settings inventory had 9 Missing keys; H-11 and the default-behavior backfill
      below reduce the current count to zero.
- [x] H-11 has a reproducible generated snapshot of `@electerm/electerm-locales@2.3.16`: 15 locale
      IDs with the same 410 ordered keys and English fallback. The Contract accepts every canonical
      language ID; Runtime Settings remains the persisted source and the Renderer query provider changes
      `html.lang`, `dir` and visible translated surfaces without a restart. Arabic uses RTL, interpolation
      returns inert React text, and unknown browser languages fall back to English.
- [x] Common now exposes all 15 native language names. The activity rail, application orchestrator,
      complete Shell controls, Settings shell and every terminal component/model use the translator.
      Terminal search/clipboard/drop/paste/reconnect/capability/input/OSC 52 models return stable codes
      and the live view translates them without recreating its socket. Data sync, Electerm migration,
      proxy, command history, bookmark tree/triggers, remote file/editor/desktop, shortcut and terminal
      recovery surfaces also use catalog text. Host/protocol forms, bookmark tunnels/startup/hops,
      file management, transfer conflicts and permission editing are cataloged as well. Non-SSH Quick Connect now enters
      the implemented protocol-prefill flow instead of exposing the stale Phase 17 placeholder.
- [x] `locales:audit` performs an exact TypeScript-AST inventory of CJK string/template/JSX literals
      outside `renderer/src/i18n`; the reviewed baseline fell from 2,495 to 0. Pure localization and
      terminal tests, SQLite reopen coverage, seven production Electron terminal flows, six Shell/
      workspace/deep-link flows and the zh-CN→English→restart→Arabic journey pass. The baseline is an
      executable regression gate for future uncataloged copy.
- [x] `settings.localization-ltr` and `settings.localization-rtl` now drive both pinned Electerm and
      Axterm at 1280×800, 1440×900 and 1920×1080 on macOS arm64. Twelve screenshots, twelve
      viewport traces and geometry metadata are committed below `tests/parity/screenshots`; visual
      review also fixed RTL tab/close overlap, bounded long diagnostic labels and stabilized the
      physical settings chrome while retaining RTL content direction.
- [x] The H-11 source-capture comparison passes all six scenes at 96.660%–97.143% similarity. Each
      Axterm record evaluates and passes the seven hard-defect checks for overlap, clipping, primary
      control contrast, viewport bounds, LTR/RTL direction, keyboard focus and persisted language
      selection. A copied macOS arm64 package under restricted PATH now also passes immediate English
      switching, cold-restart persistence, Arabic RTL and physical-left activity-rail checks; reviewed
      screenshots are `tests/parity/screenshots/axterm/packaged/{localization-en,localization-ar}.png`.
      Packaged Windows/Linux localization evidence remains, so H-11 is Partial and Phase 19 acceptance
      remains open.
- [x] H-12 now has a configured-provider implementation while preserving the default disabled state.
      Desktop Host validates a strict bounded manifest, same-origin HTTPS URLs, an Ed25519 signature,
      exact artifact size and SHA-256; it streams into a private `.part` file, publishes progress,
      supports cancellation, atomically renames, rehashes before installation and never returns update
      URLs or paths to Runtime/Renderer. The Runtime exposes two typed REST operations and the Settings
      Common page provides check, download, progress, cancel and installer actions. Unit tests cover
      disabled/partial configuration, signature/hash/tamper failures and cleanup; Host/Runtime integration
      proves generation-token confinement. A production Electron journey drives cancel, retry and
      intercepted OS installer handoff against a real signed loopback feed and retains
      `test-results/phase21-h12-updater-ready.png` at 1440×900. H-12 remains Partial until an official
      HTTPS feed, production signing identity and installed binary-to-binary runs exist on all platforms.

### Phase 20 — AI / MCP Parity

- [x] I-01 extends the versioned Provider Contract and workspace with endpoint, API path, protocol,
      authentication header, model, system role, timeout and authenticated HTTP(S)/SOCKS proxy
      configuration. API keys and proxy passwords are created and resolved only through the
      application-local Host Vault; business resources retain opaque `credentialRef` values and
      Provider results or errors never include response bodies or credentials. Enabled Providers have
      a bounded connection test and model discovery action.
- [x] I-02 implements OpenAI Chat Completions, OpenAI Responses and Anthropic Messages request and
      streaming formats in one Runtime Adapter. It normalizes fragmented text, usage, completion and
      tool-call deltas, caps model/stream responses, combines timeout and user cancellation, and closes
      readers/sockets on every exit. Direct and authenticated proxy fixtures cover all three formats,
      fragmented tool calls and stable Provider rejection errors.
- [x] I-03 adds migration 31 and versioned conversation/message resources. Creating a message and AI
      Run is transactional; terminal run states persist the assistant result, failure or cancellation
      and advance conversation activity. The chat workspace mirrors Electerm's new/history/session
      flow with selectable sessions, message count/time, Enter-to-send, explicit cancellation and an
      inline destructive confirmation. Continuation uses at most 64 KiB of redacted prior conversation
      context, and hidden provider reasoning is neither exposed nor stored.
- [x] Contract and real Runtime tests cover legacy Provider defaults, unsafe endpoint rejection, local
      Vault resolution, model discovery, all stream formats, proxy routing, two-turn continuation,
      Runtime restart, canceled-message recovery and conversation deletion. The AI-focused suite has
      14 passing tests at that checkpoint; OpenAPI/generated Client now contains 252 operations, localization audit remains
      at zero direct Renderer CJK literals, and parity audit reports 0 unimplemented settings and no
      unmapped entries. The Provider configuration surface now uses the Electerm-style standalone
      modal and passes its paired three-viewport comparisons at 95.340%–95.868%; chat/context passes
      at 97.008%–98.452%. Packaged platform evidence remains, so I-01/I-02/I-03 are Implemented.
- [x] I-04 connects the existing selection-aware terminal context menu to a persisted Explain Output
      conversation. It normalizes the selected text, retains only the recent 16,000 characters, lets
      Runtime redact it, renders the exact sent content in chat and opens the full AI workspace. Unit
      tests cover line endings and oversize truncation; the production Electron fixture selects real
      xterm output, invokes the menu, verifies the visible user/assistant messages and checks the local
      Provider request and application-local Vault authorization. The shared chat/context scene passes
      at 97.008%–98.452%. I-04 is Implemented; selection-specific and packaged evidence remains.
- [x] I-05 retains the bounded terminal suggestion path and adds an explicit Generate command or script
      review flow. Fenced or plain code can be copied, while terminal insertion removes comment-only
      lines, preserves script indentation, rejects empty/oversized content and never appends Enter.
      Unit tests cover extraction, 64 KiB copy/16 KiB insertion limits and the existing 32-entry AI
      suggestion cache. The shared I-04/I-05 production Electron fixture selects the configured model,
      copies a generated script, inserts it into the active PTY and proves its filesystem effect never
      occurs without a separate user execution. The shared chat/context scene passes at
      97.008%–98.452%. I-05 is Implemented; generated-code-specific and packaged evidence remains.
- [x] I-06 replaces the former placeholder action with a two-step AI bookmark dialog. Runtime accepts
      only the strict eight-field `AiBookmarkDraft`, normalizes optional JSON fencing and rejects any
      extra field, including passwords, private keys, passphrases, tokens or credential references.
      Invalid raw model output is never persisted. Renderer validates the normalized result again,
      exposes name/title/host/port/user/auth/group/description/favorite for review, and saves the Host
      and Bookmark only on an explicit action against the latest tree ETag. Saved records always carry
      null credential references so first connection uses the existing one-time/application-local Vault
      flow. Parser tests, a real Runtime/Provider/Vault test and the production Electron generate→edit→save
      journey pass; `test-results/phase20-ai-bookmark-review.png` captures the 1440×900 review state.
      The journey also exposed and fixed the full-window Bookmark editor header intercepting clicks over
      its AI action. I-06 is Implemented; paired fixed visual and packaged evidence remains.
- [x] I-07 adds `createTheme` as a structured AI use case and integrates it with the existing Terminal
      Theme workspace. The exact name/21 terminal-color/12 UI-color shape is checked on both sides of
      the REST boundary; terminal foreground/background and UI text/main must each meet a 4.5:1
      contrast ratio. Runtime stores only a normalized valid palette and drops malformed, extra-field
      or low-contrast partial output. The generated palette is visibly marked unsaved, renders in the
      existing terminal/ANSI preview, remains fully editable, can be discarded to restore the previous
      draft, and enters the Theme Repository only after explicit Save. Unit and real Runtime/Vault tests
      cover schema/contrast failures; the production Electron journey proves generate→preview→discard→
      regenerate→edit→save and records `test-results/phase20-ai-theme-preview.png` at 1440×900. I-07 is
      Implemented; paired fixed visual and packaged evidence remains.
- [x] I-08 replaces the incomplete approval list with Electerm-aligned Agent Tool Cards. Each card
      exposes the exact arguments/hash, target, risk, state, approval deadline and bounded result;
      read-only tools run directly, while `terminal.exec` requires one exact, unexpired approval and
      remains visibly pending until that decision. Rejection, expiry, replay, cancellation and Runtime
      interruption close the persisted Tool Call/Run without allowing a late success to overwrite the
      outcome. The terminal command path now waits for shell startup, injects only the reviewed bytes
      and recovers deterministically from a timed-out shell-integration probe. Lifecycle and real-PTY
      tests pass; the production Electron journey proves read-only output, rejected/no-effect and
      approved/real-effect commands, plus storage redaction. It records
      `test-results/phase20-agent-tool-card.png` at 1440×900 with no clipped or overlapping controls.
      The paired Agent state passes at 95.926%–98.134%. I-08 is Implemented; long-run/package evidence remains.
- [x] I-09 implements the pinned text-attachment flow through generation-bound Host File Grants.
      Runtime reads at most 50 KiB per file, rejects binary or more than 100 KiB total source data,
      handles UTF-8 truncation without broken code points, redacts before preview/provider use and
      revokes the grant immediately. Drafts expire after 15 minutes, are capacity limited and can be
      canceled or removed; Send consumes them once. Conversation history stores only safe metadata,
      so attachment bodies and grant/draft IDs never enter SQLite or browser storage, and later turns
      do not resend old files implicitly. Contract, Host Adapter, Application and real Runtime tests
      cover type/size/grant/redaction/cancel/expiry/restart. Production Electron proves native select,
      remove, preview, explicit send and restored history, and records
      `test-results/phase20-ai-attachment-preview.png` at 1440×900. OpenAPI/generated Client now has
      255 operations after I-10 and the signed Host updater actions. I-09 is Implemented;
      paired/package evidence remains.
- [x] I-10 adds an Electerm-aligned MCP Server to the built-in Widget workspace. The configuration
      exposes only loopback hosts, fixed or automatic port selection, a generated/user Bearer key and
      an exact checkbox-selected subset of the ten Runtime Tool Registry entries. The key is created in
      the application-local encrypted Host Vault, never enters the endpoint URL, browser storage,
      business database or logs, and is deleted when its volatile Runtime-owned instance stops.
- [x] The Runtime Adapter implements bounded stateful Streamable HTTP: authenticated initialize and
      protocol negotiation for the pinned versions, initialized notification, ping, `tools/list`,
      `tools/call`, GET/SSE and DELETE. It rejects non-loopback browser Origin values and mismatched
      sessions/protocols, caps request bodies, sockets and sessions, expires idle sessions and closes
      HTTP sockets/SSE streams on stop. Widget instance polling shows the endpoint, selected tool count,
      active sessions and protocol without exposing the credential.
- [x] MCP tool calls use the existing Application Tool Registry rather than Renderer/global vendor
      state. Read-only calls return bounded redacted results immediately. `terminal.exec` creates the
      same persisted Tool Call, Run and exact parameter-hash approval used by Agent Tool Cards; the MCP
      response reports `waiting_approval`, and execution occurs only after the user consumes the
      unexpired desktop approval once. Adapter, Application, Widget lifecycle and real headless Runtime
      tests cover auth, Origin, version/session lifecycle, tool metadata, idempotency, approval and
      credential cleanup. Production Electron confirms the complete MCP client flow, live instance
      state, real approved PTY filesystem effect, storage redaction and deterministic shutdown; it
      records `test-results/phase20-mcp-server-widget.png` at logical 1440×900 without overlap or clipped
      primary controls. The paired MCP configuration state passes at 95.543%–96.822%. I-10 is
      Implemented; official SDK/client and packaged
      platform evidence remain, so Phase 20 certification stays open; J-02 is now implemented and
      active work has moved through J-06 to J-07.
- [x] J-02 carries Electerm's offline-state and power-resume intent through Axterm's Level 1
      boundaries. Electron Main records suspend/resume revisions in the authenticated Host REST
      service; a Runtime-owned bounded poller publishes newer revisions through realtime SSE and is
      closed before Runtime teardown. Browser offline/online signals and native resume refresh
      discovery and read queries while preserving a healthy local PTY. A compact recovery bar explains
      network, wake and Runtime-restart outcomes and provides an explicit refresh/dismiss path.
- [x] A packaged utility SIGKILL reload now carries a non-secret recovery marker, restores persisted
      layout with stale sessions disconnected and keeps per-tab manual reconnect. Existing database
      recovery marks active transfers and AI work failed, approvals expired, batch jobs interrupted and
      sync failed. No command, transfer or business mutation is issued by offline/online/resume handling.
      Host/API/Application tests and two production Electron fault journeys pass; the native-resume
      state is recorded in `test-results/phase21-j02-recovery.png` at logical 1440×900. J-02 is
      Implemented; Windows/Linux packaged fault runs and long-duration cross-surface certification stay
      open.
- [x] J-03 expands the copied macOS arm64 package journey beyond foundation smoke. With checkout-independent
      cwd and a restricted `/usr/bin:/bin` path, it verifies `app.asar`, an exact 1440×900 fresh window,
      local PTY/search, writable SQLite, native SerialPort enumeration, Host and Quick Command persistence,
      real Docker OpenSSH authentication/Host Key/terminal, SFTP `/tmp` browsing and deterministic close.
      Seven reviewed golden images cover terminal, Host manager, Quick Commands, Settings, relaunch, SFTP
      and upgrade states without clipped primary controls or viewport overflow. J-03 is Implemented; real
      signing/notarization remains release certification evidence.
- [x] J-04/J-05 platform workflows are present in `.github/workflows/check.yml`, including three-platform
      checks/builds, Windows packaged journeys and Linux Xvfb plus Docker OpenSSH packaged journeys. The
      current macOS arm64 workspace has neither a committed Git remote nor reachable Windows/Linux x64
      desktop runners, so both exact evidence tasks are registered above and implementation continues.
- [x] J-06 adds a transactional application-version ledger in Runtime-owned SQLite. A packaged upgrade
      journey starts from an actual 0.9.0 profile rolled back to schema 31, applies migration 32 and records
      `0.9.0` as the previous version while preserving a password Host, Quick Command and the same encrypted
      application-local Vault credential. The test verifies the secret remains decryptable, is absent from
      SQLite, and records `tests/parity/screenshots/axterm/packaged/upgrade.png` at logical
      1440×900. J-06 is
      Implemented; signed test-channel binary delivery remains certification evidence. Work continues at J-07.
- [x] The H-12 signed update provider closes the locally actionable part of J-06: a real loopback feed
      now proves manifest verification, progress, cancellation, retry, artifact verification and OS
      installer handoff in production Electron. It does not replace the remaining controlled-channel and
      installed-platform upgrade evidence. A packaged variant now drives the same authenticated
      check/download/ready/install flow and asserts that the installer path stays outside Renderer. The
      latest verified-DMG macOS arm64 installation passed this journey together with independent startup,
      shell/workspace, localization/restart and old-profile/local-Vault upgrade checks. The package runner
      snapshots and restores the exact Node build in `finally`, including failure paths; a post-package
      native smoke and marker tests confirm the local Node ABI remains usable.
- [x] J-01 now applies a default 10,000-row bound to replayable Domain Events and a 2,000-receipt
      bound to every idempotent operation that does not declare a smaller limit. Cursor ids stay
      monotonic so the existing stale-cursor reset remains valid; direct SQLite tests exercise both
      defaults and reject an invalid retention limit without writing a receipt.
- [x] `tests/soak/phase21-mixed-workload.test.ts` and `scripts/test-phase21-soak.sh` provide one
      production-headless workload over real node-pty, Docker OpenSSH/ssh2, Binary WS, realtime SSE,
      Terminal Information, SFTP, transfer, dynamic tunnel, static-file Widget and authenticated MCP.
      The 60-second macOS arm64 smoke completed 60 cycles, 30 transfers, 20 tunnels and 12 MCP calls;
      peak RSS/heap grew 3.38/3.54 MiB, event-loop p99 was 22.66 ms, cycle p95 was 174.82 ms, SQLite
      grew 3.00 MiB and all transient and final resource assertions passed. The atomic JSON result
      identifies this as `smoke`. The first formal macOS arm64 run started at
      `2026-09-13T23:52:26.688Z` and stopped after 506 successful cycles when the 507th local PTY
      creation reached a node-pty macOS descriptor leak. The host limit is 511; the package's
      `pty_posix_spawn` guard failed to close its first temporary descriptor. Axterm now destroys
      and waits for the native PTY, carries a two-line native count/index patch, and reproducibly
      compiles it for Node and Electron ABIs. A separate 100 ms profile passed 729 cycles, 364
      transfers, 243 tunnels and 145 MCP calls with no violation and final zero-owner cleanup.
      The existing formal profile started at `2026-09-14T00:21:19.745Z` and ran for 31 minutes
      27 seconds, reaching 1812 cycles, 906 transfers, 604 tunnels and 362 MCP calls with zero
      violations. Its last checkpoint also exceeded 30 minutes. The normally completed 729-cycle
      accelerated regression and 60-second smoke return every final owner to zero. The user replaced
      the former target with 30 minutes, accepted this existing composite evidence and directed that
      it must not be rerun. The durable certification record is
      `docs/implementation/evidence/J01-30M-CERTIFICATION-2026-09-14.json`; J-01 is Certified.
- [x] J-07 now captures all 48 visual-manifest Axterm/Electerm scenarios at 1280×800, 1440×900 and
      1920×1080. All 144 pairs pass the 95% threshold, with 95.089% as the lowest similarity.
      Every Axterm capture runs the seven hard-defect gates for overlap, clipping, contrast,
      viewport containment, text direction, keyboard focus and primary-action reachability;
      1008/1008 checks pass. This audit fixed compact SSH Config button wrapping, selected-control
      contrast and command-history popover anchoring, then added the real UI Themes state. Axterm
      now ships all 310 upstream MIT themes as generated in-project data, exposes 312 built-ins in
      total and matches Electerm's ten-item pagination while retaining explicit safe save/apply
      controls. The complete configurable activity rail was then recaptured across the corpus
      without introducing a hard defect. The editable Shortcut registry now adds three comparisons
      at 96.081%–96.866%; its first capture exposed and fixed an overlaid terminal-byte mask rather
      than accepting invalid magenta evidence. The real SSH Bookmark Settings tab adds three Phase 15
      network comparisons at 97.346%–97.975%, then adds PrivateKey/Certificate authentication at
      97.834%–98.354% and saved-Bookmark tunnel configuration at 96.641%–97.705%.
      The Phase 16 additions drive a real Docker OpenSSH/SFTP target and an authorized local
      directory: dual-pane browsing passes at 95.213%–97.196%, a 128 MiB streaming transfer and
      transfer-center/history state passes at 95.171%–96.928%, and the real remote editor/search
      surface passes at 96.513%–98.166%. Seven Phase 17 protocol forms pass at 95.642%–97.513%,
      and the real Runtime/File Grant/PTY XMODEM progress scene passes at 97.933%–98.935%.
      Phase 18 adds real Quick Command/Batch at 95.089%–97.253%, Trigger/script editing at
      95.092%–97.147%, Terminal Information/Monitor at 96.724%–98.460% and the matched Static File
      Server Widget form at 95.623%–97.233%. The Phase 18 pass rejected invalid terminal masks and fixed
      the compact English `Manage` clipping before accepting the evidence. Phase 19's six settings
      scenes pass at 95.428%–97.143%; Phase 20 Provider, Chat, canceled Chat, Agent and MCP pass at
      95.340%–98.452%; the persisted canceled Chat state retains partial output and exposes
      `REQUEST_CANCELED` at 96.600%–98.196%. Phase 21 diagnostics/updater and accessibility settings pass at
      96.444%–97.020%, and the real temporary-SSH disconnect/automatic-reconnect state passes at
      98.931%–99.410%. The MCP comparison first failed at 93.018%, then the product adopted the
      upstream horizontal form rhythm and passed without masking its controls. Side-by-side manual review
      of all 144 pairs confirms stable density, hierarchy, controls, menus, forms, terminals and LTR/RTL
      direction. The remote-session network-failure and AI cancellation states are independently covered;
      Windows/Linux packaged visuals remain, so J-07 stays Partial.
- [x] J-08 adds a dedicated production-Electron accessibility project. It audits visible enabled
      controls on Shell, Settings and the SSH Host dialog for accessible names, positive tabindex
      and duplicate visible IDs, verifies Main/navigation landmarks, completes Settings and Host
      editing through keyboard activation, uses Home/End category movement, traps dialog focus,
      closes with Escape and restores focus to the triggering Add Host button. The audit found and
      fixed an unnamed primary nav plus missing shared-Modal Escape/focus behavior. Reduced-motion
      emulation proves visible Shell motion is capped at 0.01 ms. Both journeys pass locally and run
      in the three-platform CI matrix; manual VoiceOver/NVDA/Orca evidence remains certification work.
- [x] J-09 defines fixed regression budgets for 10,000 Bookmarks, 10,000 directory entries, a
      simulated 64 MiB terminal stream and 10,000 persisted transfer rows. Bookmark/file production
      components now share clamped virtual-window math and file filtering/sorting can be profiled
      independently of React. Runtime keeps terminal replay at 80 KiB, active transfers at 32 and
      visible transfer history at 500.
- [x] The macOS arm64 unit profiles complete in 9.41–79.97 ms per whole test. A production-Electron
      journey loads, expands, searches and scrolls the Runtime-backed 10,000-Bookmark tree in 1.2
      seconds, mounts 37 rows at 1440×900 and enforces a cross-run ceiling of 64. The three-platform
      workflow runs the same performance project. `PERFORMANCE_BUDGETS.md` records the target,
      regression ceiling and remaining long-run/installed-platform evidence; J-09 is Implemented.

| Phase | Area                                                             | Initial state         | Exit source                                                                                                               |
| ----- | ---------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 11    | Reference harness and design system                              | Complete (2026-09-12) | Reference corpus, scenario manifest, token map and visual diff gate                                                       |
| 12    | Shell/navigation/tabs/layout/workspaces                          | In progress           | Matrix A Certified                                                                                                        |
| 13    | Bookmarks/groups/profiles/history/migration                      | In progress           | Matrix B Certified                                                                                                        |
| 14    | Terminal UX                                                      | In progress           | Matrix C except C-16 Certified                                                                                            |
| 15    | SSH/proxy/hopping/tunnels                                        | In progress           | Matrix D Certified                                                                                                        |
| 16    | File manager/editor/transfer center                              | In progress           | Matrix E Certified                                                                                                        |
| 17    | FTP/Telnet/Serial/RDP/VNC/SPICE/Web/terminal transfer            | In progress           | Matrix F and C-16 Certified                                                                                               |
| 18    | Commands/automation/monitoring/widgets/CLI                       | In progress           | Matrix G except MCP-specific behavior Certified                                                                           |
| 19    | Settings/themes/sync/localization                                | In progress           | Matrix H-01 through H-11 Certified                                                                                        |
| 20    | AI and MCP                                                       | In progress           | Matrix I Certified                                                                                                        |
| 21    | Reliability/accessibility/performance/distribution certification | In progress           | 122/122 normally; 121/122 + one registered blocker may close implementation, while formal release still requires Phase 10 |

The row status, upstream path, gap, owner phase and required evidence are tracked
only in [ELECTERM_PARITY_MATRIX](ELECTERM_PARITY_MATRIX.md). A feature becoming
usable moves a row at most to Implemented; it reaches Certified only with the
required interaction, visual and packaged evidence. Earlier phases can remain open
while a later, explicitly recorded dependency is implemented. Work also skips an
objectively blocked item after it is entered in the Blocker Register. The implementation
target may close above 99% (at least 121/122) with one registered blocked row; Phase 21
formal release remains open until Phase 10 and the non-waivable gates pass.

## Verification snapshot

- `bun run test`: 721 passed across 164 files; one Docker-gated test/file is skipped in the default run. H-04 adds
  terminal visual Contract defaults/cross-field validation, SQLite restart persistence and bounded
  application-local background asset import/delete coverage. C-16 adds
  a real paired XMODEM binary fixture plus ZMODEM/trzsz split-header, path-redaction, cancel,
  progress, bounded-wait and cleanup coverage. G-01 adds Quick Command aggregate, migration,
  tree/search/drop and template coverage. G-02 adds migration/reopen, per-Bookmark persistence,
  event redaction, Electerm round-trip and safe single-line insertion coverage. G-04 adds ordered
  worker-pool, cancellation, restart recovery and event-redaction coverage. G-05 adds bounded
  streaming, split ANSI/CRLF, once/repeat/cooldown, unsafe-regex, atomic replacement, Bookmark
  isolation, event-redaction and deterministic cleanup coverage. G-06 adds ordered startup,
  output-idle reset, user-input gating, cancellation and cleanup coverage. G-07 adds all-group parser,
  TTL/in-flight cache, stale/unsupported state, bounded history and lifecycle coverage. G-08 adds
  monitor threshold hysteresis, formatting and Runtime Settings restart coverage.
  H-08 adds portable settings/desktop-preference parsing, credential-metadata redaction and rejection,
  target-identity round trip, stale Settings compensation and atomic export coverage. H-09/H-10 add
  profile recovery/ETags, encryption, cancellation, auto-download review, eight-category database
  round trips, all four Provider contracts, redacted auth/offline failures and a real WebDAV boundary.
  H-11 adds full 15-locale/410-key coverage, locale normalization, safe fallback, RTL and language
  Contract/restart persistence coverage. I-10 adds MCP authentication, Origin, protocol/session,
  Tool Registry, idempotency, approval, credential cleanup and real Runtime lifecycle coverage.
  J-02 adds authenticated native lifecycle propagation, online/offline handling and poller cleanup.
  J-06 adds the transactional application-version transition ledger and old-version restart cases.
  J-09 adds the four 10k/64 MiB response and capacity profiles.
- `bun run test:a11y`: two production-Electron journeys pass accessible-name/ID/tabindex checks,
  keyboard-only Settings/Host-dialog focus behavior and the 0.01 ms reduced-motion ceiling.
- `bun run test:performance`: the production Electron 10,000-Bookmark journey passed expansion,
  exact search, end scrolling, spacer geometry, per-action time ceilings and the 64-row DOM ceiling.
- `bun run test:ssh`: pinned Docker OpenSSH Runtime integration, G-06 startup sequence/X11 result,
  G-07 Linux system sampling and desktop B-12 Save-and-Connect/information-panel/remote-monitor journey
  passed.
- `bun run test:e2e`: 65/65 runnable production-Electron journeys pass, with the standalone
  Docker-gated B-12 journey skipped in this invocation and covered by `test:ssh`. The suite covers
  utility isolation, real local PTY,
  persistence, Runtime crash/restart, RDP, VNC and SPICE bookmark/local-Vault UI and cleanup passed;
  the Web loopback journey verifies a native child page, custom User-Agent and deterministic close. The
  targeted F-08 production run additionally passes startup, `open-url` and second-instance protocol routing.
  The targeted G-01/G-02 production run passes folder/command CRUD, multi-step templates, search, drag,
  duplicate, SSH Bookmark-local command assignment, explicit insert versus send through a real local
  PTY, and close-then-inspect SQLite persistence. The targeted G-03 run opens two real local PTYs and
  proves selected/all routing, unchanged active-tab focus and Escape dismissal without sending. The
  targeted G-04 run executes three persisted SSH Bookmark targets at concurrency two, renders each
  result, releases every connection and verifies the redacted SQLite summary after close. The targeted
  G-05 run persists a global rule and proves it responds to real local PTY output in the production app.
  The targeted G-06 editor run persists ordered login/run steps and every send/wait option without
  control overlap in the scrollable full-window Bookmark form. B-12 also opens the G-07 information
  panel against its verified SSH session and renders live system, CPU and memory groups. The same
  journey enables G-08, verifies all nine items, terminal/footer geometry, CPU/memory/process details,
  full-information navigation and persisted monitor settings. The targeted H-08 journey exports through
  a native save grant, changes Runtime and Desktop preferences, re-imports through a native open grant,
  avoids duplicate entities and proves the application-local Vault remains byte-for-byte unchanged. The
  targeted H-09/H-10 journey uses a real loopback WebDAV server and application-local Vault to verify
  eight-category upload/compare, stale-remote conflict, reviewed download/commit, deletion and Renderer
  storage redaction. The targeted H-11 journey proves immediate English switching, restart persistence,
  Arabic RTL and safe English fallback for Axterm-specific text. The targeted I-10 journey starts an
  application-local-Vault-backed MCP server, exercises initialize/list/read/mutate, approves the exact
  mutating call through the Agent card, verifies a real PTY effect and stops every session/socket. The
  targeted J-02 journeys inject browser offline/online, Electron power resume and a SIGKILL into the
  test-owned utility Runtime; they verify the recovery bar, unchanged local PTY, generation-bound stale
  tabs, manual reconnect and zero recovery-triggered business mutations. The targeted H-03 journey
  verifies the 312-theme catalog, clone/edit/preview, atomic export/import, search and two-step delete.
  The targeted H-12 journey uses an Ed25519-signed loopback manifest and streamed artifact to prove the
  real Settings check/progress/cancel/retry/ready UI, private temporary-file cleanup, second verification
  and intercepted installer handoff without exposing the local path.
  The closeout run also verifies all seven activity destinations, localized Settings/Theme/Profile
  navigation, the 14-action local-file menu, editable multi-level jump chains, unique SSH tunnel
  controls, reviewed AI bookmark/theme flows, connection Profiles and terminal file-drop policy.
- `bun run test:dev`: Vite Renderer connected to the loopback Runtime WebSocket and real local PTY.
- `bun run test:packaged` / `bun run test:dmg:macos`: copied or verified-DMG-installed macOS `.app`, restricted PATH, exact 1440×900 bounds, local PTY/search,
  SQLite, native SerialPort enumeration, persisted Host/Quick Command relaunch and old-schema/local-Vault
  upgrade passed. The dedicated H-11 package journey additionally passed 15-language availability,
  immediate English switching, cold-restart persistence, Arabic RTL and physical-left activity-rail checks.
  The latest run passed all five runnable journeys and added the signed updater check/download/ready/install
  flow while proving the local installer path remains outside Renderer; the SSH-fixture case is conditionally
  separated and retains its earlier dedicated passing evidence. The same five journeys pass through the committed DMG gate: it verifies and mounts the image, copies the app into an independent temporary installation directory, detaches the image before launch, and cleans both temporary directories. The macOS CI job now runs this exact command.
- `bun run test:ssh:packaged`: copied macOS `.app` connected to Docker OpenSSH, ran an SSH PTY and browsed
  the live `/tmp` directory over SFTP; the complete source B-12 SSH/SFTP/transfer/editor journey passed first.
- `bun run architecture:check`: 340 modules and 1215 dependencies passed the Level 1 / Zero
  Business IPC gate.
- `bun run contracts:check`: 255 operations match OpenAPI and generated client.
- `bun run parity:audit`: 122 matrix items across 50 scenarios passed with zero unmapped
  upstream settings, actions or design tokens; 0 settings and 0 actions remain unimplemented. The
  settings map contains 50 Implemented and 22 Partial entries. The
  same gate opens all 288 current Playwright trace archives and reports zero unredacted Authorization,
  bootstrap/session token or credential fields. Trace recording now sanitizes these fields before
  retaining evidence; the real Phase 17 transfer driver also keeps its generation token outside the
  Renderer evaluation boundary.
- H-11 parity capture: pinned Electerm and Axterm each produced six macOS arm64 LTR/RTL images and
  six traces across the fixed viewports. `test-results/parity-diff-h11/report.json` records all six
  comparisons at 96.660%–97.143% similarity; every scene passes the 95% rule. Axterm capture metadata
  also records all seven hard-defect checks as passing for every viewport and direction.
- `bun run parity:diff`: 144 fixed Electerm/Axterm comparisons across 48 real scenes and three
  viewports pass the 95% rule; the lowest similarity is 95.089%. Candidate metadata records
  1008/1008 hard-defect checks passing. Side-by-side review of all 144 pairs also confirms stable
  density, hierarchy, selected states, menus, forms, terminal surfaces and LTR/RTL direction without
  a blocking visual defect; Windows/Linux installed-package states remain external-platform evidence.
- `bun run package:dir`: generated a self-contained macOS arm64 `.app`; node-pty and SerialPort native
  modules were rebuilt for Electron ABI 149 and only their required `.node` files were unpacked. The
  production layout also contains independently loaded IronRDP WASM, noVNC RFB and SPICE client assets;
  ZMODEM/XMODEM/trzsz engines are bundled inside the separate Runtime artifact.
- `bun run package`: generated unsigned macOS arm64 DMG/ZIP with ambient signing-identity discovery
  disabled by the package wrapper. `hdiutil verify` and `unzip -tq` accept the 2026-09-14 artifacts;
  their SHA-256 digests are recorded in `PACKAGING.md`. A post-package native smoke confirms Node ABI
  node-pty was restored after the Electron build.

The upstream Zod package emits non-fatal Rollup comment-annotation warnings. No
tests or architecture rules are disabled to hide them.

## Desktop 1.0 Definition of Done

Architecture, Function, Security and Reliability items in MASTER_SPEC §49 are
implemented and covered by the evidence above. Distribution is tracked separately:

- [x] macOS packaged smoke.
- [ ] Windows packaged smoke.
- [ ] Linux packaged smoke.
- [x] node-pty works in the packaged macOS app.
- [ ] fresh install and upgrade smoke on all supported platforms.

Therefore Desktop 1.0 is **not marked complete**.

## Roadmap

阶段内工作包、跨阶段依赖和当前领取顺序见
[ELECTERM_PARITY_ROADMAP](ELECTERM_PARITY_ROADMAP.md)。本表只表达阶段是否达到
Acceptance，不用勾选状态代替矩阵证据。

- [x] Phase 0 — Repository Foundation
- [x] Phase 1 — Persistence / Contract / Host Manager
- [x] Phase 2 — Local Terminal
- [x] Phase 3 — SSH Terminal
- [x] Phase 4 — SFTP / File Grant / Transfer
- [x] Phase 5 — Productivity Workspace
- [x] Phase 6 — SSH Tunnels
- [x] Phase 7 — AI Foundation
- [x] Phase 8 — AI Diagnosis / Agent
- [x] Phase 9 — Reliability Hardening
- [ ] Phase 10 — Packaging / Desktop 1.0
- [x] Phase 11 — Parity Harness / Reference Design System
- [ ] Phase 12 — Shell / Navigation / Tabs / Layout / Workspace
- [ ] Phase 13 — Bookmarks / Groups / Profiles / History / Migration
- [ ] Phase 14 — Terminal UX
- [ ] Phase 15 — SSH / Proxy / Hopping / Tunnels
- [ ] Phase 16 — File Manager / Editor / Transfer Center
- [ ] Phase 17 — Protocol Parity
- [ ] Phase 18 — Commands / Automation / Monitoring / Widgets / CLI
- [ ] Phase 19 — Settings / Themes / Sync / Localization
- [ ] Phase 20 — AI / MCP Parity
- [ ] Phase 21 — Parity Certification / Reliability / Distribution
- [ ] Phase 22 — Headless / Remote Runtime
- [ ] Phase 23 — Expo 57 Mobile
- [ ] Phase 24 — Extension Ecosystem
