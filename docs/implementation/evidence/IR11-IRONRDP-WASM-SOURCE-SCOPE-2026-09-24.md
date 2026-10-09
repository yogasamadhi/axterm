# IR-11 — IronRDP WASM-target Rust source and root legal texts

Date: 2026-09-24  
Status: macOS engineering/source-scope evidence; **not WASM reproducibility or rights clearance**

## Pinned source and scope

Axterm uses `@devolutions/iron-remote-desktop-rdp@0.7.0`. The separate
[npm provenance record](IR11-IRONRDP-SOURCE-TAG-2026-09-23.md) links its signed
publication to Devolutions/IronRDP commit
`e45f68c7e52297ca50d33b44c0ace36c9940fbe6`, tagged
`npm-iron-remote-desktop-rdp-v0.7.0`. That tag has `Cargo.lock` SHA-256
`39e41e6fe8fd7de5679ec11f59e8597e9f761ecb04f9b908eb79c5629b9cfb1a`.
Its npm workflow runs the web build through `npm run build` and
`cargo xtask web build`; the latter builds `crates/ironrdp-web` for WebAssembly.

Using the tagged repository's Rust 1.89.0 toolchain, `cargo tree --locked
--target wasm32-unknown-unknown --package ironrdp-web --edges normal,build`
found **259 distinct source-package identities**: 236 crates.io packages and
23 tagged-repository workspace packages. This is intentionally narrower than
the full workspace's Cargo metadata or entire `Cargo.lock`. It still includes
build-time/proc-macro sources, not just code linked into the WASM.

The deterministic source inventory is
`IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json` (SHA-256
`ff29170ab16588b67555996ba107f15eac5005149b549110cd570fe1c4126792`).
It records each version, manifest license declaration, crates.io lock checksum
or tagged workspace path, and package-root legal-file hashes. The separate
`AXTERM_IRONRDP_WASM_CARGO_SOURCE.spdx.json` is an SPDX 2.3 **source-scope**
inventory (SHA-256
`733048987d2eaf67b41b5c4e7e42c79d3daf4ea5705b6c8c58b5b53d571c25cf`),
not a substitute for the Bun production SBOM or a concrete app's packaged
SPDX sidecar. Its 259 packages have `licenseConcluded: NOASSERTION`; manifest
license strings are preserved only as review leads.

## Legal-text preservation

The 259 package roots contain **468** matching LICENSE/LICENCE/COPYING/NOTICE/
COPYRIGHT/AUTHORS files. The tagged upstream repository root also contains
`LICENSE-APACHE` and `LICENSE-MIT`. All **470** original UTF-8 files are
preserved byte-for-byte with identity, byte length and SHA-256 markers in
`licenses/IronRDP-RUST-ROOT-LICENSES.txt` (2,570,010 bytes; SHA-256
`4f90cf224ed4e9b0a4e9f6fb2428c98eeccc2f2ab17c063d0543aba266337a96`).
That file is in `THIRD_PARTY_NOTICES.txt`, the packaged `licenses/` directory,
and Legal/About. The existing separate publisher
`licenses/IronRDP-LICENSE-APACHE.txt` remains available.

Six registry packages have no legal file in their own package root:
`gloo-net@0.7.0`, `gloo-utils@0.3.0`, `gloo-timers@0.4.0`,
`asn1-rs-impl@0.2.0`, `rustcrypto-ff_derive@0.14.0-rc.0` and
`winscard@0.3.2`. Their exact `.cargo_vcs_info.json` publisher commits and
published `src/lib.rs` bytes have now been cross-checked. Both repository-root
legal texts at each commit are preserved in a separate
`licenses/IronRDP-MISSING-CRATE-ROOT-LICENSES.txt` bundle; see the
[six-crate source record](IR11-IRONRDP-MISSING-CRATE-ROOT-TEXTS-2026-09-24.md).
This does not change the fact that the published crate archives omit those
root texts. Five tagged workspace crates also have no own root file:
`ironrdp-web`, `iron-remote-desktop`, `ironrdp-bulk`,
`ironrdp-propertyset` and `ironrdp-rdpfile`; their workspace manifest inherits
the upstream license declaration, and both repository-root license texts are
preserved. This does **not** establish that all nested/file-level notices or
attributions are complete, nor select each package's dual-license option.

A follow-up [nested-text sweep](IR11-IRONRDP-NESTED-SPIN-LICENSE-2026-09-24.md)
found `tracing-core@0.1.36/src/spin/LICENSE`, which credits a different author
than its already preserved package-root file. Its exact archived text is now
separate as `licenses/tracing-core-spin-LICENSE.txt`; this is a filename-pattern
sweep, not full file-level rights clearance.
The subsequent [copyright/SPDX source-header candidate record](IR11-IRONRDP-SOURCE-HEADER-CANDIDATES-2026-09-24.md)
preserves 798 explicit lines from 719 files across 51 target-graph packages
as `licenses/IronRDP-SOURCE-HEADER-ATTRIBUTIONS.txt`. Matching files were
compared with published source archives or the pinned tag. This does not
establish complete notice coverage or inclusion in the compiled WASM.

## Mac artifact check

The current unsigned macOS arm64 directory app was packaged in an isolated
temporary output. Its complete packaged SPDX sidecar re-verifies against the
app with SHA-256
`3a0e955c79ffbc76b449c4e700748c07901abafb67dd9d828d6e03432144681c`;
`app.asar` is
`95fb345952cf460a686f81ede075874ebb51d84c4f064d5befb47692ca9cd8d2`.
The focused IronRDP artifact check verified that sidecar, the installed npm
identity, the preserved root-text bytes and publisher Apache file, and
extracted the packaged Renderer chunk from ASAR. Its embedded WASM SHA-256
matches the published package:
`68b5c65280e5348ea418cd0aba2e4e28f9bd4051c2cf9fd4b84d721847ef3363`.
The full macOS directory-app Playwright suite passed **22 applicable journeys**
with 11 platform/fixture skips, including Legal/About exact-text access and
official IronRDP initialization outside the checkout. This is not a live RDP
interoperability test, signed/notarized installer or public release.

Loading the new 2.57 MB legal text eagerly initially enlarged the Renderer
entry script from about 3.75 MB to 6.32 MB. Legal documents now load only when
opened; the rebuilt entry is about 3.00 MB, and the exact packaged About
journey verified the deferred text. The package layout gate now identifies
the SPICE client by its build-time provenance path/hash, so legal-text chunks
named `spice-client-*` cannot be mistaken for another protocol implementation.

## Reproduction and limits

From the frozen Axterm install:

```sh
bun run licenses:ironrdp:source:check
bun run licenses:ironrdp:source:upstream-check -- /path/to/IronRDP-tagged-checkout
bun run licenses:ironrdp:source:artifact-check -- \
  /path/to/Axterm.app/Contents/Resources \
  /path/to/AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json
