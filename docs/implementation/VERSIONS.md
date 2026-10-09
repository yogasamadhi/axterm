# Resolved dependency versions

Verified: 2026-09-25. Direct versions are exact; all transitive resolutions are
recorded in `bun.lock`.

Tooling host: Bun 1.4.0, Node 24.18.0, macOS arm64. Desktop Runtime uses the Node
embedded in Electron 44.3.0. Electron-builder 27 still has no accepted stable build
for this repository, so 26.16.1 remains the temporary exception recorded by
[ADR-001](../adr/ADR-001-foundation-toolchain.md).

The Linux AppImage payload gate additionally requires the release-host
`unsquashfs` CLI from `squashfs-tools`. Local static validation used Homebrew
`squashfs` 4.7.5 on macOS arm64; Linux CI installs Ubuntu's
`squashfs-tools` with its other native/Xvfb prerequisites. This is a release-
host extraction tool, not an Axterm runtime or Bun dependency, and the gate
does not execute the AppImage's x64 runtime under macOS emulation.

The exception was revalidated against the primary npm registry on 2026-09-22:
`latest` is `26.15.3`, `v26` is `26.16.1`, `next` is `27.0.0-alpha.8`, and the
published version list contains no stable `27.x` semver (only
`27.0.0-alpha.0` through `27.0.0-alpha.8`). The local npm default points to a
mirror, so the verification explicitly used `--registry=https://registry.npmjs.org/`.
Do not replace the stable pin with an alpha; re-evaluate the exception when the
primary registry publishes a stable 27.x, then run the three-platform packaged
and native-module gates required by ADR-001.

## Root tooling

| Dependency                    | Version |
| ----------------------------- | ------- |
| `@electron/rebuild`           | 4.2.0   |
| `@eslint/js`                  | 10.0.1  |
| `@playwright/test`            | 1.63.0  |
| `axe-core`                    | 4.13.0  |
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

## Security override

| Resolution                            | Version | Reason                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every `esbuild` transitive resolution | 0.28.2  | Root Bun `overrides` forces the already-pinned direct version across the graph. `drizzle-kit@0.31.10` still depends on deprecated `@esbuild-kit/esm-loader`, whose declared `~0.18.20` resolution is affected by GHSA-67mh-4wv8-2f99; the verified patched line begins at 0.25.0. Keep this override until an upstream update removes the vulnerable chain and a fresh audit/CLI/build verification approves its removal. |

## Desktop

| Dependency                             | Version | Kind            |
| -------------------------------------- | ------- | --------------- |
| `electron`                             | 44.3.0  | development     |
| `electron-vite`                        | 5.0.0   | development     |
| `electron-builder`                     | 26.16.1 | development     |
| `vite`                                 | 7.3.6   | development     |
| `@vitejs/plugin-react`                 | 5.2.0   | development     |
| `react` / `react-dom`                  | 19.3.0  | runtime         |
| `tailwindcss` / `@tailwindcss/vite`    | 4.3.3   | development     |
| `@base-ui/react`                       | 1.8.0   | runtime         |
| `@tanstack/react-query`                | 5.102.8 | runtime         |
| `zustand`                              | 5.0.15  | runtime         |
| `@fontsource/maple-mono`               | 5.3.0   | runtime         |
| `@xterm/xterm`                         | 6.0.0   | runtime         |
| `@xterm/addon-fit`                     | 0.11.0  | runtime         |
| `@xterm/addon-search`                  | 0.16.0  | runtime         |
| `@xterm/addon-serialize`               | 0.14.0  | runtime         |
| `@xterm/addon-web-links`               | 0.12.0  | runtime         |
| `@xterm/addon-webgl`                   | 0.19.0  | runtime         |
| `@xterm/addon-unicode11`               | 0.9.0   | runtime         |
| `@xterm/addon-ligatures`               | 0.10.0  | runtime         |
| `@xterm/addon-image`                   | 0.9.0   | runtime         |
| `@codemirror/commands`                 | 6.10.1  | runtime         |
| `@codemirror/state`                    | 6.7.4   | runtime         |
| `@codemirror/view`                     | 6.43.11 | runtime         |
| `@devolutions/iron-remote-desktop-rdp` | 0.7.0   | runtime/WASM    |
| `@novnc/novnc`                         | 1.7.0   | runtime         |
| `@openclaw/fs-safe`                    | 0.13.1  | runtime/native  |
| `spice-client`                         | 1.2.0   | runtime/browser |
| `node-pty`                             | 1.1.0   | runtime/native  |
| `serialport`                           | 13.0.0  | runtime/native  |
| `ssh2`                                 | 1.17.0  | runtime         |
| `ws`                                   | 8.21.3  | runtime         |
| `lucide-react`                         | 1.44.0  | runtime         |
| `class-variance-authority`             | 0.7.1   | runtime         |
| `clsx`                                 | 2.1.1   | runtime         |
| `tailwind-merge`                       | 3.6.0   | runtime         |
| `@types/react` / `@types/react-dom`    | 19.3.0  | development     |

