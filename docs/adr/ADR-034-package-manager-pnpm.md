# ADR-034: Replace Bun with pnpm as the only package manager and task runner

Date: 2026-10-26
Status: Accepted at the owner's request; validation evidence is recorded in STATUS.

## Context

The repository was built on Bun 1.4 as its package manager, workspace
resolver, task runner and lockfile owner. Bun was never part of the product
runtime: the Desktop Runtime runs in the Node embedded in Electron 44, the
Core Runtime runs in a separate `utilityProcess` with an independent Node
headless entry, and MASTER_SPEC §11.4 already forbade `bun:*` runtime-only
APIs inside the Core Runtime.

Bun made the toolchain and the product runtime look alike. That is a
recurring source of accidental drift: a script may quietly rely on Bun's
module resolution, its TypeScript execution, its install layout or its
license report format, none of which exist in the shipped runtime. The owner
has decided that the toolchain must use the same runtime family as the
product, so the toolchain moves to pnpm on Node 24.

## Decision

pnpm 11.22.0 is the only package manager, workspace resolver and task runner.
Bun is removed from the repository: `bun.lock` is deleted, `pnpm-lock.yaml` is
committed, and no script, workflow, gate or document invokes Bun.

The workspace definition moves to `pnpm-workspace.yaml`:

- `packages` lists `apps/*` and `packages/*`, replacing the Bun `workspaces`
  field.
- `allowBuilds` replaces Bun's `trustedDependencies`. `electron`, `esbuild`,
  `node-pty` and `@serialport/bindings-cpp` may run their install scripts;
  `@google/genai`, `cpu-features`, `electron-winstaller`, `protobufjs` and
  `ssh2` are explicitly denied, matching the previous Bun allowlist.
- `overrides` keeps the `esbuild` 0.28.2 security override.
- `patchedDependencies` keeps the two reviewed source patches
  (`node-pty@1.1.0`, `trzsz2@1.2.0`) under `patches/`.
- `verifyDepsBeforeRun: false` keeps `pnpm run` free of implicit installs, so
  the release gates remain the only place that mutates the install graph.

TypeScript entry points run on Node instead of Bun. `scripts/run-ts.mjs`
starts Node with its TypeScript support and registers
`scripts/register-ts-resolver.mjs`, which restores the extension-less relative
imports that the workspace sources use. The same loader runs the contract
generator and the optional Linux FTP container smoke.
`packages/runtime` now imports the published ESM entry of `@xterm/headless`
instead of its CommonJS bundle, because Node's ESM loader cannot read named
exports from that bundle.

The development launcher is a plain Python script. `run.py` replaces the
previous TypeScript launcher: it starts the desktop development environment,
forwards the Axterm command line, forwards process signals and prints the
command-line help and the product version. It uses only the Python standard
library, so the launcher needs no TypeScript runtime, bundler or experimental
Node loader. The launcher cannot drift from the product: the help text lives in
`apps/desktop/src/main/command-line-help.json`, which the Desktop Main build
inlines, and the version comes from the root `package.json`, which a
regression keeps equal to the shared product version.

The contract generator stays TypeScript. `scripts/contracts.ts` is the
Runtime's own composition root: it imports the Runtime services and builds the
OpenAPI document from the product's route and schema definitions. A Python
script cannot execute those TypeScript definitions, and moving the wiring into
the product would either expose the OpenAPI document as a product route or
duplicate the Runtime composition. The generator therefore keeps its single,
reviewed Node entry point.

The dependency gates read the pnpm graph. The component index, root-license
text archive and production SBOM are generated from
`pnpm licenses list --json --prod`, whose report shape matches the previous
Bun report, and the installed package root becomes `node_modules/.pnpm`. The
IronRDP and noVNC provenance gates read the reviewed tarball integrity from
`pnpm-lock.yaml`. The independent snapshot audit scans `pnpm-lock.yaml`.

The optional Linux FTP container smoke runs on the pinned
`node:24.18.0-alpine` image instead of the pinned Bun image, and executes the
smoke with Node.

## Consequences

One runtime family, one lockfile owner, one install layout. The toolchain can
no longer hide Bun-only behaviour, and the shipped runtime keeps its existing
Level 1 process, transport and security boundaries unchanged.

Direct dependency versions are unchanged. pnpm resolves a small number of
transitive patch-level versions differently from Bun, so the committed
component index, license-text archive, production SBOM, attribution ledger
and source review ledger are regenerated from the current pnpm graph.

The lockfile is resolved against the primary npm registry. A registry mirror
with stale abbreviated metadata resolves `@electron/get` to 3.0.0 instead of
3.1.0, which breaks the electron-builder download step, so the frozen graph
must not be resolved from that mirror. The dependency-audit gate therefore
queries the primary registry explicitly.

The Core Runtime keeps its explicit ban on `bun:*` imports
(`runtime-no-electron-or-bun` in the architecture gate) as defense in depth,
even though the toolchain no longer offers Bun.

## Alternatives considered

- Keeping Bun and only documenting the split: rejected. The accidental-drift
  risk stays, and the owner explicitly asked to stop using Bun.
- npm workspaces: rejected. npm has no workspace-native allowlist for install
  scripts, no reviewed patch mechanism and no frozen production-graph report
  that the license, SBOM and attribution gates can consume.
- Yarn: rejected. The frozen install graph and license report would have to be
  rebuilt again, and the current gate design already fits pnpm's report shape.
