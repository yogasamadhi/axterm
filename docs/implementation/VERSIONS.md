# Resolved dependency versions

Verified: 2026-09-13. Direct versions are exact; all transitive resolutions are
recorded in `bun.lock`.

Tooling host: Bun 1.4.0, Node 24.18.0, macOS arm64. Desktop Runtime uses the Node
embedded in Electron 44.3.0. Electron-builder 27 still has no accepted stable build
for this repository, so 26.16.1 remains the temporary exception recorded by
[ADR-001](../adr/ADR-001-foundation-toolchain.md).

## Root tooling

| Dependency                    | Version |
| ----------------------------- | ------- |
| `@electron/rebuild`           | 4.2.0   |
| `@eslint/js`                  | 10.0.1  |
| `@playwright/test`            | 1.63.0  |
| `@types/node`                 | 24.13.4 |
| `@types/pngjs`                | 6.0.5   |
| `@types/ssh2`                 | 1.15.5  |
| `@types/ws`                   | 8.18.1  |
| `dependency-cruiser`          | 18.2.0  |
| `drizzle-kit`                 | 0.31.10 |
| `esbuild`                     | 0.28.2  |
| `eslint`                      | 10.10.0 |
| `eslint-config-prettier`      | 10.1.8  |
| `eslint-plugin-react-hooks`   | 7.1.1   |
| `eslint-plugin-react-refresh` | 0.5.6   |
| `node-gyp`                    | 12.4.0  |
| `prettier`                    | 3.9.6   |
| `pixelmatch`                  | 7.2.0   |
| `pngjs`                       | 7.0.0   |
| `typescript`                  | 5.9.3   |
| `typescript-eslint`           | 8.70.0  |
| `vitest`                      | 5.0.0   |
| `ws`                          | 8.21.3  |

## Desktop

| Dependency                          | Version | Kind            |
| ----------------------------------- | ------- | --------------- |
| `electron`                          | 44.3.0  | development     |
| `electron-vite`                     | 5.0.0   | development     |
| `electron-builder`                  | 26.16.1 | development     |
| `vite`                              | 7.3.6   | development     |
| `@vitejs/plugin-react`              | 5.2.0   | development     |
| `react` / `react-dom`               | 19.3.0  | runtime         |
| `tailwindcss` / `@tailwindcss/vite` | 4.3.3   | development     |
| `@base-ui/react`                    | 1.8.0   | runtime         |
| `@tanstack/react-query`             | 5.102.8 | runtime         |
| `zustand`                           | 5.0.15  | runtime         |
| `@fontsource/maple-mono`            | 5.3.0   | runtime         |
| `@xterm/xterm`                      | 6.0.0   | runtime         |
| `@xterm/addon-fit`                  | 0.11.0  | runtime         |
| `@xterm/addon-search`               | 0.16.0  | runtime         |
| `@xterm/addon-serialize`            | 0.14.0  | runtime         |
| `@xterm/addon-web-links`            | 0.12.0  | runtime         |
| `@xterm/addon-webgl`                | 0.19.0  | runtime         |
| `@xterm/addon-unicode11`            | 0.9.0   | runtime         |
| `@xterm/addon-ligatures`            | 0.10.0  | runtime         |
| `@xterm/addon-image`                | 0.9.0   | runtime         |
| `@codemirror/commands`              | 6.10.1  | runtime         |
| `@codemirror/state`                 | 6.7.4   | runtime         |
| `@codemirror/view`                  | 6.43.11 | runtime         |
| `ironrdp-wasm`                      | 1.1.0   | runtime/WASM    |
| `@novnc/novnc`                      | 1.7.0   | runtime         |
| `spice-client`                      | 1.2.0   | runtime/browser |
| `node-pty`                          | 1.1.0   | runtime/native  |
| `serialport`                        | 13.0.0  | runtime/native  |
| `ssh2`                              | 1.17.0  | runtime         |
| `ws`                                | 8.21.3  | runtime         |
| `lucide-react`                      | 1.44.0  | runtime         |
| `class-variance-authority`          | 0.7.1   | runtime         |
| `clsx`                              | 2.1.1   | runtime         |
| `tailwind-merge`                    | 3.6.0   | runtime         |
| `@types/react` / `@types/react-dom` | 19.3.0  | development     |

## Runtime

