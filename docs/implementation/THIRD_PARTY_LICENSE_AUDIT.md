# Third-party license audit — transition evidence

Updated: 2026-09-25  
Release gate: [IR-02 and IR-11](INDEPENDENT_RELEASE_MATRIX.md)  
Status: **incomplete; do not use this record as legal release clearance**

## Reproducible installed-package inventory

The 2026-09-24 macOS arm64 native-publication trial changed the **current**
frozen production graph to **140 component entries** and the generated legal
archive to **132 root-license files**. The `@openclaw/fs-safe@0.13.1` parent
package has an exact MIT root LICENSE; its installed macOS arm64 native
subpackage declares MIT in its manifest but has no root LICENSE or copyright
line. The latter is explicitly named in `THIRD_PARTY_NOTICES.txt` and remains
pending in `LICENSE_ATTRIBUTION_REVIEW_LEDGER.json`. The graph also contains
additional transitive missing-notice entries; the generated archive and review
ledger, not the historical figures below, are the current machine-readable
scope. The unsigned macOS DMG's exact package contents and SPDX receipt are
recorded in [the native-publication trial](evidence/IR03-MACOS-ARM64-NATIVE-PUBLICATION-2026-09-24.md).
These mechanical updates do **not** clear source-to-binary rights or IR-11.

The native addition requires a **second dependency audit scope** beyond Bun:
the macOS arm64 `fs-safe-native` Rust source graph. The pinned source's locked
normal Cargo tree contains **61** package identities and **110** root legal
files; six package directories lack their own root text. The exact inventory
and local rebuild comparison are in the
[native-source handoff](evidence/IR11-FS-SAFE-NATIVE-SOURCE-2026-09-24.md).
The local tagged-source rebuild loaded and matched the published native
binding's 34 exported names and the required no-replace behavior, but its
bytes differ. The npm component index and packaged SPDX sidecar do **not**
enumerate these Rust subcomponents as source-to-binary packages. A separate
[macOS Cargo source-scope SPDX inventory](evidence/IR11-FS-SAFE-MACOS-SOURCE-SBOM-2026-09-24.md)
now enumerates all 61 pinned source identities without asserting which crates
were linked into the published binding or selecting their applicable licenses.
The later [macOS root-text record](evidence/IR11-FS-SAFE-RUST-ROOT-TEXTS-2026-09-24.md)
preserves the parent MIT file and all 110 available root legal texts in
`licenses/fs-safe-rust-ROOT-LICENSES.txt`, `THIRD_PARTY_NOTICES.txt`, the
installed macOS legal directory and Legal/About. This solves delivery of the
known root texts, **not** their applicable license choices, complete copyright
attribution, nested notices or binary origin. A separate
[source-header candidate sweep](evidence/IR11-FS-SAFE-SOURCE-HEADER-CANDIDATES-2026-09-24.md)
examined 2,157 code files in the same graph. Its 156 copyright/SPDX lines
from 156 files across nine packages are retained in
`licenses/fs-safe-SOURCE-HEADER-ATTRIBUTIONS.txt`, with the matching files
byte-compared to published crates or the pinned upstream commit. The ledger
and source SPDX include per-package candidate counts/digests. This is a
bounded review aid, not complete file-level rights or binary-linkage proof.
`NATIVE_DEPENDENCY_REVIEW_LEDGER.json`
records 61 pending package reviews plus one pending published-binary review.
The routine `licenses:native:check`, `licenses:native:texts:check` and
`licenses:native:headers:check` validate scope/texts without granting
approval; the final public gate requires both text and header checks and
`licenses:native:reviewed-check`. Windows/Linux target
graphs and final platform notices still need separate review.

The four `napi`-family missing-root crates now have a separate
[published-source mapping](evidence/IR11-NAPI-RS-PUBLISHED-SOURCE-2026-09-24.md):
their locked `.crate` checksums, embedded VCS commits and 116 packaged source
files match the official repository, whose identical root two-block MIT text
is preserved at `licenses/napi-rs-LICENSE.txt`. The current macOS package and
Legal/About include it. `licenses:napi:check` guards this supplement offline;
the optional `licenses:napi:source-check` replays the source comparison with
local pinned checkouts and Cargo cache. This is not a complete copyright,
nested-source, binary-linkage or license-applicability conclusion.

The published `fs-safe` macOS `.node` is now checked by byte hash from the
**installed optional package** during the routine native review-ledger gate;
the hash is not inferred solely from package metadata. A
[Mach-O/toolchain comparison](evidence/IR11-FS-SAFE-MACHO-TOOLCHAIN-2026-09-24.md)
matched its embedded Rust compiler fingerprint with a local Rust-1.98.1
rebuild, but the published file still differs under the local SDK 27.0/linker
27037.1 versus its recorded SDK 15.5/linker 1167.5. This narrows the
reproducibility investigation without clearing source-to-binary or legal
review; the published-binary ledger entry remains pending.

