# Product asset provenance — P-05 / IR-07 transition ledger

Updated: 2026-09-24  
State: **inventory in progress; authorship, trademark and platform review pending**

This record distinguishes a source or package match from a rights clearance.
`bun run package:dir` currently produces an unsigned macOS arm64 directory app;
the checks below do not establish Windows/Linux package contents or the right
to represent every asset as Axterm-owned. Historical Legacy Prototype comparison images
must not be copied into the final independent repository.

`AXTERM_PRODUCT_ASSETS.json` is the generated, deterministic content inventory
for the five first-party application-mark files named below. `bun run
assets:check` is part of the repository-wide `bun run check`, so a byte change,
missing asset or stale ledger fails before packaging. A macOS packaged-app test
also hashes `Contents/Resources/icon.icns` and compares it to that source
inventory. `bun run icons:check` regenerates the 1024px PNG, 512px PNG, ICO and
ICNS into an isolated temporary directory and compares their bytes to the
checked-in variants without rewriting the worktree. Its macOS-only integration
test is part of `bun run check`; other operating systems skip the platform tool
check, while the macOS CI leg executes it. The record deliberately does **not**
infer authorship, copyright,
trademark availability or public-snapshot approval from a matching hash; those
remain human review tasks. It also does not replace the separate third-party
font, renderer-bundle and native/WASM inventories.

`PRODUCT_ASSET_REVIEW_LEDGER.json` is the matching machine-readable hand-off
for those same five product-mark files. `bun run assets:marks:check` is part of
the normal engineering gate: it rejects a stale asset scope or malformed review
claim while allowing a truthful `pending` record during development. Before the
_product-mark_ scope can be described as reviewed, the release owner must run
`bun run assets:marks:reviewed-check`; it requires a recorded rights review,
brand review, date, evidence, conclusion and explicit `retain`/`exclude`
decision for every current asset byte. That command does not establish a legal
conclusion, clear third-party assets or promote IR-07 by itself.

`docs/product/assets/` is deliberately absent from the independent public
source candidate. `bun run snapshot:check` rejects that directory if it is
reintroduced; it is not silently filtered out while preparing the candidate.
This prevents a documentation-only image from bypassing the five-file
application-mark inventory and its review ledger. A future approved
documentation asset requires an explicit scope and gate change, rather than
being added to that retired directory.

## Product mark and static images

| Asset                                                                  | Current source evidence                                                                                                                                                                                                                                                                                                                         | Current disposition                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/build/icon.svg`                                          | [Brand record](../product/AXTERM_BRAND.md) calls this the editable AX-monogram source. `bun run icons:generate` derives the package variants with macOS `sips` and `iconutil`; `AXTERM_PRODUCT_ASSETS.json` is the current exact byte record. Git history only establishes that the source was present in the initial 2026-09-14 Axterm commit. | Retain provisionally. Obtain the creator/owner's design-rights attestation and independent trademark/visual-similarity review.                                                      |
| `apps/desktop/build/icon.png`, `icon-512.png`, `icon.ico`, `icon.icns` | Regenerated from `icon.svg` by `bun run icons:generate`. The command emits a 1024px PNG, 512px PNG, Windows multi-resolution ICO and macOS ICNS; the generated inventory records their exact current hashes.                                                                                                                                    | Mac package's `Contents/Resources/icon.icns` matches source byte-for-byte. Verify visual consistency and generation provenance; inspect actual Windows/Linux installers separately. |

The product mark is not an Legacy Prototype logo by file name or package reference;
that observation is **not** a copyright or trademark non-infringement finding.

## Bundled font and remote-protocol assets

| Asset in current macOS package                          | Source and binary evidence                                                                                                                                                                                                                                                                                                                                                                                         | Rights/distribution follow-up                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two Maple Mono 400 Latin WOFF/WOFF2 files in `app.asar` | Source `@fontsource/maple-mono@5.3.0` files and built renderer files are byte-identical: WOFF SHA-256 `94d928102e2ceb03671703e4eaffb6325392d21372a605fab31956caeefe2ba0`, WOFF2 `0f900ecac7020d4251bd5b7c963570d998f3dc1cd195e468f7c9d9902e5556a1`.                                                                                                                                                                | The transition notice carries the package's SIL OFL 1.1 text and Reserved Font Name. Confirm exact installed font files and notice access on Windows/Linux; avoid implying the font is Axterm-owned.                                                                  |
| Official IronRDP RDP backend JS with embedded WASM      | `@devolutions/iron-remote-desktop-rdp@0.7.0` replaces `ironrdp-wasm@1.1.0` from the Legacy Prototype GitHub organization. The installed package and renderer bundle have identical embedded WASM bytes (4,511,023 bytes; SHA-256 `68b5c65280e5348ea418cd0aba2e4e28f9bd4051c2cf9fd4b84d721847ef3363`). `scripts/packaging-check.mjs` rejects the retired standalone WASM and checks this source-to-bundle identity. | The npm manifest declares `MIT OR Apache-2.0` but its tarball omits a standalone license file. Axterm's transition notice identifies the Apache-2.0 option and package authors; a qualified source/rights review and real RDP interoperability test remain necessary. |
| noVNC and `spice-client` renderer bundles               | Both are listed in the actual `app.asar` renderer assets and have separate provenance/notice entries in [THIRD_PARTY_LICENSE_AUDIT](THIRD_PARTY_LICENSE_AUDIT.md).                                                                                                                                                                                                                                                 | Their MPL/LGPL and file-level distribution obligations remain open; an asset name or package license label alone does not clear them.                                                                                                                                 |

The refreshed unsigned macOS arm64 `package:dir` app contains 11 renderer asset
files and 89 package manifests. Its `app.asar` SHA-256 is
`63950c826ba51c274a3868b48798af8a2e0a6e0d7927baf84ae36e1884072185`;
source and packaged `THIRD_PARTY_NOTICES.txt` both hash to
`05966a21da8d98bc7e909c7648cbeda3fad627a7c437390843696f1320b14c88`.
The copied-outside-checkout packaged app initializes the official RDP backend
under the production CSP; this proves module/WASM load, **not** a live RDP
session, authentication, clipboard or input interoperability.

## Historical visual corpus and exit gate

The former `tests/parity/screenshots/legacy-prototype/` upstream reference captures and
Axterm's old paired comparison screenshots have been removed from the current
working tree. They are historical evidence only and belong in a controlled
archive outside the final public snapshot; `snapshot:check` rejects
`tests/parity/` if it is reintroduced. The separate
[Axterm visual baseline](AXTERM_VISUAL_BASELINE.md) now covers source Electron
Shell and Settings at three viewports, plus retained migration surfaces, with
macOS golden images. Contrast, dialogs, installed-app images, platform-specific
baselines and reviewed brand acceptance remain open.

IR-07 remains **In progress**, not Accepted, until the mark's author/permission
and brand review, deterministic variant provenance or approved replacements,
cross-platform package inspections and historical-reference removal have review
evidence. IR-02 and IR-11 remain separate source-rights and notice gates.
