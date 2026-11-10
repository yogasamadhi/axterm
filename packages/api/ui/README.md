# @axterm/ui

Public Slots, observable store contracts and selected Axterm browser controls.
The package is ESM and targets React/ReactDOM 18.3.1. Host plugins may consume
common contracts and types; browser controls belong to the Client face.

```tsx
import {
  Button,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
  Input,
  Label,
} from '@axterm/ui/controls';

export function ConnectionForm() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Connect</Button>
      </DialogTrigger>
      <DialogContent closeLabel="Close">
        <DialogTitle>Connection</DialogTitle>
        <DialogDescription>Enter the destination host.</DialogDescription>
        <Label htmlFor="host">Host</Label>
        <Input id="host" autoComplete="off" />
        <DialogFooter>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

The platform provides one controls module and installs `controlsCssText` with the
UI renderer's lifetime. Importing controls does not mutate the DOM or mount a React
root. Contribute a component through your selected Slot; do not install another
stylesheet or bundle React/Radix into a Client factory.

Button accepts `primary`, `secondary`, `ghost` and `destructive` variants and
`default`, `small` and `icon` sizes. Inputs, labels, textareas, Dialog, Select, Tabs
and Tooltip forward their native/primitive refs and expose typed props. Use
`asChild` for trigger/action composition. Supply localized titles, descriptions,
labels and close actions; the shared package does not own feature translations.
Dialogs and selects use portals, focus management and keyboard behavior from Radix.
Controls use application `--ax-*` theme tokens with standalone fallbacks.

Business calls, state, credentials, IO and approvals remain in the owning plugin.
Neither a control nor the workspace UI contract grants access to private services.
The adapted upstream MIT notice is in LICENSE; Axterm additions are covered by
LICENSE.AXTERM. SOURCE.json records those boundaries. This engineering SDK is not a
public npm publication or a completed Level 3 product release.

`@axterm/ui/presentation` exposes pure Locale/Theme interfaces and the narrow
accepted-preference port. Client services retain `ctx.locale` and `ctx.theme`;
Configuration owns durable product preferences. Typed namespace registrations
require English, Japanese, Simplified Chinese and Traditional Chinese dictionaries.
Contribute dictionaries with an owned disposer, use the Slot's typed `t` seat, and
observe revisions for text outside Slots. Locale normalization is case-insensitive.
Built-in preference writes return promises and adopt accepted model facts; they
reject when their preference owner is unavailable or another write is pending.
No preference is stored in browser storage or changed optimistically.

Theme extensions register `--ax-*` tokens and two-mode override layers with an
owned disposer. Custom theme selection is transient, following the selected DSH
contract; dark/light/system are persisted through Configuration. Removing a layer
restores the covered layer, and stale disposers cannot remove a replacement.
Presentation services install no additional React root. Their provider unload
detaches observations, drains admitted writes and releases document/media effects.

The `@axterm/ui/preference` leaf exports `PresentationPreference` and its port for
admission, accepted-fact observation and write draining. Its runtime has no React,
Cordis, renderer or DOM dependency. Host code importing that leaf does not acquire
the presentation/Slots type graph. The presentation entry re-exports the port type.

`@axterm/ui/workspace` declares the selected workspace child Slots and arrangement
service. The platform also registers this entry as one shared browser module.
`workspace.tab-menu` is a root-scoped list Slot with a `tabId` owner for domain-owned menu items using the public dropdown controls. Contributions validate the target against their canonical Client model; Workspace contains no business lifecycle implementation.

`workspace.overlay` is a root-scoped list Slot for owner-controlled dialogs that
must remain available while users switch tabs or sidebars. Contribute through
`ctx.slots.inject` and release the returned registrations with the plugin scope;
Workspace renders the children and the UI renderer owns the sole React root.
Keep dialog facts and accepted commands in their domain Client owner. A generation
change must withdraw stale prompts; reconnect must never replay an answer.

`ctx.terminalWorkspaceUi.open(input, signal)` admits an explicit terminal request,
waits for its accepted facts and activates the owning view. It returns the terminal
ID; `activate(id)` selects an existing owned terminal view. `ctx.connectionWorkspaceUi`
owns `openSsh(connectionInput, { signal, terminal })`, including waiting for the
connection owner and its existing trust/authentication dialogs. Optional terminal
settings preserve bookmark/Profile references, dimensions, environment and other
validated creation fields. Each owner submits once, reserves bounded capacity,
actually joins canceled late creation/rollback, and preserves failed cleanup as an
error. These are Client UI capabilities, not Host services or an execution bypass.
Terminal draft insertion remains the separate capability that never appends Enter.

`ctx.connectionWorkspaceUi.openHistory(id, input, ifMatch, options)` uses the same
owned launch path and existing trust/authentication UI. Lost creation acknowledgments
retain command identity and bounded capacity until readonly reconciliation and actual
close succeed, or an observed replacement Host generation retires the old identity.
No automatic network-opening replay occurs.

`DialogContent asChild` accepts one feature-owned element, such as a `section`,
and keeps that element as the accessible dialog surface. Its title and body remain
inside that element. An optional `closeLabel` appends the shared close action
inside the same surface; omitting it permits a feature-owned close action.

`ctx.terminalSessionUi` selects the Terminals owner's explicit disconnect, reload,
duplicate/next-pane and connection-cancellation actions. These methods fence the
captured generation, use the canonical models and generated Remote, and retain
unknown admission/cleanup responsibility. Disconnect drains the native resource
while preserving its bounded read-only tab/output. Reload replaces a resource;
it does not retry a failed byte transport. Only the owning plugin retains the
opt-in SSH reload screen/cwd snapshot, bounded and cleared at generation change.

`workspace.auxiliary` is a root-scoped list Slot beside the main workspace;
`workspace.monitor` is a root-scoped list Slot inside its main surface. They
compose the selected information/monitor UI without mounting another React root.
Contributions retain their own model/observation/disposer and release it when the
selected resource or generation changes. Settings contributions use the existing
`settings.terminal` Slot and Configuration-owned accepted preference commands.

`@axterm/ui/workspace` also defines optional selected `aiCommandSuggestionsUi` and
`terminalHistoryUi` capabilities. Explicit command generation captures the accepted
model, terminal and generation and supports cancellation with actual Run drain.
Consumers treat visible output as a draft; insertion never executes it. History
deletions carry the reviewed id/version/generation to the existing owner; history
suggestions derive from its complete bounded facts baseline. These capabilities
expose no Engine handle, terminal bytes or private implementation.

`@axterm/ui/shortcuts` defines `ctx.shortcuts`, command/fixed contributions,
observable catalogs, revision-checked edits, recording and an owned accepted
preference seat. Each contribution returns a disposer. Resolvers capture their
feature's current target before execution; use selected owner services for
business work. DSH profile restrictions and fixed reservations remain visible.
There is no browser preference storage or additional React root.

`shortcuts.gesture-rows` and `shortcuts.gesture-editor` are selected list Slots owned by the shortcut reference surface. Their typed seat supplies current editor selection and original style names. The contributing feature owns accepted preferences, explicit review, generation fencing, recording and cleanup. Wheel gestures stay outside DSH physical codes.

`ctx.shortcuts.resolveCommand(id, context)` captures the existing DSH menu resolver before a command surface takes focus. A retired registration rejects a captured invocation. `ctx.workspacePaletteUi.registerSource(id, read)` contributes current presentation entries from the source owner, returning a disposer. Sources retain generation checks, command admission and actual drain; the palette stores only bounded opaque usage metadata and never dispatches business work centrally.

`ctx.shortcuts.registerConflictSource(read)` supplies readonly metadata for candidate review. It returns a disposer, gives existing effective application bindings precedence, and adds optional `referenceLabels` to `describeBinding`. References never register physical execution, fixed reservations or native definitions. The source must derive current canonical facts and preserve its own metadata ownership.

`shortcuts.footer` is an owned list Slot with the shortcut reference seat. Native visibility-key editors use its shared editor selection, acknowledge/release `ctx.shortcuts.recording`, and consult the same current conflict descriptions. Recording temporarily releases the application global key; it does not create another keyboard registry. Desktop preference forms retain only private reviewed drafts and adopt facts from their owner model.

`ctx.desktopWindowUi.getState()` reads transient presentation of the exact owning trusted window. Native minimize/maximize/fullscreen actions stay on its generation-fenced, closed Shell capability; close also requires the accepted shortcut revision. `zoom-in`/`zoom-out` retain durable Host ownership. Consumers bound and drain actual requests and discard reads superseded by a later action. These methods expose no business service or native object.

Selected workspace presentation also exposes `workspace.section-toolbar` as a root-scoped list with `WorkspacePanelOwner`. Register your navigation with `view: 'section', chrome: 'settings'` for the retained full-page settings chrome; each plugin owns its own ordered button and UI selection. This slot carries no business methods or shared domain state. Remove navigation, actions and slot contributions on unload. Closing a section returns to the workspace and preserves hidden sessions.

DialogContent preserves a visible connected opener for controlled dialogs opened by an action as well as DialogTrigger. Feature onOpenAutoFocus/onCloseAutoFocus callbacks remain authoritative; preventDefault suppresses fallback focus restoration. Detached or hidden controls are never focused.

`terminal.context-menu` is a root-scoped list Slot with only a `tabId` owner.
Its entries validate that target in their canonical model and use the public
DropdownMenu controls. Terminals renders it inside the existing native-selection
menu; recording/log contributions share their existing command owner with the
workspace tab menu.

Optional `ctx.aiTerminalExplanationUi.open({terminalId, generation, selection}, signal)`
prepares a bounded selection preview and opens an inspectable AI draft. It returns
`unconfigured` when no model is configured. It never starts a Run or executes a
command. The AI owner verifies generation and current target, aborts stale previews,
keeps only Host-redacted text in the draft, and drains on unload (ADR-176).

`terminalViewUi.captureContext(tabId)` returns an opaque bounded selection context.
React receives only availability and run/dispose operations; the text remains in
Terminals. Dispose it on menu close/replacement. Admit a selected operation before
disposing the menu context; the View's own lifetime still cancels/drains that work.
Keyboard `terminalViewUi.run` reads live selection instead. A retired context can
never deliver to a replacement View. Copy/paste keep the fixed input registry and
Terminals' existing platform/IME/Windows interruption ownership.

The selected `WorkspaceArrangementUi` contract in `@axterm/ui/workspace` includes
`swapPanes(left, right)` with zero-based pane indices. It swaps complete pane
batches while retaining live registrations, selection, titles, pins and tab
numbers. Invalid or retired targets are rejected. This is presentation state;
it does not start, close or replay application sessions. The owning workspace
persists it through the existing Configuration model and receipt boundary.

Shortcut contributions may set the optional `messageKey` from the shared
`ShortcutMessageKey` catalog. The registry keeps its four built-in translations
searchable alongside explicit aliases; plugins with private labels supply their
own aliases. Fixed input reservations remain read-only and may expose these
aliases as metadata. Features retain their own palette actions and target
resolution; the terminal plugin owns clipboard palette invocations, cancellation
and selection checks. No business invocation is added to native input metadata.

`workspace.empty.actions` and `workspace.empty.content` are selected root-scoped list children of the built-in `workspace.empty` surface. Their owner is only `{ section, activeTabId }` (`WorkspacePanelOwner`). Actions appear beside the existing new-terminal button; content appears below that row. Each contribution retains its own locale and disposer. Pass only the declared owner fields when rendering a child; do not spread parent component props such as `t` or `renderSlot`, which belong to the receiving contribution. Domain calls continue through selected owners, and these Slots provide no business authority.