The later [official npm provenance chain](evidence/IR11-FS-SAFE-NPM-ATTESTED-PROVENANCE-2026-09-24.md)
now verifies the pinned macOS arm64 package's registry signature and SLSA
attestation against npm's official registry. Its tarball subject digest,
upstream `v0.13.1` source commit/successful release workflow, extracted
`.node`, frozen local installation and unsigned macOS package's `.node` all
match the recorded identities. This resolves an **npm publication-to-installed
binding identity** gap; it does not make the nonmatching local rebuild
reproducible or approve source rights and license obligations. The repeatable
online command is `bun run licenses:native:provenance:macos -- --app <Axterm.app>`;
it is separate from the offline routine check and keeps the native review
ledger pending.

The pinned `zstd-sys@2.1.0+zstd.1.5.7` Cargo archive contains two additional
legal files under its vendored `zstd/` directory. The original Zstandard
BSD-style `LICENSE` and GPLv2 `COPYING` are now preserved separately at
`licenses/zstd-sys-Zstandard-LICENSE.txt` and
`licenses/zstd-sys-Zstandard-COPYING.txt`, and included in the macOS legal
directory and Legal/About. Its C source headers describe these as alternative
license choices; packaging both is conservative preservation, **not** a GPL
selection or a determination of applicable binary obligations. The archive,
source-file hashes, checks and remaining limits are recorded in the
[nested Zstandard evidence](evidence/IR11-ZSTD-NESTED-LEGAL-2026-09-24.md).
`licenses:zstd:embedded:check` is in the routine and final-public gates; it
does not sign off IR-02/IR-11 or replace source-to-binary review.

Run `bun pm licenses --json --prod` from the repository root after a frozen install. The 2026-09-20 working tree reports 120 package records (125 distinct name/version entries): 101 MIT records, 6 ISC, 4 BlueOak-1.0.0, 2 Apache-2.0, and one each of BSD-3-Clause, LGPL-3.0-or-later, `(MIT AND Zlib)`, `MIT OR Apache-2.0`, MPL-2.0, OFL-1.1 and Unlicense. The dual-license record is `@devolutions/iron-remote-desktop-rdp@0.7.0`. These are package-manifest declarations, **not** a complete installed-binary SBOM or proof that all bundled source files follow only the package-level license. The command excludes development dependencies but can include transitive packages not ultimately retained by the bundled renderer or Runtime; it does not enumerate Electron/Chromium, native binary internals, copied sources, fonts/images inside packages, or generated assets.

The current [production component index](evidence/IR11-COMPONENT-INDEX-2026-09-20.md)
records those 125 name/version/license entries in `THIRD_PARTY_COMPONENTS.json`.
It is generated and checked without `vendor/legacy-prototype`, copied outside ASAR and
readable in About. The macOS package test ensures every non-workspace ASAR
manifest identity and license declaration appears in the index. This closes a
metadata-list gap, **not** the exact per-component copyright/NOTICE or SBOM
requirements below.

`AXTERM_PRODUCTION_DEPENDENCIES.spdx.json` is now a deterministic SPDX 2.3
rendering of the same frozen production graph. On 2026-09-21 it contains 125
package identities, has SHA-256
`02e91008c35e1a368b90ec55f280c459158727b8c78c291fdf7df634da55e80b`, and
uses a namespace derived from the package version and component identities.
`bun run sbom:check` runs in the default gate; the document is included next to
the application and exposed in About. It deliberately records `NOASSERTION`
for concluded/declared SPDX licenses while preserving the manifest declaration
as a comment, because package metadata is not qualified file-level rights
evidence. It is a reproducible **source dependency inventory**, not the
platform-artifact SBOM required for IR-02/IR-11 acceptance.

The newer [production root-license text archive](evidence/IR11-LICENSE-TEXTS-2026-09-20.md)
preserves 119 exact installed root LICENSE/COPYING/NOTICE files, with content
and SHA-256, across the same 125 production graph entries. Six entries have
no published root file and are listed explicitly. The default check detects
drift, and the macOS package test compares the archive to both the source and
actual ASAR root-license-file hashes; About exposes each recorded file. This
closes another mechanical text-availability gap, **not** file-level notices,
source-to-binary provenance or distribution obligations.

The same generated archive now records a mechanical attribution-review view:
each component retains role-tagged exact package-manifest author/contributor
values (including published object fields), its non-empty `copyright` field and
the exact `Copyright` or `©` declaration lines found in its archived root
legal files, including optional Markdown heading markers. At the 2026-09-21
baseline it identified eight
packages with neither copyright declaration—`@devolutions/iron-remote-desktop-rdp`,
`@hono/zod-openapi`, `@hono/zod-validator`, `@novnc/novnc`,
`@xterm/addon-serialize`, `@xterm/headless`, `drizzle-orm` and `tweetnacl`.
Manifest authors are publisher metadata, not a legal inference or replacement
for a copyright notice, so those eight formed an explicit human-review queue.
The generated metadata and its exact About/package rendering are documented in
[IR-11 package attribution metadata](evidence/IR11-PACKAGE-ATTRIBUTION-2026-09-21.md).

