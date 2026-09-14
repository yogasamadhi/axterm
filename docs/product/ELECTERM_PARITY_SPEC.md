# Electerm 5.5.0 desktop parity specification

> Document type: Normative product and acceptance specification  
> Status: Active  
> Date: 2026-09-13  
> Upstream baseline: `vendor/electerm` at
> `799bedef98c1deae676ae03041719de98d3b57f1`  
> Architecture authority: [MASTER_SPEC](../architecture/MASTER_SPEC.md)  
> Decision: [ADR-003](../adr/ADR-003-electerm-parity-program.md)  
> Implementation route: [ELECTERM_PARITY_ROADMAP](../implementation/ELECTERM_PARITY_ROADMAP.md)  
> Execution ledger: [ELECTERM_PARITY_MATRIX](../implementation/ELECTERM_PARITY_MATRIX.md)

## 1. Purpose

This specification turns “reproduce Electerm 1:1” into an objective desktop
delivery target. The pinned Electerm application is the behavioral and visual
reference. Axterm reimplements that reference with its own contracts,
components, domain services and adapters.

The existing Phase 0–10 work is a sound foundation, but it covers only part of
the reference product. A working SSH terminal, a file table or a row of tabs is
not parity by itself. The surrounding configuration, menus, keyboard paths,
drag behavior, feedback, recovery and packaged behavior are part of the feature.

## 2. Baseline and change control

The only acceptance baseline is the vendored commit shown above. Its relevant
reference surfaces include:

- `src/client/components`: screens, interaction logic and styles;
- `src/client/common/default-setting.js`: defaults;
- `src/app/server` and `src/app/lib`: connection and desktop behavior;
- `src/app/widgets`: widget behavior;
- `src/test/e2e` and `src/test/unit-ci`: golden workflows and edge cases;
- `README.md`: advertised desktop capabilities.

An upstream path is evidence of intended behavior, not permission to import it
across Axterm's boundaries. Every adapted area is recorded in
`docs/implementation/UPSTREAM.md`, including the destination and material
behavior changes.

When an upstream result is ambiguous, acceptance follows this order:

1. behavior of the packaged Electerm application at the pinned commit;
2. an upstream E2E or unit test;
3. component and server implementation;
4. default settings and README claims.

Changing the pinned commit requires a new ADR and a matrix diff. Until that is
accepted, later Electerm behavior is outside this program.

## 3. Meaning of 1:1

Parity has seven independent dimensions. All applicable dimensions must pass.

| Dimension     | Required result                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Feature       | Every reference action has an Axterm path and produces an equivalent result.                                            |
| Interaction   | Mouse, keyboard, context menu, drag/drop, focus, selection and confirmation behavior match.                             |
| Visual        | Geometry, density, hierarchy, visible states, icons and theme outcomes match at reference viewports.                    |
| Configuration | Defaults, scopes, validation, profiles and per-session overrides have equivalent outcomes.                              |
| Data          | Import, export, sync, history and restart behavior retain equivalent user data without exposing secrets.                |
| Failure       | Permission, timeout, disconnect, conflict, cancellation and unsupported states are visible and recoverable.             |
| Platform      | The packaged feature works on each platform Electerm supports for that feature within Axterm's declared desktop matrix. |

Axterm branding replaces Electerm branding. Text can use clearer Chinese or
Axterm terminology. Native dialogs and title bars can follow the host platform.
Security prompts may be stricter. These variations are acceptable only when they
do not remove an upstream capability or make its normal path materially longer.

Architecture is explicitly not copied. Main remains Desktop Host, Runtime remains
the business process, Renderer remains a pure client, terminal data remains a
Binary WebSocket, events remain SSE and files remain streams. Secrets stay in the
application-local encrypted Host Vault defined by ADR-004; system keychains and
credential services are not a product option. AI mutations continue to use
Axterm's risk and approval policy.

## 4. Reference shell and visual contract

The desktop shell follows Electerm's information architecture:

