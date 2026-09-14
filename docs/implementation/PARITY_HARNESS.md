# Electerm parity harness

Updated: 2026-09-14  
Reference: Electerm 5.5.0 at `799bedef98c1deae676ae03041719de98d3b57f1`

The harness compares the pinned vendored reference with Axterm without shipping
Electerm or importing its runtime into the product. It owns the Phase 11 scenario
inventory, reference screenshots, interaction traces, visual reports, default
setting/action maps and protocol fixture interfaces.
The order in which those scenarios become implementation work is defined by
[ELECTERM_PARITY_ROADMAP](ELECTERM_PARITY_ROADMAP.md).

## Prepare the reference

Initialize the submodule, then run:

```sh
bun run parity:prepare:electerm
```

Electerm's upstream `package-lock.json` is not synchronized with its 5.5.0
`package.json`, so the preparation script deliberately installs the fixed
package manifest with `--no-package-lock --legacy-peer-deps`. These dependencies
remain below the submodule's ignored `node_modules` and `work` directories and
never enter the Axterm lockfile or installer. If the Electron CDN is unavailable,
the caller may provide npm's `ELECTRON_MIRROR` environment variable.

The reference app normally enumerates the macOS login keychain for system CAs
and uses Electron `safeStorage`. Parity capture needs neither. The launcher loads
`electerm-reference-preload.cjs` before Electerm, blocks its
`security find-certificate` invocation and substitutes the reference
`safe-storage.js` module inside the disposable profile. This guard is scoped by
`AXTERM_ELECTERM_PARITY=1`; it does not modify the submodule or Axterm product
runtime. Every reference launch uses the vendored Electron entry, a disposable
`user-data-dir`, XDG directories, and a fixed preload. It cannot be
redirected to an installed Electerm executable or inherit another Node preload.
No parity command may prompt for or read a system keychain.

## Audit and capture

```sh
bun run parity:audit
bun run parity:capture:electerm -- --scenario bookmarks.tree
bun run parity:capture:axterm -- --scenario bookmarks.tree
bun run parity:capture:phase16
bun run parity:capture:phase17
bun run parity:capture:phase18
bun run parity:trace:audit
bun run parity:diff -- \
  --reference tests/parity/screenshots/electerm \
  --candidate tests/parity/screenshots/axterm \
  --output test-results/parity-diff
```

Capture currently drives the four real Phase 12 surfaces; the Phase 13
`bookmarks.tree`, `bookmarks.search`, `bookmarks.drag-target`,
`bookmarks.connection-history`, `bookmarks.command-history`,
`bookmarks.connection-profiles`, `bookmarks.ssh-config-import` and `bookmarks.forms`
surfaces; the Phase 14 `terminal.basic`, `terminal.productivity` and
`terminal.addons-settings` surfaces; the Phase 15 `ssh.authentication`, `ssh.network`
and `ssh.tunnels-sftp` surfaces; the Phase 16 `files.browse-operate`, `files.transfers`
and `files.edit-inspect` live-SFTP surfaces; the Phase 17 FTP, Telnet, Serial, RDP, VNC,
SPICE and Web/Deep Link forms plus the `terminal.transfer-protocols` live transfer surface;
the Phase 18 Quick Command/Batch, Trigger, Terminal Information/Monitor and Static File Server
Widget surfaces; the Phase 19 settings, theme, Shortcut, sync, LTR and RTL surfaces; the Phase 20
Provider modal, chat/context, Agent tool-card and MCP Widget surfaces; and the three Phase 21
resilience, platform/upgrade and accessibility certification UI surfaces. Pass one scenario ID explicitly; omitting
it captures only `shell.chrome-empty`. Each scenario is captured at 1280×800,
1440×900 and 1920×1080.
Every viewport launches with a fresh local
profile, applies its viewport before preparing the state, and waits until layout
and xterm bounding boxes remain stable for at least ten consecutive 100 ms samples.
After fonts load, the driver asks the target to run its normal resize path before
sampling; scenarios that retain the startup terminal also wait for that visible
session before destructive setup. Capturing all 48 visual scenarios produces
144 paired PNGs and 144 viewport-specific Playwright traces per target. Axterm also retains 12
packaged-app journey screenshots outside the paired viewport corpus. This isolation
recreates transient menus at
each viewport and keeps resized terminals, tabs and workspaces from leaking across
captures.
`shell.chrome-empty` closes the startup terminal in both products and waits for
the real no-session surface; it is no longer an active-terminal screenshot labelled
as empty. Scenario drivers are added when their owning Phase implements the state;
the manifest already assigns every one of the 122 matrix rows to one or more
scenarios. A missing driver fails with an explicit error instead of producing a
misleading copy of the empty screen.

