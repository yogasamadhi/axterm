# IR-11 spice-client embedded source notices and bundle trace

Date: 2026-09-23  
Scope: local unsigned macOS arm64 directory app; `spice-client@1.2.0`  
Result: mechanical attribution and installed-file trace improved; **IR-02/IR-11 remain In progress**.

The installed npm package exposes `dist/esm/index.js` and its referenced
`index.js.map`. The source map contains 30 non-empty `sourcesContent` inputs.
Several are ports of `spice-html5`; its `thirdparty` inputs additionally retain
Tom Wu's jsbn notice and Paul Johnston's SHA-1/BSD notice. The keyboard-name
input includes the separate Thomas Roell and XFree86 permission texts. A
package-level `LGPL-3.0-or-later` label does not convey those exact file-level
texts on its own.

`licenses/spice-client-SOURCE-NOTICES.txt` preserves the leading comments from
all 30 mapped source texts, lists every source-text SHA-256 and records the
installed ESM entry and source-map hashes. Its SHA-256 is
`4cfa2a71471e38f469c79cf6f20b15e2319cc9cabc07c009a378c5dd80da3d1b`.
The ESM entry hash is
`a18cdf1af988e626f313abd65c4f90517d1fecb5e1708482bb2ef9efd77ce821`;
the map hash is
`242d68151cabb7c7384366bade23902e83636a5fc74afa2cf614ac2440ce8a44`.
`bun run licenses:spice:check` regenerates this archive and fails on drift;
its unit regression checks the distinct embedded copyright holders.

The production renderer emits
`axterm-spice-client-bundle-provenance.json`, mapping that exact ESM input and
source map to the emitted `spice-client` chunk. `bun run
licenses:spice:bundle-check` compares the manifest's source-text, input and
chunk hashes with the installed package and built bytes. For this build the
manifest SHA-256 is
`5b4d07eabaa47b9677b03e2424ac66df4da04c95f1880352db3ed826294d26d3`;
the `assets/spice-client-BKjTaEBj.js` chunk SHA-256 is
`9c995b4e85b83b5ec41e9f40a8fee9c07451c522091e10a67e64d63d093a1951`.

An isolated unsigned macOS arm64 `package:dir` build had `app.asar` SHA-256
`abe652e7fe4ec290ae4f205ba13888a8e48dac7e9bfa8db38a4945f40a23d54b`.
Its packaged Legal/About journeys passed 2/2, comparing the external notice
file byte-for-byte with source and verifying the ASAR provenance/chunk bytes.
The regenerated SPDX sidecar passed `sbom:packaged:check` byte-for-byte;
SHA-256 `f01895955bbc03b5fe4e201e57c045989ab764e686f59b17806f4c245db34289`,
87 package records and 239 file records. It separately lists the SPICE
provenance JSON as an ASAR text file with the manifest hash above.

This is not proof that the source map is complete Corresponding Source, that
every compiled statement is mapped, that modification/relinking conditions
are satisfied, or that the relevant copyright holders and distribution duties
have received qualified review. It is not evidence for a signed installer,
native Windows/Linux products, remote CI or an actual SPICE server session.
The final rights and distribution decision remains an open review gate.

## Fixed publisher source copy and local rebuild

The publisher's [source repository](https://github.com/zxdong262/spice-js)
commit `aed3b4f841db65a9ab015e174d69ff4fccbb197f` has the same
`package.json` and `LICENSE` bytes as the installed npm package. All 30 ESM
source-map `sourcesContent` entries match the corresponding files at that
commit byte-for-byte. A reproducible Git archive of 50 files—`src/spice/`,
`build/`, package manifest/lockfile, TypeScript/test configuration, unit tests
and LICENSE—is now supplied as `licenses/spice-client-1.2.0-source.tar`, SHA-256
`a30adf3706f5a03ede1fdcd0785cea4330f86af2c9bbbc75165384ccfcfd9a26`.
The publisher README and unrelated web-demo files are omitted; the archive
contains no Legacy Prototype product reference. A separate About-visible
`spice-client-SOURCE-README.txt` explains the archive and extraction/rebuild
steps. `bun run licenses:spice:source-check` validates the fixed commit header,
archive hash and structure, all 30 mapped source hashes, installed manifest
and LICENSE, and required build inputs offline. The selected upstream files
were separately inspected for the old product name; this is a scoped archive
review, not a substitute for the final source snapshot audit.

In an isolated extracted copy on macOS arm64 (Node 24.18.0, npm 11.16.0),
`npm ci --ignore-scripts --no-audit --no-fund`, `npm run build`, a separate
`tsc --project build/tsconfig.types.json` and `npm test` passed. The separate
TypeScript command matters because the publisher's build script uses `|| true`.
The rebuilt `dist/esm/index.js` and `index.js.map` matched the installed npm
package byte-for-byte (the two hashes above); the publisher unit suite passed
72/72. This proves a local byte-identical ESM rebuild from the supplied
subset, not an independently reviewed LGPL compliance strategy or a verified
Windows/Linux rebuild. Final distribution must still assess modification,
relinking, installation information, source availability and release artifacts.

After rebuilding Axterm from the final About text, a new isolated unsigned
macOS arm64 directory app passed both packaged Legal/About journeys (2/2).
The source tar and About-visible guide are byte-identical to source files in
the installed `Contents/licenses/` directory. The package has `app.asar`
SHA-256 `c0dc7da2e97cf7f5af46e328cbda157957fa30c4c837ad48a82dbd75c90e5285`.
Its 87-package / 241-file SPDX sidecar has SHA-256
`47e7b811c650f3a249e6722b4c791531a8dd26de230537763a84576d99853f85`;
`sbom:packaged:check` regenerated it byte-for-byte. The tar is a distinct
`ARCHIVE` file entry carrying the source archive SHA-256. This is installed
resource evidence for one unsigned macOS directory build, not final
installer, Windows/Linux, remote-CI or legal-signoff evidence.