```text
┌ activity rail ┬ contextual side panel ┬ tabs / quick connect / layout / window controls ┐
│ bookmarks     │ tree, search, history │ active session tabs and tab actions             │
│ history       ├───────────────────────┼─────────────────────────────────────────────────┤
│ themes        │ optional detail panel │ one to four terminal/file/remote session panes  │
│ settings      │                       │ each pane owns session controls and feedback      │
│ sync/widgets  ├───────────────────────┴─────────────────────────────────────────────────┤
│ transfers     │ quick-command / shortcut / monitor / status surfaces                    │
└───────────────┴─────────────────────────────────────────────────────────────────────────┘
```

Reference viewports are 1280×800, 1440×900 and 1920×1080 at 100% scale, plus
the platform's normal HiDPI scale. The test corpus covers light and dark themes,
empty and populated data, one and four panes, open menus/modals, transfer states,
disconnected sessions and compact widths.

After masking native window chrome, font antialiasing, caret blink, timestamps
and live terminal bytes:

- stable screenshot similarity must be at least 95%, meaning pixel difference
  must not exceed 5%;
- fixed surface edges may differ by at most 4 CSS pixels;
- no text, button, focus ring, menu or error may be clipped;
- tab order and keyboard reachability must remain deterministic;
- color and spacing come from reviewed Axterm tokens mapped to the reference,
  not one-off component values.

The 95% score is only the numerical visual gate. A scene fails regardless of its
score when primary controls overlap, text or actions are clipped, content or
contrast is unreadable, a menu/dialog leaves the viewport, LTR/RTL direction is
broken, keyboard focus is discontinuous, or a primary action is unreachable or
nonfunctional. Functional, interaction, configuration, data, failure and
platform parity remain independent requirements and are not relaxed to 95%.

The visual corpus masks `.xterm-rows` because those nodes contain live terminal
bytes while their surrounding xterm geometry remains visible and measurable.
The no-session logo comparison masks only a matching inset over the product
wordmark inside each implementation's morph shape. The capture harness inserts
that inset as a `data-parity-dynamic` marker; the morph shape, lockup position,
edition/version badges and surrounding controls remain part of the visual
acceptance surface. This applies the allowed Axterm branding substitution above
without hiding functional UI.

Responsive behavior is assessed by outcome: side panels collapse, tab overflow
remains operable, menus stay inside the viewport and the active terminal keeps a
usable minimum size. Platform accessibility settings and reduced motion take
priority over pixel identity.

## 5. Functional surface

### 5.1 Application shell, sessions and workspaces

Axterm must reproduce the activity rail, configurable rail icons, contextual
side panels, draggable tabs, pinned tabs, quick-connect entry, new-session menu,
tab overflow, context actions, one-to-four-pane layouts, pane focus, swap/clone,
saved workspaces and startup sessions. Closing, reloading, duplicating and
restoring sessions show the same decisions and never orphan Runtime resources.
An ordinary cold start or macOS window reopen starts with exactly one fresh
local terminal and does not recreate the previous tabs, connections or pane
layout. Named workspaces remain available for manual loading, while an explicit
startup-session, command-line or deep-link target may replace the default local
terminal.

Global window visibility hotkey, custom/system title bar selection, opacity,
fullscreen, window bounds restore, multi-display correction, zoom and native
window controls receive platform-specific packaged tests.

### 5.2 Bookmarks, groups, profiles and history

The bookmark tree supports nested groups, expand/collapse, search, selection,
color/title, descriptions, drag between groups, reorder, duplicate, import,
export and connection from a row. History supports reconnect, convert to
bookmark, removal, clearing and the configured privacy behavior.

Connection forms cover every supported session type and preserve Electerm's
tabbed organization: authentication, settings, quick commands, triggers,
tunnels and connection hopping where applicable. Profiles can supply reusable
protocol and terminal values without storing secret text in the business DB.

### 5.3 Terminal experience

Local and remote terminal panes reproduce xterm rendering, resize, IME,
selection, copy/paste, paste confirmation where applicable, Web Links, OSC 52,
search, command suggestions/history, timestamps, context actions, reconnect
overlay, errors, shortcut bar and file drop behavior. Renderer type fallback,
scrollback, terminal type, font, cursor, word separators, backspace/Shift+Enter,
raw display, encoding, startup directory, environment and session log options
have matching outcomes.