| Dependency          | Version |
| ------------------- | ------- |
| `@hono/node-server` | 2.1.1   |
| `@hono/zod-openapi` | 1.6.3   |
| `@xterm/headless`   | 6.0.0   |
| `@electerm/ftp-srv` | 1.0.5   |
| `basic-ftp`         | 6.2.1   |
| `hono`              | 4.13.7  |
| `zod`               | 4.6.1   |
| `drizzle-orm`       | 0.45.2  |
| `iconv-lite`        | 0.7.2   |
| `node-pty`          | 1.1.0   |
| `serialport`        | 13.0.0  |
| `ssh2`              | 1.17.0  |
| `tar`               | 7.5.22  |
| `trzsz2`            | 1.2.0   |
| `zmodem2`           | 1.4.0   |
| `ws`                | 8.21.3  |
| `pino`              | 10.3.1  |

## Contracts, client and database schema

| Package                | Dependency           | Version |
| ---------------------- | -------------------- | ------- |
| `@workspace/contracts` | `zod`                | 4.6.1   |
| `@workspace/client`    | `openapi-fetch`      | 0.17.0  |
| `@workspace/client`    | `openapi-typescript` | 7.13.0  |
| `@workspace/db-schema` | `drizzle-orm`        | 0.45.2  |

Workspace package versions are all `0.10.0`. Internal edges use `workspace:*`.

SQLite schema migration 25 adds the ordered Quick Command folder aggregate, command placement
columns and its independent tree revision. Legacy flat command payloads are read as one-step
commands without rewriting or losing their original text.

SQLite schema migration 26 adds the bounded per-Bookmark `quick_commands_payload` JSON array. It
defaults existing Bookmarks to an empty list and remains distinct from the ordered global Quick Command
aggregate.

SQLite schema migration 27 adds the Batch Operation history aggregate, its target/step summary payload
and updated-time index. Unfinished rows are recovered as interrupted without re-executing commands;
command text and remote output are deliberately absent from the persistent payload.

SQLite schema migration 28 adds the revisioned global `automation_triggers` aggregate and the bounded
`bookmarks.triggers_payload` array. Existing Bookmarks receive an empty list. Global rule mutations and
Bookmark rule mutations stay in their respective transactions; persistent events store only safe
identifiers, names and counts rather than match patterns, terminal output or sent text.

G-06 extends each SSH startup script object inside the existing Host JSON payload with `sendEnter`,
`waitForOutput`, `settleIdleMs` and `settleTimeoutMs`. Zod defaults preserve every older row on read and
write, so this compatible nested-payload change does not require a new SQLite migration. OpenAPI and the
generated client carry the expanded shape.

G-07 adds the read-only `terminal.information` capability and
`GET /api/v1/terminals/{id}/information` Contract operation. Its bounded per-session samples and CPU
history are memory-only, so no SQLite migration or dependency change is required. OpenAPI and the
generated client carry the typed group states and payloads.

G-08 adds the `monitor` Settings section for Terminal Information groups plus Remote Monitor enabled
state and ordered items. `app_settings` already stores extensible section rows and the Contract supplies
safe defaults when an older database has no `monitor` row, so no SQLite migration or dependency change
is required. OpenAPI and the generated client carry the new settings shape.

G-09 through G-11 add the memory-only Widget catalog and instance registry, reviewed File Renamer,
Static File Server, FTP Server and SSH/SFTP Server Contracts. The services use generation-bound Desktop
File Grants and do not persist instance configuration or credentials, so no SQLite migration is required.
`@electerm/ftp-srv` 1.0.5 is the exact MIT-licensed FTP server package pinned by Electerm 5.5.0; it is
bundled only into the independent Runtime. SSH/SFTP reuses the existing `ssh2` 1.17.0 and `node-pty`
1.1.0 adapters and introduces no new native module.

G-12 adds no dependency or database migration. The root launcher and Electron Main share a bounded
TypeScript command-line parser; Main converts requested private-key, directory and batch-operation paths
into generation-bound Host File Grants before reusing the existing deep-link ingress. Native batch JSON
uses the existing migration-27 service, while the compatibility translator maps command-only Electerm
workflows to saved SSH Bookmarks without persisting embedded credentials. `--server-port` remains an
explicit compatibility exception so the Runtime keeps its loopback, OS-assigned-port invariant.

H-01 adds `privacy.hideAddresses` to the existing `privacy` Settings JSON section. Zod backfills false
for older rows and sparse updates merge it independently, so no SQLite migration or dependency change is
required. The Renderer applies the setting only to user-visible address labels; Runtime adapters retain
the canonical destination needed to connect.