For the pinned 2026-09-12 Phase 12–13 corpus, all thirty-six viewport/scenario pairs passed
the former, stricter 1.5% threshold and therefore pass the current 95% similarity rule. The worst pair is compact `bookmarks.forms`
at 1.3613%;
the bookmark tree passes at 1.139%/0.812%/0.550%, its filtered state at
1.155%/0.826%/0.602%, its drag target at 0.979%/0.813%/0.550%, and connection history at
1.151%/1.041%/0.634%. The populated frequency-sorted command-history popover passes at
1.138%/0.935%/0.627% for compact/reference/wide. The Connection Profile list/editor passes at
1.2695%/1.1415%/0.9092% and records exact tab, field and control geometry plus computed
typography colors. SSH Config preview/item actions pass at 1.0012%/0.8326%/0.5992%; the
driver exercises the real File Grant and Runtime preview route before collapsing the sidebar.
The full-window SSH Bookmark form passes at 1.3613%/1.2687%/1.2094%; its candidate driver
opens the real Host manager/editor, focuses the Host field and seeds only the disposable Runtime
database, while the reference driver invokes Electerm's real `onNewSsh` route. The form scene
suppresses Electerm's unrelated startup SSH Config notification and excludes product-specific
dynamic masks instead of hiding form content.
The command-history and SSH Config drivers use an in-page
terminal backdrop because Playwright's native screenshot mask would otherwise paint over the
real overlay; the backdrop covers exactly the reference terminal surface and remains below both
products' overlay stacking contexts. The exact per-image pixel counts and ratios are stored in
`test-results/parity-diff/report.json`, with
the compared images below `tests/parity/screenshots/{electerm,axterm}`. Reference
preparation also disables Electerm's startup upgrade check for every deterministic scene so an
unrelated updater panel cannot change its layout.

The Phase 16 wrapper builds and starts one disposable Docker OpenSSH fixture, exposes only a random
loopback port, and runs both real products against it. Each viewport receives a fresh profile and
authorized local directory. `files.browse-operate` opens the live split SFTP workspace with
multi-selection and the native product context menu; `files.transfers` moves a sparse 128 MiB file
through the real SFTP stream and opens each product's transfer-center/history surface; and
`files.edit-inspect` loads the same remote UTF-8 file into each product's editor and searches its
contents. The nine pairs pass at 95.171%–98.166%, and the wrapper removes the container on success,
failure or interruption.

The Phase 17 form drivers enter each protocol through Axterm's real New Bookmark workspace and
Electerm's real `onNewSsh` form, then fill the same representative target fields. Every disposable
reference profile resets its bookmark tree before capture, so a prior SSH/SFTP fixture cannot leak
unrelated rows into protocol evidence. Axterm retains the full bookmark directory and protocol
context behind the focused editor; closing or saving returns to the main workspace, while
Save-and-Connect opens the session. FTP, Telnet, Serial, RDP, VNC, SPICE and Web/Deep Link produce 21 comparisons at
95.642%–97.513% similarity. `terminal.transfer-protocols` does not render a demo state: the driver
observes the current generation's authenticated Runtime session, streams a 256 KiB browser file into
a real Desktop Host File Grant, starts the XMODEM Application workflow and lets the live local PTY emit
the CRC peer byte. The reference uses Electerm's own test-controlled native-file selection path and
XMODEM client against its local terminal. Both products reach real transfer progress before their
terminal menus open; those three comparisons pass at 97.933%–98.935%.
The Phase 18 wrapper drives the actual Quick Command multi-step editor, global Trigger editor,
Terminal Information side panel and Static File Server Widget form in both products. It selects
the same Widget instead of accepting whichever upstream list item happens to sort first. Dynamic
terminal masks are disabled when an opaque workspace or drawer hides the terminal; the monitor
driver activates the real terminal before opening its information panel. The new ranges are
95.089%–97.253% for Quick Command/Batch, 95.092%–97.147% for Trigger, 96.724%–98.460% for
Terminal Information/Monitor, and 95.623%–97.233% for the Static File Server Widget.
The capture also exposed and fixed a real compact-layout defect where the English `Manage` action
was forced into a 24 px icon width. The complete 48-scene report contains 144 passing comparisons
with a 95.089% minimum, and the Axterm metadata contains 1008/1008 passing hard-defect checks.

