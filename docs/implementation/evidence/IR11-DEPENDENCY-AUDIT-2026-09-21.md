# IR-11 dependency vulnerability audit — 2026-09-21

Release gate: [IR-11](../INDEPENDENT_RELEASE_MATRIX.md)  
Status: **current advisory-query evidence; not security or legal clearance**

## Finding and mitigation

The configured package mirror returned `404` for Bun's npm advisory bulk endpoint:

```text
bun audit --production --json
# error: POST https://registry.npmmirror.com/-/npm/v1/security/advisories/bulk - 404
```

Using the official npm registry, the complete installed graph initially returned
one moderate finding, `GHSA-67mh-4wv8-2f99`: `esbuild@0.18.20` through
`drizzle-kit@0.31.10` → `@esbuild-kit/esm-loader@2.6.5` →
`@esbuild-kit/core-utils@3.3.2`. The advisory affects versions through 0.24.2
and identifies 0.25.0 as the patched line. It concerns a malicious website
reading an esbuild development server through its default CORS behavior; see the
[GitHub advisory](https://github.com/advisories/GHSA-67mh-4wv8-2f99).

`bun audit fix --dry-run` could not repair it because the intermediary package
declares `~0.18.20`. The root `package.json` therefore uses Bun's supported
top-level `overrides` mechanism to force every `esbuild` resolution to the
already direct-pinned `0.28.2`. This is a temporary supply-chain mitigation,
not a claim that the deprecated intermediary is independently maintained or
that its declared range is correct.

## Verification

After `bun install --registry=https://registry.npmjs.org`, these commands
succeeded on 2026-09-21:

```text
bun pm why esbuild
# one resolved version: esbuild@0.28.2

npm_config_registry=https://registry.npmjs.org bun audit --json
# {}

npm_config_registry=https://registry.npmjs.org bun audit --production --json
# {}

bunx drizzle-kit --version
# drizzle-kit: v0.31.10
# drizzle-orm: v0.45.2
```

`bun run audit:dependencies` repeats the full advisory query against the
official endpoint and now runs after frozen installation in the macOS, Ubuntu
and Windows CI matrix. It must remain green before merge. The normal package
mirror remains valid for dependency installation; only this advisory query is
routed to the official endpoint.

## Limits and follow-up

The result depends on the advisory database and timestamp. It does not scan
Electron/Chromium, native binaries, generated bundles, embedded WASM, secrets,
source provenance, license obligations or newly disclosed vulnerabilities. It
also does not replace SAST, a security contact, signed releases or platform
artifact review. Reassess the override whenever `drizzle-kit` removes the
deprecated loader; remove it only after a fresh audit, Drizzle CLI check, full
build and cross-platform CI pass.