Themes, per-session backgrounds, image filters, background text and terminal
image display are visible in the live terminal. Zmodem, Xmodem and trzsz flows
are terminal protocols with bounded streams and deterministic cancellation.

### 5.4 SSH and network controls

SSH supports password, private key, passphrase, certificate, keyboard
interactive/OTP and platform agent behavior exposed by the reference. Host Key
confirmation remains stricter for changed keys. Per-session and global proxies,
ProxyCommand, algorithms, compression, keepalive, encoding, LANG/SetEnv, startup
directory, X11, jump chains, login scripts and saved tunnels have equivalent
configuration and runtime results.

Local, remote and dynamic forwarding expose configuration, start/stop status,
retry and cleanup. Binding outside loopback still requires an explicit Axterm
capability and clear risk text.

### 5.5 File manager and transfer center

The SSH workspace includes local and remote file panes, with the split mode and
path-follow-session option available as settings. Each pane provides editable
address history/bookmarks, parent navigation, refresh, keyword filter,
show-hidden behavior, sortable and configurable columns, pagination,
multi-selection, keyboard operations, context menus and drag/drop.

Operations include create file/folder, rename, delete, cut/copy/paste, upload,
download, local-to-remote, remote-to-local, remote-to-remote, recursive
directories, permission edit, info, path copy, reveal in native file manager,
open a terminal at a folder, small-text internal edit, system-editor edit with
change watching, compare and compress-and-transfer where the reference offers
them.

The global transfer center reproduces queued/running/paused/failed/completed
states, per-item and aggregate progress, speed, conflict decisions, apply-to-all,
cancel, retry/resume, clear and transfer history. All data paths stay streamed;
temporary files and channels are cleaned deterministically.

### 5.6 Additional sessions

The parity target includes FTP/FTPS, Telnet, Serial, RDP, VNC, SPICE and Web
sessions, together with their reference bookmark fields and session controls.
Protocol-specific behavior includes Telnet login/password prompts, serial baud
and line settings, VNC quality/compression/view/scale options, RDP domain and
SPICE view/scale options. Jump or proxy behavior is supplied where the reference
exposes it.

Adapters may use different maintained libraries than Electerm. The choice must
be captured in an ADR when it adds a native module, proxy process or new trust
boundary.

### 5.7 Productivity, automation and monitoring

Quick Commands support folders, search, drag/reorder, templates, multi-line
content, per-session assignment and insert/send behavior. Batch input mirrors
input to selected or all terminals. Batch operations run a script over selected
bookmarks with bounded concurrency, per-target logs, cancellation and summary.

Triggers match bounded terminal output, including chunk boundaries and ANSI
stripping, then perform a configured send action with once/repeat and cooldown
rules. Login/run scripts retain ordering and delay semantics.

Terminal info and remote monitor surfaces cover hostname, uptime, CPU, CPU
history, memory, traffic, users, disks, activity/process details and the compact
monitor bar. Pollers are shared, bounded and stopped when hidden or disconnected.

Widgets cover the pinned baseline's batch operation, local file server, local
FTP server, SSH server and MCP server experiences, including instance status,
rename, stop and detailed notifications.

### 5.8 Settings, themes, synchronization and desktop integration

Every setting in the pinned default-setting file and Settings UI must have a
mapped Axterm setting, a documented intentional platform exception or an open
matrix item. This includes global hotkey, shell defaults, scrollback, renderer,
terminal appearance, title bar, opacity, editor, history choices, terminal/SFTP
linking, auto reconnect/restore, multi-instance behavior, drag/drop choice,
sidebar icon order, shortcuts and updater preference.

Theme workflows include list, preview, create, edit, clone, import, export,
delete and AI generation. Data import/export and selected-category sync support
the providers exposed by the reference baseline, including GitHub/Gitee secret
gist, WebDAV, custom server and Electerm-cloud-equivalent capability when an
Axterm service exists. Provider unavailability is explicit and must not block
local import/export.