The Phase 19–21 wrappers are `bun run parity:capture:phase19`,
`bun run parity:capture:phase20` and `bun run parity:capture:phase21`. Phase 19 adds the WebDAV
sync form and completes six settings scenes. Phase 20 captures the real Provider modal, bounded
chat composer, persisted canceled response with retained partial output, Agent approval cards and MCP tool selection. The Provider range is
95.340%–95.868%, chat/context is 97.008%–98.452%, canceled chat is 96.600%–98.196%, Agent state is 95.926%–98.134% and MCP is
95.543%–96.822%. Phase 21's real SSH disconnect/reconnect scene passes at 98.931%–99.410%, while its
updater/diagnostics and accessibility settings surfaces pass at 96.444%–97.020%; these are UI evidence and do not replace signed-channel, long-run or
Windows/Linux installation evidence.

`withInteractionTrace` sanitizes every archive immediately after Playwright closes it. Authorization
credentials and JSON bootstrap/session/password/passphrase/private-key/API-key fields are replaced
inside textual trace entries before the disposable application profile is removed. The generation
credential used by the live XMODEM driver remains in the Node capture process and is never passed as
a Renderer evaluation argument. `parity:trace:audit` independently opens all 288 current target
archives and fails if any supported credential representation remains; `parity:audit` runs the same
gate as part of the normal repository check. `parity:trace:sanitize` is the explicit repair command
for evidence produced before this rule was introduced.

The H-11 localization drivers switch Axterm through its real persisted Settings route and switch
the pinned reference through its real configuration store. English LTR and Arabic RTL each produce
three PNGs, three traces and geometry metadata per target. The macOS arm64 corpus is committed under
`tests/parity/screenshots/{electerm,axterm}`. Manual review fixed Axterm's RTL settings-tab overlap
and bounded long diagnostic labels. RTL keeps the same physical desktop chrome as Electerm while
Arabic content keeps its RTL reading direction. The dedicated report at
`test-results/parity-diff-h11/report.json` records 96.660%–97.143% similarity, so all six scenes pass
the 95% visual rule. Each Axterm record also evaluates the seven hard-defect checks and fails capture
on overlap, clipping, insufficient primary-control contrast, viewport escape, direction mismatch,
broken keyboard focus or a language selection that did not persist.

`parity:audit` writes `test-results/parity-audit.json`. It checks the exact Git
revision and package version, all scenario source paths, all matrix coverage,
every top-level upstream setting, every active default shortcut, every token and every committed
interaction trace's credential redaction.
The report distinguishes source entries with no mapping from mapped entries whose
Axterm behavior is still missing. The current report has zero unmapped source
entries, with 0 settings and 0 actions still unimplemented. The 72 settings are
classified as 50 implemented and 22 partial; partial entries remain visible until
their complete behavior and platform evidence are certified.

`parity:diff` writes per-viewport PNG diffs and `report.json`. Every image must have
at least 95% similarity, equivalent to at most 5% differing pixels; edge geometry
additionally has a four-CSS-pixel tolerance in manual review. Passing the number does
not override the manifest's hard-defect checklist. Dynamic regions may only use the
selectors or rectangles declared in `electerm-scenarios.json`.

## Evidence locations

- Manifest: `tests/parity/electerm-scenarios.json`
- Setting map: `tests/parity/electerm-settings-map.json`
- Action map: `tests/parity/electerm-actions-map.json`
- Golden images and traces: `tests/parity/screenshots/{electerm,axterm}`
- Visual report: `test-results/parity-diff/report.json`
- Audit/evidence index: `test-results/parity-audit.json`
- Protocol fixture registry: `tests/fixtures/protocols/registry.ts`
- Human acceptance inventory: `docs/implementation/ELECTERM_PARITY_MATRIX.md`

All fixture credentials are synthetic. Captures and traces must never use a
developer's real hosts, credentials, terminal history or AI keys.
