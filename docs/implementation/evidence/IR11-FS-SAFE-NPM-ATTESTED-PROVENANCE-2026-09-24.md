# IR-11 fs-safe macOS published-binary provenance — 2026-09-24

Status: **official-registry provenance and exact installed-byte chain verified; reproducible build and rights review remain open**.

The pinned macOS arm64 package is `@openclaw/fs-safe-darwin-arm64@0.13.1`.
Its [publisher release](https://github.com/openclaw/fs-safe/releases/tag/v0.13.1)
lists the official npm tarball integrity and a verified attestation. The
official npm registry's provenance contains a SLSA v1 statement for subject
`pkg:npm/%40openclaw/fs-safe-darwin-arm64@0.13.1`, tarball SHA-512
`7723c239f31524c5da3f6c89208c99aef2b74f242908476e86fbdf1f765b730ff84ab74a3f9ef8aa086024cf950958364fd4c41d337860134eeb3e768a2308de`.
It names `https://github.com/openclaw/fs-safe`, tag `v0.13.1`, workflow
`.github/workflows/release.yml`, resolved Git commit
`7022a0a10c53e36f34a467df68ed5614a1db1741`, and
[Actions run 35153270431 attempt 1](https://github.com/openclaw/fs-safe/actions/runs/35153270431/attempts/1).
The GitHub API reports that run as a successful `push` build of that exact
commit and workflow.

Verification used npm 11.16.0 on macOS 27.0 arm64, with an isolated temporary
package project and the **official** `https://registry.npmjs.org` endpoint.
`npm audit signatures --json --include-attestations` reported the one pinned
package as verified, with empty `invalid` and `missing` sets and SLSA provenance.
[npm's documentation](https://docs.npmjs.com/cli/v11/commands/npm-audit/)
defines this command as checking registry signatures and provenance
attestations. The host's default npm mirror could not supply its signing key;
verification was therefore explicitly rerun against the official registry,
not counted as a mirror success.

`npm pack` then downloaded the official tarball with integrity
`sha512-dyPCOfMVJMXaP2yJIIyZrvK3TyQpCEduhvvfH3Zbcw/4SrdKP574qghgJM+VCVg2T9TEHTN4YBNO6z52iiMI3g==`.
Its computed SHA-512 matched the SLSA subject. The `package/fs-safe-native.node`
entry, the frozen Axterm dependency installation and the isolated unsigned
macOS DMG build's
`Axterm.app/Contents/Resources/app.asar.unpacked/node_modules/@openclaw/fs-safe-darwin-arm64/fs-safe-native.node`
were byte-identical, SHA-256
`78ca69b52d05da239bf50a6768867134265aace0195c8494f64f65b6d1ba6db0`.

The repeatable online command is:

```sh
bun run licenses:native:provenance:macos -- --app /absolute/path/to/Axterm.app
```

It pins and checks the npm audit result, SLSA source/workflow/run claims,
successful GitHub run, downloaded tarball digest and extracted-versus-installed
`.node` bytes. The `--app` comparison is optional for source-only diagnosis but
required for a concrete package claim. It uses an isolated temporary project,
ignores install scripts and removes only that project afterward. The pure
claim validator has unit tests for mirror substitution and altered source,
tarball and binary identities. This is a release-engineering audit, not a
network-dependent part of routine `bun run check`.

This evidence closes the earlier **unverified npm publication-to-installed
binding identity** question for this macOS candidate. It does **not** prove a
bit-for-bit reproducible native build: a local rebuild from the same commit
with Rust 1.98.1 and SDK 27.0 still differs from the published file, whose
Mach-O records SDK 15.5/linker 1167.5. npm explicitly cautions that
[provenance does not guarantee absence of malicious code](https://docs.npmjs.com/generating-provenance-statements/).
It also does not decide the applicability of 61 Cargo package licenses,
vendored source notices, source-file authorship, contributor rights or final
distribution obligations. The 61 package and one published-binary review
entries remain pending; IR-02/IR-11 are **In progress**, and no release gate is
promoted by this record alone.
The full `bun run check` now passes **228 test files, 1,150 tests passed / 34
skipped**, 360 architecture modules / 1,310 dependencies, 267 Contract
operations and 11 visual/accessibility journeys.