## Runtime

| Dependency          | Version |
| ------------------- | ------- |
| `@hono/node-server` | 2.1.1   |
| `@hono/zod-openapi` | 1.6.3   |
| `@openclaw/fs-safe` | 0.13.1  |
| `@xterm/headless`   | 6.0.0   |
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
The original G-11 implementation bundled `@legacy-prototype/ftp-srv` 1.0.5 in the Runtime;
ADR-016's P-03 transition removes it in favor of Axterm's independent Node FTP
adapter. SSH/SFTP reuses the existing `ssh2` 1.17.0 and `node-pty`
1.1.0 adapters and introduces no new native module.

G-12 adds no dependency or database migration. The root launcher and Electron Main share a bounded
TypeScript command-line parser; Main converts requested private-key, directory and batch-operation paths
into generation-bound Host File Grants before reusing the existing deep-link ingress. Native batch JSON
uses the existing migration-27 service, while the compatibility translator maps command-only Legacy Prototype
workflows to saved SSH Bookmarks without persisting embedded credentials. `--server-port` remains an
explicit compatibility exception so the Runtime keeps its loopback, OS-assigned-port invariant.

H-01 adds `privacy.hideAddresses` to the existing `privacy` Settings JSON section. Zod backfills false
for older rows and sparse updates merge it independently, so no SQLite migration or dependency change is
required. The Renderer applies the setting only to user-visible address labels; Runtime adapters retain
the canonical destination needed to connect.

H-03 originally added SQLite migration 29 with the `terminal_themes` JSON entity table and a
310-entry generated upstream catalog. ADR-016 replaces that catalog and both copied defaults with
four Axterm-authored palettes in `packages/shared/src/terminal-theme-presets.ts`; there is no longer
an upstream theme generator or product dependency. Migration 34 maps removed built-in selections
to the stable Axterm default in global/current/saved workspace visuals, preserving user-created
theme rows and creating a recoverable pre-migration database backup for existing installs. See
[THEME_CATALOG_MIGRATION](THEME_CATALOG_MIGRATION.md). Only user-created/imported themes are
persisted with normal entity versions and Domain Events. During the compatibility window,
import/export still use the legacy UTF-8 text format through operation-scoped File Grants, a
64 KiB read limit and an atomic mode-0600 export.

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
same release used by the Legacy Prototype 5.5.0 baseline. `@xterm/headless` is the
Runtime-only VT parser used to turn terminal output into bounded session-log lines;
its version matches the Renderer xterm parser. On macOS, `scripts/prepare-native.mjs` builds the
patched `node-pty` source for the current development Node ABI and records the source hash/ABI marker;
`node-pty` and `@serialport/bindings-cpp` are rebuilt explicitly for Electron by
`scripts/rebuild-native.mjs` before packaging. The Electron rebuild deletes all Node ABI markers,
and `scripts/package-desktop.mjs` restores an exact pre-build snapshot after electron-builder has
copied the Electron artifacts. Unit regressions cover successful restoration, missing-build cleanup,
idempotency and direct marker invalidation, so packaging cannot leave the workspace on the wrong ABI.
`zmodem2` and `trzsz2` are Runtime-only, separately published pure-JavaScript
protocol dependencies; their source/provenance review remains in the P-02/IR-02
queue. Axterm's separately authored `xmodem.ts` has no additional dependency.
ADR-018 records their implementation provenance while retaining ADR-013's
Runtime ownership and file-safety boundary. The native modules' loadable binaries
and the PTY helper remain outside ASAR and are verified by packaged native smoke
tests. `ssh2`'s optional `cpu-features` accelerator is excluded; ssh2's
JavaScript implementation is the supported path. See
[PACKAGING](PACKAGING.md).

P-03 removes the `@legacy-prototype/ftp-srv` Runtime dependency and lockfile entry.
`NodeLocalFtpServer` adds no replacement package; it uses Node's TCP and
filesystem APIs in the Runtime with loopback defaults, bounded passive ports,
connections, commands, listings and timeouts, plus deterministic shutdown. It
does not register process-global signal handlers or publish credential-bearing
service URLs. PASV/EPSV and same-peer PORT/EPRT are supported; cross-host and
privileged-port active endpoints are rejected.