For two entries in that queue, the installed `@hono/zod-openapi@1.6.3` and
`@hono/zod-validator@0.9.1` READMEs now have byte-identical matches at their
official release tags. Both name Yusuke Wada as author and declare MIT; their
tag commits and README hashes are pinned in the
[Hono declaration record](evidence/IR11-HONO-MIDDLEWARE-DECLARATIONS-2026-09-23.md).
The transition notice now exposes that publisher evidence beside the common
MIT terms. It does not invent a copyright year or promote either pending
attribution-review ledger entry to `reviewed`: the package-specific copyright
notice and complete source-to-binary/rightsholder assessment remain open.

For the `tweetnacl@0.14.5` queue entry, the installed README refers to its
`AUTHORS.md`; both that author/source-chain file and the installed Unlicense
text match official source tag `v0.14.5` at commit
`cce829e473b1ae299a9373b5140c713ee88f577f` byte-for-byte. The exact
authors file is now distributed as `licenses/tweetnacl-AUTHORS.txt` and named
in the transition notice. It credits the JavaScript contributors and the
TweetNaCl/Poly1305-donna public-domain input authors, without inferring legal
ownership. The machine-generated queue remains eight entries and this record
does not promote the pending human-review status; see the
[TweetNaCl source record](evidence/IR11-TWEETNACL-AUTHORS-2026-09-23.md).

The [2026-09-25 Markdown-heading correction](evidence/IR11-MARKDOWN-LICENSE-HEADINGS-2026-09-25.md)
then found that the installed MIT license files for `lie@3.3.0` and
`process-nextick-args@2.0.1` already contained publisher copyright lines,
but the extraction rule missed their `#Copyright` / `# Copyright` headings.
The archived legal bytes are unchanged; exact heading lines are now visible
in the generated archive, the unsigned macOS package and About. The current
specialized missing-declaration queue contains **10 pending packages** (the
original eight plus `isarray` and the macOS `fs-safe` binary package, with
the two heading false positives removed). The queue reduction is not a
qualified rights decision or a complete dependency/license audit.

The [isarray 1.0.0 publisher-source record](evidence/IR11-ISARRAY-README-SOURCE-2026-09-25.md)
then pins the package's official `v1.0.0` tag and its byte-identical installed
README, executable and manifest. The published tarball lacks a standalone
root LICENSE, but that exact README contains full MIT terms and a publisher
copyright line. Axterm now preserves it as `licenses/isarray-README.txt` in
source, the unsigned macOS package and About/Legal. The mechanical missing-root
and specialized attribution queues remain unchanged because the package's
root license file is still absent and a supplemental README is not a
qualified rights review.

The published `@xterm/headless@6.0.0` CommonJS source map also reveals eleven
embedded `out/vs/base/common/*.js` modules with Microsoft Corporation
copyright and MIT-license headers. The xterm.js root MIT text does not name
that separate source chain. The official VS Code MIT text is now retained as
`licenses/xterm-headless-vscode-LICENSE.txt`, and the transition notice names
the embedded modules and copyright line; see the
[xterm headless/VS Code record](evidence/IR11-XTERM-HEADLESS-VSCODE-2026-09-23.md).
All 45 TypeScript source-map entries also match the official xterm.js 6.0.0
tag byte-for-byte, and the eleven VS Code map paths have corresponding tagged
TypeScript sources with Microsoft headers. This closes a concrete missing
notice and narrows xterm publisher provenance, not the exact upstream VS Code
revision, a reproducible compiled bundle or the `@xterm/headless` human-review
queue entry.

`LICENSE_ATTRIBUTION_REVIEW_LEDGER.json` turns that exact queue into a
versioned human-review hand-off. Its scope hash must match the generated
archive; `bun run licenses:attribution:check` is part of the default gate, so
an added, removed or silently reordered queued package fails validation. A
pending record deliberately has no reviewer, date, evidence or conclusion. A
`reviewed` or `needs-follow-up` record requires all four, including a primary
source/notice reference and an explicit conclusion. Regeneration preserves a
matching record's review fields while replacing a changed package scope; it is
therefore safe for dependency-graph updates but cannot turn this mechanical
ledger into copyright, source-rights, attribution or distribution clearance.
`bun run licenses:attribution:reviewed-check` is intentionally stricter: every
current queue entry must be `reviewed`; `pending` and `needs-follow-up` fail.
The final-public source gate invokes this stricter check after regenerability
checks, preventing a migration-removal release from treating a merely valid
handoff ledger as a completed attribution review.

The reproducible [dependency vulnerability audit](evidence/IR11-DEPENDENCY-AUDIT-2026-09-21.md)
uses the official npm advisory endpoint in CI because the configured package mirror
does not implement Bun's advisory-bulk API. It caught a moderate development-chain
`esbuild@0.18.20` resolution introduced by `drizzle-kit`; the root Bun override now
resolves every `esbuild` instance to 0.28.2, after which both full and production
audit queries return no advisories. This is time-bound advisory evidence, not a
complete binary, source, license or release-security review.