Deep links and CLI entry points open supported sessions through validated input.
External URLs pass through the Desktop Host. Localization covers the languages
shipped by the chosen Axterm release, while missing translations fall back
without broken keys in the UI.

### 5.9 AI and MCP

AI reproduces configuration, provider formats, chat sessions/history, streaming,
stop, command suggestions, explain-selected-content, bookmark creation, theme
creation and agent tool cards. The pinned baseline's OpenAI Chat Completions,
OpenAI Responses and Anthropic message shapes receive adapter tests.

Axterm retains bounded, inspectable and redacted context. Generated commands
remain insert/copy by default. Any mutating agent action uses the existing Tool
Registry, exact-argument approval and audit trail even if the upstream path is
less strict.

MCP is exposed through a Runtime-owned adapter and the widget lifecycle. It may
map only registered Application tools and cannot bypass risk classification,
credential isolation or approval.

## 6. Data and compatibility

Axterm's schema remains authoritative. An importer converts Electerm bookmarks,
profiles, quick commands, themes and settings into Axterm entities. Import is
previewable, cancellable and repeat-safe, preserves hierarchy and reports every
unsupported or skipped field. Secret import requires an explicit secure path and
never writes plaintext to the business database.

Workspace, window, layout and UI state survive restart where Electerm does. Live
PTY, SSH and transfer handles are never serialized. Restored live-session views
show disconnected state and offer an explicit reconnect action.

## 7. Evidence and completion rules

Each matrix item must link all applicable evidence:

- an upstream source or test at the pinned commit;
- the Axterm Contract/Application/Renderer implementation;
- unit or Runtime integration tests for state and error semantics;
- Playwright interaction coverage;
- a reviewed screenshot pair for visual surfaces;
- packaged-platform evidence for native or protocol behavior.

Status meanings are strict:

| Status         | Meaning                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| Missing        | No usable Axterm workflow exists.                                                            |
| Partial        | Some behavior exists, but any required parity dimension is absent.                           |
| Implemented    | Code and automated checks exist; visual/platform review may remain.                          |
| Certified      | All required evidence is linked and reviewed on the declared platform matrix.                |
| Not applicable | A documented baseline or platform reason makes the upstream item inapplicable.               |
| Blocked        | An objective constraint prevents progress; evidence and an unblock condition are registered. |

“Implemented” and “Blocked” are not accepted parity. A phase normally closes only when all of its
matrix items are Certified or have an approved Not applicable decision. Some shell rows
span later functional slices: the earlier phase remains open while the dependent
phase is implemented, and the row is certified only after the integrated workflow
has all of its evidence. An open earlier phase therefore does not block work on an
explicitly recorded dependency; it does block any claim that the earlier phase is
complete.

When an item cannot advance because of an unavailable platform, certificate,
hardware dependency or a reproducible technical impasse, its exact task, matrix
row, evidence, completed portion, unblock condition and resume point must be added
to the Blocker Register in `STATUS.md`. Work then continues with the next executable
item. A merely difficult, large or unfinished item is not Blocked.

The accepted implementation delivery threshold is strictly greater than 99%:
`(Certified + approved Not applicable) / 122`, which requires at least 121 rows.
At most one matrix row may remain Blocked at that point. The blocked row does not
count toward coverage and is never relabeled as Certified. Phase 10 platform gates,
architecture/security/data-integrity requirements and the formal Desktop 1.0 release
status remain open until their own non-waivable evidence exists.

## 8. Non-negotiable quality rules

- No terminal byte stream enters React state or Zustand.
- No file transfer uses whole-file JSON or Base64.
- Every session, socket, stream, poller, watcher, listener and timer has an owner
  and a deterministic cleanup path.
- No secret enters browser persistence, logs, screenshots or the business DB.
- No visual shortcut may add business Electron IPC or Renderer Node access.
- No hidden fallback may silently change protocol, destination or overwrite
  behavior.
- Disabled or unsupported behavior is visible at the point of use and keeps its
  matrix item open.
