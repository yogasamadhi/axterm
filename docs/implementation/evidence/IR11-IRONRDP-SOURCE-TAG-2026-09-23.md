# IR-11 IronRDP npm release-tag and license evidence — 2026-09-23

Status: **publisher-source provenance and exact license text; not WASM rebuild or rights clearance**

The desktop depends on `@devolutions/iron-remote-desktop-rdp@0.7.0` rather
than the former `ironrdp-wasm` package. The installed package has only three
published files: `package.json`, `index.d.ts`, and a bundled JavaScript file
containing embedded WebAssembly. It declares `MIT OR Apache-2.0` but does not
ship a standalone license file.

The official Devolutions repository has the release-specific tag
[`npm-iron-remote-desktop-rdp-v0.7.0`](https://github.com/Devolutions/IronRDP/tree/npm-iron-remote-desktop-rdp-v0.7.0)
at commit `e45f68c7e52297ca50d33b44c0ace36c9940fbe6` (2026-05-27).
The tag's `web-client/iron-remote-desktop-rdp/public/package.json` is
byte-identical to the published and installed package manifest, SHA-256
`5bf67de9f67a913960387500752cc79cc353366326603eafa4ba11542a165dab`.

The published 0.7.0 npm tarball was downloaded separately and its SHA-512
integrity matched both the official npm version metadata and `bun.lock`:

```text
sha512-CclAh4OS9aBoPJT0l7bih7ETOHPnB9KjT0drB0a6r5+Qh95pTEuQCx7uFN/XA2AlkFlrqx+DBAMDGYXmgsjHAQ==
```

All three extracted tarball files compare byte-for-byte with the local Bun
installation. The bundled JavaScript SHA-256 is
`b008f0e258fd9485c6f2b07747116d4fcbbe51053ce995abd048fb2b79636332`;
`index.d.ts` is
`90985995ccb22436462d5d742014ee4f0d4fd902f1099c95733bbc2e5df00c15`.
The publisher tag's [`LICENSE-APACHE`](https://github.com/Devolutions/IronRDP/blob/e45f68c7e52297ca50d33b44c0ace36c9940fbe6/LICENSE-APACHE)
is preserved byte-for-byte as `licenses/IronRDP-LICENSE-APACHE.txt`, SHA-256
`cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`.
The upstream file differs from Axterm's root `LICENSE`, whose appendix names
Axterm's own copyright holder; the root file is not a substitute for the
third-party attribution record. The exact upstream text is named in
`THIRD_PARTY_NOTICES.txt`, copied beside the installed application by the
existing `licenses/` packaging rule and shown in About. Source tests pin the
installed manifest/JavaScript and license hashes; packaged tests require the
license file to match the source and About to render it.

The complete `bun run check` passed 1,007 tests (33 skipped), 375 Level 1
modules / 1,321 dependencies, 267 Contract operations and nine visual/a11y
journeys. A separate unsigned macOS arm64 directory app was built in an
isolated temporary output; its `app.asar` SHA-256 is
`cadd9e1b7e022beaa3d4ac8a811c957d11004d23501ba2257950fdbd69fac705`.
The packaged legal-file, About and official IronRDP initialization journeys
passed **3/3** after copying the app outside the checkout. The packaged
`Contents/licenses/IronRDP-LICENSE-APACHE.txt` is byte-identical to the
publisher-tagged source text. Its regenerated and verified macOS-arm64 SPDX
sidecar has SHA-256
`a40d59250b14ae0a919c3947dc6503711a0f67e32a6e7832153d705e1b3f97b5`
and includes the separate license file among 244 hashed file entries (87
package entries). This is local unsigned package evidence, not an installed,
signed or cross-platform release.

These checks connect the dependency lock, publisher tarball, installed files
and release-tagged manifest/license. They **do not** reproduce the tagged Rust
and TypeScript build, identify every Rust crate in the embedded WASM, or prove
that the WebAssembly bytes were built from this precise tag. A qualified
file-level/source-to-binary and license review remains required before
IR-02/IR-11 acceptance; this result must not promote those matrix rows.

## Publisher-attested npm source link

The official npm registry's 0.7.0 metadata includes a registry signature and
two attestation bundles. On 2026-09-23, npm 11.16.0 installed **only this
package** from `https://registry.npmjs.org/` into a disposable directory with
scripts disabled; `npm audit signatures --json --include-attestations` against
that registry reported one verified package, zero invalid and zero missing
signatures. The npm lock's tarball integrity and installed JavaScript bytes
matched the frozen Bun lock and install above. A first diagnostic using the
machine's configured npm mirror failed with `EMISSINGSIGNATUREKEY`; the
official-registry override is mandatory for this verification and is explicit
in the new check.

The verified publication and SLSA provenance statements both name the npm
package and the same SHA-512 subject digest as the locked tarball. The SLSA
statement identifies Devolutions' `IronRDP` repository, source commit
`e45f68c7e52297ca50d33b44c0ace36c9940fbe6`,
`.github/workflows/npm-publish.yml`, the GitHub-hosted runner and
[`run 26511159700`](https://github.com/Devolutions/IronRDP/actions/runs/26511159700/attempts/1).
GitHub's public run summary shows that workflow_dispatch publish run succeeded
at the same commit on 2026-05-27. The registry attestation endpoint is
`https://registry.npmjs.org/-/npm/v1/attestations/@devolutions%2firon-remote-desktop-rdp@0.7.0`.

`bun run licenses:ironrdp:provenance-check` now reproduces the isolated,
script-disabled official-registry install and npm's signature verification,
then fails closed if the Bun lock, installed JavaScript, signed subject digest,
source commit, workflow identity or run changes. Four focused unit tests guard
tampered and missing evidence. The Linux CI route invokes the check after its
dependency audit; **a remote CI run of this new step has not yet been observed**.
The updated local `bun run check` passed 219 test files (five skipped), 1,012
tests (33 skipped), the 358-module / 1,304-dependency Level 1 gate, 267
Contract operations, source/build checks and all nine visual/accessibility
journeys. The independent online provenance check passed against the official
npm registry; it is deliberately outside the ordinary offline source gate.

This materially narrows publisher-to-tarball provenance, but the attestation
asserts the publisher's build, not a reproducible byte-for-byte build from the
tag. It does not enumerate embedded Rust crates, establish every applicable
notice or settle source rights. IR-02/IR-11 remain **In progress**.