The [six missing-root-file follow-up](evidence/IR11-MISSING-ROOT-LICENSES-2026-09-20.md)
adds the exact official Drizzle ORM 0.45.2 Apache text to `licenses/` and maps
the xterm.js 6.0.0 root MIT text to the headless package with a publication
lineage caveat. The two matching Hono middleware source tags also lack
LICENSE/COPYING/NOTICE files, so their exact copyright notices remain a
publisher/qualified-review question. The generated archive intentionally
continues to report all six package-internal omissions; neither an external
text copy nor an SPDX manifest label is silently counted as a root file.

## Reproducible packaged-file inventory

Run `bun run licenses:packaged:inventory release/mac-arm64/Axterm.app/Contents/Resources` after `bun run package:dir`; on Windows and Linux pass the corresponding directory containing `app.asar`. The JSON report records the ASAR SHA-256, every package manifest immediately under any `node_modules` level, its declared license, metadata source and root LICENSE/COPYING/NOTICE file hashes, renderer asset paths, each unpacked file hash, and external legal-file hashes. It recognizes singular `license` and legacy `licenses` arrays; multiple legacy declarations remain separate instead of inventing an AND/OR relationship. It deliberately does **not** infer that a package's manifest license applies to every individual file or that a packaged file is reachable at runtime. The script uses electron-builder's installed ASAR reader and is covered by a nested-package fixture test.

`bun run sbom:packaged -- <Resources directory> --platform <platform-arch> --output <sidecar>`
converts that concrete inventory into a deterministic SPDX 2.3 release sidecar.
It binds the document namespace to the product version, required platform label
and observed ASAR SHA-256; it records package identities and the hashes of the
ASAR, renderer assets, unpacked files, external legal material and available
Electron/Chromium legal documents. It must be regenerated for every signed
macOS, Windows and Linux artifact and preserved next to its release hashes.
Because it is generated after packaging, it avoids a self-referential signed-app
hash; it is not packaged into the app and does not claim a complete
source-to-binary map or legal clearance.
The three-platform CI workflow generates and uploads one sidecar after its
macOS, Windows and Linux package build. A successful CI artifact proves only
that the command completed against that runner's unpacked directory; final
release review still needs the signed/notarized installer and installed-product
hashes.
The current macOS directory-artifact command, hashes and explicit limits are in
[IR-11 packaged-artifact SPDX sidecar evidence](evidence/IR11-PACKAGED-ARTIFACT-SBOM-2026-09-21.md).

For the rebuilt 2026-09-20 macOS arm64 `package:dir` build, `app.asar` SHA-256 is `590f2ffa18fcad5100dca8c738b649f1209810db4b4bd9bef33da1978f2a2571`. The report finds 89 package instances (89 unique name/version pairs), 12 renderer asset files, 204 `app.asar.unpacked` files (including four `.node` binaries from the Electron-ABI rebuild), and 10 external legal files. The previous macOS package contained 227 unpacked files and 25 `.node` binaries, including non-macOS prebuilds. Both native modules load their `build/Release` binaries before prebuilds; `electron-builder.yml` now excludes both published `prebuilds` directories on all platforms. The new macOS ASAR and unpacked tree contain no such paths; a packaged app copied outside the checkout passed local PTY, terminal search, serial enumeration, SQLite and restart tests. A packaged inventory test guards the exclusion and rebuilt-binary presence. Windows/Linux packaging and installed-app evidence remain open. The 119 Bun production records and 89 ASAR manifests have different scopes; neither count is a complete source-to-binary map, because bundling inlines dependencies and Electron/Chromium and other external assets sit outside ASAR.

The inventory now separately records legal materials supplied by the Electron
runtime, rather than misclassifying them as Axterm `extraResources`. It searches
the target's Resources directory and its artifact root for the expected
`LICENSE.electron.txt` and `LICENSES.chromium.html`, records artifact-relative
paths and SHA-256 values, and the macOS package test compares both byte-for-byte
with the installed Electron 44.3.0 distribution's `dist/LICENSE` and
`dist/LICENSES.chromium.html`. The current macOS evidence and exact hashes are
in [IR-11 Electron runtime license materials](evidence/IR11-ELECTRON-RUNTIME-LICENSES-2026-09-21.md).
Settings → About exposes only these two fixed documents via a lazy,
empty-sandbox `axterm-license:` iframe. Electron Main rejects arbitrary paths
and serves the installed documents without business IPC or network access. This
verifies two runtime notices that were already in the package; it neither adds
a complete Electron/Chromium file map nor makes those large documents a
substitute for qualified distribution review.

The artifact-level gaps are now explicit:

| Packaged component                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Follow-up                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildcheck@0.0.7`, `ssh2@1.17.0`            | Their packaged manifests omit singular `license` but each declares `licenses: [{ type: "MIT", ... }]`, names Brian White as author, and ships an identical root `LICENSE` file (SHA-256 `d06b5d27bbbbe22c36b1fd88406b1208876e2d37d795f5b8eaed951a459a3111`).                                                                                                                                                                                                           | The packaged inventory now records `licenseSource: "licenses"` rather than a missing-metadata false positive; its fixture and actual macOS package test guard that mapping. The transition notice retains Brian White's copyright and MIT permission text. File-level/source rights and non-macOS artifacts remain in the final review queue.                                                                                                                     |
| `@xterm/addon-serialize@0.14.0`              | Its packaged manifest says MIT but its published package omits a root LICENSE/COPYING/NOTICE file. The manifest pins commit `f447274f430fd22513f6adbf9862d19524471c04`; its installed `src/SerializeAddon.ts` SHA-256 `a1ed69d294d0e013aafb4e70c9a9a66c36550a410946eddb03a47d66b92a0405` matches the [official source at that commit](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/addons/addon-serialize/src/SerializeAddon.ts). | The exact [root MIT text at that commit](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/LICENSE) is preserved in `licenses/xterm-addon-serialize-LICENSE.txt` (SHA-256 `b569f629d00f2626a8100df2a1798210535621e42164dfd426a6fe5aac7b0ccd`), named in the transition notice and exposed in About/package tests. This closes only this package's identified missing-license-file gap, not the full transitive or platform audit. |
| `@devolutions/iron-remote-desktop-rdp@0.7.0` | The package declares `MIT OR Apache-2.0` but omits a root license file. Its installed JS and Renderer bundle carry identical embedded WASM bytes, SHA-256 `68b5c65280e5348ea418cd0aba2e4e28f9bd4051c2cf9fd4b84d721847ef3363`. The [official source tag and npm tarball](evidence/IR11-IRONRDP-SOURCE-TAG-2026-09-23.md) have matching manifest and package integrity evidence.                                                                                         | The exact upstream Apache text is separately packaged as `licenses/IronRDP-LICENSE-APACHE.txt` and accessible in About; Axterm's root license is not substituted. Embedded WASM source-to-binary mapping, Rust crate/file-level notices, live RDP and final platform rights review remain open.                                                                                                                                                                   |
| `node-pty`, `@serialport/bindings-cpp`       | The rebuilt macOS package has four Electron-ABI `.node` files and no published cross-platform prebuild paths. Axterm's `patches/node-pty@1.1.0.patch` makes a narrow Unix `pty.cc` file-descriptor-accounting correction; the transition notice now identifies the patch and all three copyright lines found in the package's installed MIT LICENSE.                                                                                                                   | Map each shipped binary to source/version/license and verify the same exclusion plus native functionality in final Windows/Linux artifacts. The patch record and packaged notice do not replace source-to-binary or qualified rights review.                                                                                                                                                                                                                      |

An additional 2026-09-23 IronRDP follow-up found the publisher's exact
`npm-iron-remote-desktop-rdp-v0.7.0` tag at commit
`e45f68c7e52297ca50d33b44c0ace36c9940fbe6`. Its public package
manifest matches the locked/published/installed 0.7.0 manifest byte-for-byte;
the official npm tarball integrity also matches `bun.lock`, and all three
tarball files match the local install. The tag's exact `LICENSE-APACHE` is now
packaged separately as `licenses/IronRDP-LICENSE-APACHE.txt` and readable in
About. An earlier audit treated Axterm's customized root `LICENSE` as the RDP
license text; its appendix names Axterm's copyright holder, so it is not the
appropriate third-party attribution file. The table above reflects the
separate publisher text instead.
This narrows publisher-source provenance without proving the embedded WASM
build, all Rust crate notices or final rights clearance. Exact hashes and
limits are in the [IronRDP source-tag record](evidence/IR11-IRONRDP-SOURCE-TAG-2026-09-23.md).

The official npm registry also carries verified publication and SLSA
attestations for that same tarball. An isolated `npm audit signatures` run
against `registry.npmjs.org` verified the package and linked its locked
SHA-512 subject to the same Devolutions commit and successful GitHub publisher
workflow. The opt-in `bun run licenses:ironrdp:provenance-check` now rejects
digest, commit or workflow drift and is wired into Linux CI. This is stronger
publisher-to-tarball evidence, **not** a reproducible embedded-WASM build,
complete Rust notices, qualified rights approval or observed remote CI result;
see the updated [IronRDP record](evidence/IR11-IRONRDP-SOURCE-TAG-2026-09-23.md).

The [WASM-target Rust source-scope record](evidence/IR11-IRONRDP-WASM-SOURCE-SCOPE-2026-09-24.md)
now narrows the tagged release's `ironrdp-web` normal/build graph to 259
source-package identities, separately inventories them in SPDX 2.3, and
preserves 470 available upstream/package-root legal files in
`licenses/IronRDP-RUST-ROOT-LICENSES.txt`. The exact file is accessible in
Legal/About and matched in an unsigned macOS arm64 package; its installed
IronRDP WASM, legal bytes and full packaged SPDX sidecar were compared with
the pinned source-scope target. Six registry crates and five workspace crates
have no legal file in their own root. The six published registry crates now
have a [separate publisher-commit supplement](evidence/IR11-IRONRDP-MISSING-CRATE-ROOT-TEXTS-2026-09-24.md):
their archived VCS commits and one source file per crate match, and 12 exact
repository-root Apache/MIT texts are byte-preserved in
`licenses/IronRDP-MISSING-CRATE-ROOT-LICENSES.txt`. These are expressly
publisher-repository texts, not files asserted to be inside the crate archives.
Build-time/proc-macro inclusion, nested/file-level notices, the unproven
source-to-WASM build and qualified license choices remain explicit; this is
**not** IR-02/IR-11 clearance.
An [archive-checked nested-text sweep](evidence/IR11-IRONRDP-NESTED-SPIN-LICENSE-2026-09-24.md)
found `tracing-core@0.1.36/src/spin/LICENSE` with a distinct Mathijs van de
Nes MIT attribution. Its exact original bytes are separately preserved in
`licenses/tracing-core-spin-LICENSE.txt`, included in About and added to the
`tracing-core` human-review entry. The sweep does not establish linked WASM
content or complete copyright-header/file-level coverage.
The subsequent [source-header candidate sweep](evidence/IR11-IRONRDP-SOURCE-HEADER-CANDIDATES-2026-09-24.md)
scanned 6,958 code files in the same target graph and retained 798 explicit
copyright/SPDX lines from 719 files across 51 packages in
`licenses/IronRDP-SOURCE-HEADER-ATTRIBUTIONS.txt`. Matching files were
byte-compared with their published crate archives or pinned upstream commit.
The package review ledger includes candidate counts and digests. This is a
review aid, not full header-block preservation, exhaustive rights discovery,
proof of inclusion in the WASM, or qualified IR-02/IR-11 approval.
`IRONRDP_DEPENDENCY_REVIEW_LEDGER.json` separately tracks 259 source-package
reviews plus the published WASM, all pending. The routine review-scope check
guards completeness, while the final-public gate requires every entry to have
a named reviewer, primary evidence, license/notice disposition and explicit
conclusion before promotion.

The external legal files are present and hashable. About now has a full
production-graph **metadata** index, but `THIRD_PARTY_NOTICES.txt` and the
currently exposed legal documents are **not** yet a complete per-component
copyright/NOTICE set. The inventory is evidence for review, not release
clearance.

After replacing the RDP dependency, a fresh unsigned macOS arm64
`package:dir` build contains 89 package manifests, 11 Renderer assets and
11 external legal files. Its `app.asar` SHA-256 is
`63950c826ba51c274a3868b48798af8a2e0a6e0d7927baf84ae36e1884072185`;
the source and packaged `THIRD_PARTY_NOTICES.txt` both hash to
`05966a21da8d98bc7e909c7648cbeda3fad627a7c437390843696f1320b14c88`.
The inventory reports two package-internal root-license omissions:
`@xterm/addon-serialize` and the new Devolutions package. The published
Devolutions [manifest/source](https://github.com/Devolutions/IronRDP/tree/master/web-client/iron-remote-desktop-rdp)
and [Apache-2.0 text](https://github.com/Devolutions/IronRDP/blob/master/LICENSE-APACHE)
are references for review, not a source-to-binary certification. Source and
packaged Electron tests initialize the official WASM under production CSP;
neither test establishes a live RDP session.

After mapping the xterm.js add-on, the refreshed unsigned macOS arm64
`package:dir` artifact reports 89 package manifests and 11 external legal
files; `app.asar` SHA-256 is
`2653960c6255e0ba035b19f8d9c909ec70bfb286c1d0feb6af1ac5c262991c06`.
Both packaged license-file and About-view tests pass. The inventory still
reports the add-on package's missing internal root LICENSE, correctly; the
external exact-text mapping in the table below supplies its release notice.

After correcting legacy-license parsing and amending the transition notice,
the newer macOS arm64 `package:dir` artifact has `app.asar` SHA-256
`b3a609d70f4127af167f971c737f44c7c3914add8475ea8f7f184fc3e0a575c1`.
It reports 89 package instances, 11 external legal files, zero missing
license-metadata entries and the one known package-internal root-license gap
for `@xterm/addon-serialize`. The package-file and About tests pass. This
inventory improvement is not a package-by-package rights clearance.

| Component and current version   | Installed evidence                                                                                                                                                                                                                                                                                                                                                                                                                  | Distribution work                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spice-client@1.2.0`            | Renderer imports it dynamically and the production build emits a `spice-client` chunk. Its package manifest says `LGPL-3.0-or-later`, author ZHAO Xudong, and identifies itself as a TypeScript port of SPICE Project's `spice-html5`. Its shipped `LICENSE` names GPL-3.0 and LGPL-3.0 but does not include their full texts.                                                                                                      | The exact package notice and verbatim GNU GPL-3.0/LGPL-3.0 texts now reside under `licenses/`, are copied next to the app, and are readable in About. Determine corresponding-source and relinking/distribution obligations for the actual bundled form with qualified counsel; review source provenance and any changed files.                                                          |
| `@novnc/novnc@1.7.0`            | Renderer imports the RFB core dynamically; the production build emits an `rfb` chunk. The package manifest says `MPL-2.0`. Its `LICENSE.txt` details additional per-file notices, notably `core/crypto/des.js` with AT&T, Widget Workshop and Jef Poskanzer terms.                                                                                                                                                                  | The package notice, MPL-2.0, DES notice and installed BSD-2/3 texts now reside under `licenses/`, are copied next to the app, and are readable in About. Verify exactly which noVNC core, Pako and non-code assets are bundled and fulfill their file-level notices/source availability.                                                                                                 |
| `@fontsource/maple-mono@5.3.0`  | Renderer build contains Maple Mono WOFF/WOFF2. Installed package says OFL-1.1.                                                                                                                                                                                                                                                                                                                                                      | The current `THIRD_PARTY_NOTICES.txt` includes OFL text. Confirm font files, reserved-name rules and all packaged platforms.                                                                                                                                                                                                                                                             |
| `zmodem2@1.4.0`, `trzsz2@1.2.0` | Runtime dependencies from the same named author as Legacy Prototype, separately published under MIT. The zmodem2 publisher describes a port of Jarkko Sakkinen's Rust crate; that crate's MIT text also names Alexey Arbuzov and Jarkko Sakkinen. Axterm locally patches `trzsz2` CJS/ESM receive-timer cleanup, 16-MiB binary-chunk/32-MiB protocol-line bounds and a 64-MiB/4,096-chunk queued-input bound with slot reclamation. | The transition notice preserves installed/upstream attribution and identifies `patches/trzsz2@1.2.0.patch` as a modified third-party component. Axterm-owned protocol wrappers and loopback SSH/PTY binary fixtures are present, but exact translated-code lineage, complete attribution, independently reviewed library-source decision and cross-platform artifact duties remain open. |