```

The upstream checkout must resolve to the commit above, have clean tracked
files, and have the locked crates available for Cargo. The first command is
part of `bun run check` and pins the committed inventory/SPDX/legal archive,
the six-crate publisher supplement and installed npm/WASM bytes. The second
reconstructs the inventory, SPDX and original root-text bundle from the tagged
source; the six-crate supplement has its own publisher-source check. The third
compares one concrete Mac app and
its sidecar; it cannot infer a Rust source-to-WASM build from matching npm
bytes. The upstream npm pre-build script catches child-process errors, so a
successful package publication alone is not proof that this exact source tree
compiled the embedded WASM. A reproducible build or qualified provenance
conclusion, nested/file-level notice review, license-option selection and
named rights approval remain open. IR-02/IR-11 stay **In progress**.

`IRONRDP_DEPENDENCY_REVIEW_LEDGER.json` now tracks all 259 exact source-package
records and the published embedded WASM as **260 pending qualified decisions**.
The routine `bun run licenses:ironrdp:review:check` verifies complete scope
without inventing approval. Final-public promotion requires
`bun run licenses:ironrdp:review:reviewed-check`, which currently and correctly
refuses all 260 pending entries. A prior review is reset if its package legal
hash or published WASM identity changes. The composed
`release:final-public:check` still refuses promotion, now listing nine pending
prerequisite gates and skipping the final source snapshot.

After these changes, the full `bun run check` passed 231 unit/integration test
files (1,161 tests passed, 34 skipped), 360 architecture modules / 1,310
dependencies, 267 Contract operations, build/package layout, source and legal
checks, and all 11 visual/accessibility journeys.

The separate publisher-root supplement is a follow-up to that baseline, not
included in its Mac artifact hashes or test totals above. It must be verified
against a newly built app and refreshed checks before relying on it as
packaged evidence.
