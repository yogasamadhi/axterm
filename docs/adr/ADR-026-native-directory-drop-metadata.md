# ADR-026: Native directory drop metadata

Date: 2026-10-05
Status: Accepted; source and independently installed macOS arm64 candidate verified on 2026-10-05.

## Context

The terminal currently rejects directory drops. Browser FileSystemEntry.fullPath is relative to
an isolated browser root, and Electron no longer adds an absolute File.path. Loading a dropped
folder requires the original native directory rather than a name or a temporary file copy.

## Decision

Keep Level 1, the independent utilityProcess Runtime, REST/OpenAPI and Host-owned File Grants.
The only Renderer/Main IPC remains desktop:bootstrap. Add no business IPC or process message.

Allow one local preload metadata accessor, desktopDirectoryDrop.takePaths(). It has no arguments,
performs no RPC, reads no file contents and exposes no Electron object or arbitrary path lookup.
A capture listener accepts only trusted native drop events containing exclusively directories,
up to 32 items. Electron webUtils.getPathForFile resolves their OS-backed File objects locally.
Paths are bounded to 4,096 characters, reject control characters and are consumed once within
one second. Every drop replaces the pending metadata; pagehide removes the listeners and clears
it. Synthetic File objects, mixed drops and missing paths yield no metadata. No paths are logged,
persisted or placed in a store. The accessor is separate from bootstrap discovery.

Renderer sends selected directory paths through the existing authenticated directory-path
File Grant REST operation. Host canonicalizes and verifies the directory; filesystem operations
continue to require generation-bound grants. The terminal's existing granted-paths REST action
accepts readable directory grants as well as readable file grants, quotes paths and inserts text
without Enter. Directory grants used for insertion are immediately revoked, including on failure,
cancellation, replacement or view teardown. No directory content is copied or uploaded.

The local file pane accepts one native directory drop and uses its existing directory selection
owner to load the canonical root and listing. Replacement and teardown revoke the grant, and
late results cannot replace a newer selection. Remote directory upload behavior remains governed
by the existing upload-directory action.

## Consequences and validation

MASTER_SPEC's preload restriction is clarified for this bounded local metadata accessor; all
transport, import and filesystem boundaries remain enforced. Architecture Gate only permits
webUtils.getPathForFile as the direct adapter passed to the dedicated trusted collector in the
entry preload; alias exports, other methods, arbitrary calls and imports elsewhere are rejected.
Headless has no native metadata accessor and retains its existing grant operations. Test bounded consumption, synthetic/mixed
rejection and unsafe paths; use real OS-backed directory Files in desktop and packaged Mac
journeys to verify full paths, quoting, no silent execution, actual listing and grant cleanup.
This decision does not claim Windows/Linux native verification.

Reference: [Electron webUtils](https://www.electronjs.org/docs/latest/api/web-utils).

Acceptance evidence: [STATUS](../implementation/STATUS.md), 2026-10-05 saved connection and native directory drop record.