The [publisher-source trace](evidence/IR02-TRANSFER-PUBLISHER-SOURCE-2026-09-24.md)
adds exact npm `gitHead` commits and matching installed LICENSE/README hashes
for those two packages. It also records the `trzsz2` package's Legacy Prototype-named
development dependency, which is not present in Axterm's frozen production
graph. The compiled `dist/` files are not committed at those publisher commits;
the installed CommonJS/ESM source maps nevertheless embed eleven executable
TypeScript sources that match those commits byte-for-byte. The exact map and
local bundle hashes are in the [machine-checked source-map record](evidence/IR02-TRANSFER-SOURCE-MAP-2026-09-24.json).
An [isolated Linux arm64 rebuild](evidence/IR02-TRANSFER-REPRODUCIBLE-BUILD-2026-09-24.md)
reproduced both entire installed `dist/` trees after the **2026-09-24 version**
of the declared `trzsz2` patch. A 2026-09-25 repeat also reproduced all 33
current `trzsz2` distribution files after applying the current receive/queue
patch to the pinned publisher-source build; its exact byte pins are in the
source-map record. The maps alone did not prove either rebuild, and neither
maps nor rebuild establish original
authorship, complete attribution or qualified rights approval. The patch
leaves upstream source-map text unchanged.

The `trzsz2` publisher README expressly identifies `trzsz.js` as its source
project. A follow-up checked that project's pre-derivation MIT `LICENSE` at
commit `c87c932d6a800758e425d4b2dd92fd92ba7af58b` and preserved the exact
file as `licenses/trzsz-js-LICENSE.txt` (SHA-256
`9fcfcc727eea90aa6a1568c598a8950c761ed811903684443a762e8aaf9e8492`).
`THIRD_PARTY_NOTICES.txt` now names Lonny Wong's original copyright alongside
the publisher's notice; the Mac package and About view carry the original
license text. This corrects a concrete attribution omission, not every later
distribution-rights question.