The local SSH Server Widget generates its ephemeral host identity with Node's P-256 SEC1 exporter.
This avoids an intermittent `ssh2` 1.17 OpenSSH Ed25519 writer/parser mismatch while keeping the key
memory-only and instance-scoped; a 128-start regression test exercises the exact server startup path.

`patches/trzsz2@1.2.0.patch` corrects the package's top-level TypeScript
declaration path to the declaration file already shipped under `dist/esm/lib`.
It also changes the separately licensed MIT protocol receiver: pending receive
timers are cleared, binary chunk headers above 16 MiB are rejected before
allocation, and POSIX/Windows protocol lines above 32 MiB are rejected before
their decoded buffers grow. Queued peer input, including unread bytes of the
current chunk, is capped at 64 MiB and 4,096 chunks, and consumed queue slots
are reclaimed.
Both CJS and ESM distribution forms are patched;
the published source maps retain upstream text and are not a map of these
local executable modifications. The patch is a modified third-party component,
not Axterm-owned protocol source.

`patches/node-pty@1.1.0.patch` fixes a macOS native descriptor leak in the package's
`pty_posix_spawn` guard loop. The upstream loop did not count or close the first temporary PTY file
descriptor, so a long-lived process failed after about 511 local-terminal creations on the current
host. The patch corrects the count and reverse close index only. A 729-cycle accelerated real-PTY
workload now passes beyond the former deterministic 506-cycle failure and returns every owner to
zero. `node-gyp` is a build-only dependency used to compile this patched source for development;
it is not shipped or required on end-user machines.

## Vendored source submodules

Verified: 2026-10-05.

| Path        | Upstream                                   | Pinned commit                              | License |
| ----------- | ------------------------------------------ | ------------------------------------------ | ------- |
| `vendor/pi` | <https://github.com/earendil-works/pi.git> | `5b6c792b424e73edefbfa558b901bcd64788dad2` | MIT     |

The Git index pins the observed upstream `main` commit; `.gitmodules` records
the checkout path and HTTPS origin without a branch-following override.
Initialize it with `git submodule update --init --recursive vendor/pi`.
The upstream `LICENSE` retains Copyright (c) 2025 Mario Zechner.
Pi AI / Agent / telemetry source now builds into `@workspace/pi-engine` and is consumed only
by the Runtime AI adapter (ADR-027). The upstream checkout remains unchanged. Source hashes
are bound in `packages/pi-engine/source-manifest.json`; catalog bytes are pinned to the
upstream Nix catalog revision `sha256-c5d5070c7592ca8e27743e892a7eec1d6c883be8034f888735238cdfdb3ab70f`.
`bun run pi:build` validates both and hydrates ignored upstream model data offline. Source
snapshots retain the three engine source trees, hydration helpers, catalog pin and MIT license,
while omitting `.gitmodules`, Git metadata and unrelated CLI packages. ADR-029 additionally
reuses coding-agent `loadSkillsFromDir` / `stripFrontmatter` as build-time skill loaders;
their exact necessary source files are hashed and retained in the snapshot. Four Axterm
`SKILL.md` bodies are validated and embedded, without ambient user/project resource discovery.
Build-only root pins `ignore` 7.0.6, `yaml` 2.9.0 and `cross-spawn` 7.0.6 make the Pi loader's
imports reproducible; all were already present transitively. No production dependency is added.

The private engine package pins the SDK dependencies used by Pi 1.0.3:

| Dependency                               | Version  |
| ---------------------------------------- | -------- |
| `@anthropic-ai/sdk`                      | 0.129.0  |
| `@aws-sdk/client-bedrock-runtime`        | 3.1127.0 |
| `@google/genai`                          | 2.21.0   |
| `@smithy/node-http-handler`              | 4.12.1   |
| `@smithy/types`                          | 4.19.0   |
| `http-proxy-agent` / `https-proxy-agent` | 9.1.0    |
| `openai`                                 | 7.19.0   |
| `partial-json`                           | 0.1.7    |
| `typebox`                                | 1.3.27   |

These are production build inputs; no published Pi package or coding-agent CLI is installed.
The scoped Google SDK transport binding is documented in ADR-027. Production component,
license text, attribution, native-scope and SBOM inventories are regenerated from the locked graph.

## Historical upstream submodule

The former `vendor/legacy-prototype` reference used package version 5.5.0 at
`799bedef98c1deae676ae03041719de98d3b57f1` under MIT. It is no longer present in
the worktree, dependency graph, product build or current acceptance gate.
[ADR-003](../adr/ADR-003-legacy-prototype-parity-program.md) and
[UPSTREAM](UPSTREAM.md) are historical provenance records only;
[ADR-016](../adr/ADR-016-independent-open-source-product.md) and the
independent-release plan govern current work. Keep the historical record in the
controlled archive, not in the planned name-free public snapshot.