H-03 adds SQLite migration 29 with the `terminal_themes` JSON entity table. Two Axterm defaults and the
310 entries from Electerm's MIT `@electerm/electerm-themes@1.0.1` catalog are deterministic read-only
Runtime resources and therefore create no seed-row migration risk; only user-created/imported clones are
persisted with normal entity versions and Domain Events. The catalog is committed as generated TypeScript,
so packaged builds do not depend on the submodule or add a production package. Run
`bun run generate:electerm-themes` after updating Electerm. Import/export reuse the existing UTF-8 File
Grant client, a 64 KiB theme limit and an atomic mode-0600 temporary-file replacement.

J-01 adds no schema migration or dependency. `ProductDatabase.appendEvent` now retains the newest
10,000 monotonic Domain Event cursors, and `ProductRepository.recordIdempotency` applies a default
2,000-receipt limit per operation. The Phase 21 soak entry uses the existing digest-pinned OpenSSH
fixture and production Runtime adapters; its report is runtime evidence rather than product data.

H-12 adds no dependency or database migration. Desktop Main uses Node's built-in Fetch, Ed25519,
SHA-256 and bounded filesystem streams behind the Host Capability boundary. The provider remains
disabled without an explicit manifest URL and public verification key; its protocol and release
requirements are recorded in `SIGNED_UPDATE_FEED.md` and ADR-015.

## Native and optional dependency policy

`iconv-lite` is the Runtime-only, pure-JavaScript terminal input codec pinned to the
same release used by the Electerm 5.5.0 baseline. `@xterm/headless` is the
Runtime-only VT parser used to turn terminal output into bounded session-log lines;
its version matches the Renderer xterm parser. On macOS, `scripts/prepare-native.mjs` builds the
patched `node-pty` source for the current development Node ABI and records the source hash/ABI marker;
`node-pty` and `@serialport/bindings-cpp` are rebuilt explicitly for Electron by
`scripts/rebuild-native.mjs` before packaging. The Electron rebuild deletes all Node ABI markers,
and `scripts/package-desktop.mjs` restores an exact pre-build snapshot after electron-builder has
copied the Electron artifacts. Unit regressions cover successful restoration, missing-build cleanup,
idempotency and direct marker invalidation, so packaging cannot leave the workspace on the wrong ABI.
`zmodem2` and `trzsz2` are Runtime-only pure-JavaScript protocol engines pinned to the Electerm 5.5.0 baseline; the adapted XMODEM state machine has no additional dependency. Their protocol ownership and file-safety boundary are recorded in ADR-013. The native modules' loadable binaries and the PTY helper remain outside ASAR and are verified by
packaged native smoke tests. `ssh2`'s optional `cpu-features` accelerator is excluded;
ssh2's JavaScript implementation is the supported path. See
[PACKAGING](PACKAGING.md).

`@electerm/ftp-srv` is a Runtime-only pure-JavaScript dependency. Axterm wraps it with a scoped
FileSystem, loopback defaults, bounded passive ports/connections/timeouts and deterministic shutdown;
package-global signal handlers and credential-bearing service URLs are not used.

The local SSH Server Widget generates its ephemeral host identity with Node's P-256 SEC1 exporter.
This avoids an intermittent `ssh2` 1.17 OpenSSH Ed25519 writer/parser mismatch while keeping the key
memory-only and instance-scoped; a 128-start regression test exercises the exact server startup path.

`patches/trzsz2@1.2.0.patch` corrects only the package's missing top-level TypeScript
declaration path to the declaration file already shipped under `dist/esm/lib`.
Executable protocol code is unchanged.

`patches/node-pty@1.1.0.patch` fixes a macOS native descriptor leak in the package's
`pty_posix_spawn` guard loop. The upstream loop did not count or close the first temporary PTY file
descriptor, so a long-lived process failed after about 511 local-terminal creations on the current
host. The patch corrects the count and reverse close index only. A 729-cycle accelerated real-PTY
workload now passes beyond the former deterministic 506-cycle failure and returns every owner to
zero. `node-gyp` is a build-only dependency used to compile this patched source for development;
it is not shipped or required on end-user machines.

## Upstream submodule

`vendor/electerm` package version 5.5.0 is pinned at
`799bedef98c1deae676ae03041719de98d3b57f1` under the MIT license. Its dependency
graph is not installed into the Axterm workspace. This is also the fixed
functional and UI/UX acceptance baseline selected by
[ADR-003](../adr/ADR-003-electerm-parity-program.md). Adaptation provenance is in
[UPSTREAM](UPSTREAM.md).