The complete GNU texts were copied verbatim from [GNU GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.txt) and [GNU LGPL-3.0](https://www.gnu.org/licenses/lgpl-3.0.txt); their SHA-256 values match fresh fetches on 2026-09-20. MPL/BSD/noVNC texts were copied byte-for-byte from the installed `@novnc/novnc@1.7.0` package. The full [MPL-2.0 license](https://www.mozilla.org/en-US/MPL/2.0/) and [noVNC's license description](https://github.com/novnc/noVNC/blob/master/LICENSE.txt) are primary reference points. These copies preserve text; they do not decide whether LGPL/MPL conditions are satisfied.

The 2026-09-23 artifact-directed follow-up also preserves the exact
`vendor/pako/LICENSE` and root-`LICENSE.txt`-referenced `AUTHORS` from the
installed noVNC package as `licenses/noVNC-pako-LICENSE.txt` and
`licenses/noVNC-AUTHORS.txt`. Source byte-identity tests and two isolated
macOS packaged legal/About journeys pass. The AUTHORS file itself says the
contributor list is incomplete; neither addition settles source ownership,
MPL source-availability duties or other inlined/platform notices. Exact
hashes and limits are in the [IR-11 attribution record](evidence/IR11-PACKAGE-ATTRIBUTION-2026-09-21.md).

The same record now includes a generated RFB import-graph source-header
archive: 52 exact installed noVNC/Pako inputs have SHA-256 entries, with 32
leading legal/source-origin comments preserved and 20 files explicitly marked
as lacking a detected leading notice. The file is copied into the isolated
macOS package and readable in About; its default check detects dependency or
header drift. A companion production Vite manifest now matches all 52 source
hashes to the emitted RFB chunk, verifies that chunk's bytes after build, and
passes the same check inside an isolated macOS ASAR. This helps the file-level
rights review but does not establish MPL source-availability compliance or
clear the remaining packages and platforms.

The actual renderer provenance JSON now also has its own hash-addressed file
entry in the packaged SPDX sidecar, despite being outside the ordinary
`assets/` directory. The generator's obvious SPDX 2.3 file types distinguish
ASAR archives, text/JSON/legal material, images and binaries; the earlier
all-`BINARY` labels were inaccurate. The exact isolated macOS artifact,
sidecar hashes, verification and limits are in the
[packaged-artifact record](evidence/IR11-PACKAGED-ARTIFACT-SBOM-2026-09-21.md).

The installed `spice-client@1.2.0` ESM source map also reveals 30 source
texts, including embedded jsbn, SHA-1/BSD and keyboard-name code with distinct
Tom Wu, Paul Johnston, Thomas Roell and XFree86 notices. A generated
`licenses/spice-client-SOURCE-NOTICES.txt` now preserves their leading comments
and source hashes, is exposed in About and shipped with the app. The Vite
output records the exact ESM/map-to-SPICE-chunk hashes; an isolated macOS
package and its 87-package / 239-file sidecar verify the notice, provenance
JSON and chunk bytes. This is a more complete file-level attribution trail,
not a complete LGPL source/relinking assessment or legal clearance; see
[the SPICE source-attribution record](evidence/IR11-SPICE-SOURCE-ATTRIBUTION-2026-09-23.md).

The publisher's fixed `spice-js` commit now also has a 50-file source/build/test
archive in `licenses/spice-client-1.2.0-source.tar`, exposed beside the app's
notices with an About-visible extraction/rebuild guide. An offline gate verifies
all 30 mapped source texts and the installed package manifest/LICENSE against
the archive. An isolated macOS arm64 extraction rebuilt the exact published
ESM and source map byte-for-byte, passed separate declaration generation and
72 upstream unit tests. This closes a concrete source-copy and reproducibility
gap for that specific library version; counsel must still decide the final
LGPL combined-work/relinking/source-offer obligations and check three-platform
distribution. Exact commands, hashes and exclusions are in the
[same SPICE record](evidence/IR11-SPICE-SOURCE-ATTRIBUTION-2026-09-23.md).

The exact published `@novnc/novnc@1.7.0` npm tarball is now also supplied
as `licenses/noVNC-1.7.0-source.tgz` with an About-visible guide. Its SHA-512
matches `bun.lock`; all 66 archived files are byte-identical to the installed
package, including all 52 RFB/Pako inputs in the existing module-to-chunk
record. The offline gate detects tarball, lockfile, installed-file and
import-graph drift. An isolated macOS package carries both files, passed both
Legal/About journeys and has a matching 87-package / 243-file SPDX sidecar
with the tarball as a separate archive entry. This is a source-copy and
artifact-availability improvement, not completed MPL/attribution or final
three-platform clearance; see
[the noVNC source record](evidence/IR11-NOVNC-SOURCE-AVAILABILITY-2026-09-23.md).

## Still required before IR-02/IR-11 acceptance

The 2026-09-23 [legal-text coverage record](evidence/IR11-LEGAL-TEXT-COVERAGE-2026-09-23.md)
also closes a narrower publication gap: every currently declared top-level
`licenses/*.txt` file is now automatically included in About at build time,
and packaged tests compare the source, packaged and rendered filename sets
and exact contents. This does not discover legal texts that have not yet been
identified and placed in `licenses/`.

1. Extend the packaged-file inventory to a versioned SBOM that maps every **actual macOS, Windows and Linux artifact** to source packages and embedded license-bearing files, including inlined JavaScript, Electron/Chromium, native modules, WASM, fonts and copied/non-code assets. Compare it with the Bun production inventory; investigate mismatches.
2. Preserve exact applicable copyright/NOTICE text for every bundled direct and transitive package, not only license labels or generic MIT text. The current `THIRD_PARTY_NOTICES.txt` explicitly remains incomplete.
3. Obtain qualified review of LGPL/MPL source, modification, relinking and distribution duties for the way Axterm bundles `spice-client` and noVNC. Do not imply that Apache-2.0 on Axterm-owned code relicenses these components.
4. Verify all texts are present in the actual installed macOS/Windows/Linux products and accessible from About. The current macOS `package:dir` test is only one platform and is not a signed/notarized installer test.
5. Re-run the inventory, binary comparison and human review against the final clean repository and final artifact hashes. New dependencies or bundler changes reopen this gate.
