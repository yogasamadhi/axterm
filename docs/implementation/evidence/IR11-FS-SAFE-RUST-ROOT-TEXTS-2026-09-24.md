# IR-11 fs-safe Rust root legal texts in macOS package — 2026-09-24

Status: **available source-root texts preserved and packaged; applicability and rights review still pending**.

The exact tagged `@openclaw/fs-safe@0.13.1` source and locked macOS arm64 Cargo
graph are identified in the [native-source record](IR11-FS-SAFE-NATIVE-SOURCE-2026-09-24.md).
Using that checkout and the downloaded Cargo registry sources,
`bun run licenses:native:texts:generate -- <fs-safe v0.13.1 checkout>` read
the publisher's root `LICENSE` plus **all 110** root `LICENSE`/`COPYING`/`NOTICE`
files named in the [pinned 61-package inventory](IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json).
The generator verified the tagged Git commit, each original-file SHA-256 and
UTF-8 encoding before writing
[`licenses/fs-safe-rust-ROOT-LICENSES.txt`](../../../licenses/fs-safe-rust-ROOT-LICENSES.txt).
This 111-file bundle is 583,719 bytes, SHA-256
`7d5739fef6a518b36e25ab94bd1d80c0205d83c0c41aaa828816a87037227405`.
Length-framed sections preserve original bytes; the routine
`bun run licenses:native:texts:check` parses every section and rejects missing,
altered or trailing content against the pinned source inventory without needing
the upstream checkout or local Cargo cache. The final-public prerequisite set
also runs that check. `THIRD_PARTY_NOTICES.txt` points to the bundle; the app's
Legal/About view automatically includes every top-level `licenses/*.txt` file.

An isolated **unsigned macOS arm64 directory package** was built from this
worktree at `/tmp/axterm-rust-license-4iDiIV/mac-arm64/Axterm.app`. The
installed bundle at `Axterm.app/Contents/licenses/fs-safe-rust-ROOT-LICENSES.txt`
has the same SHA-256. Two actual packaged Playwright journeys passed (2/2):
the license/notices file inventory and the Legal/About contents after copying
the app outside the checkout. The generated artifact-level SPDX sidecar
`/tmp/axterm-rust-license-4iDiIV/AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json`
has SHA-256 `91765d503649e738ef701252432bbcf5796ead9c3dd5c754fbeecea1fb8630d1`
and verified against that exact app (102 packages, 249 files, 350
relationships; `app.asar` SHA-256
`7bae18dac030e757ff1c437cf498795320d41b6061c223c212a1a80bd7a7e5c1`).
These are temporary local artifacts, not signed distribution receipts.

The bundle intentionally contains **all available alternatives**, without
asserting which license branch applies to the actual `.node` binary. Four
`napi`-family packages lack their own root legal file; a later
[published-source supplement](IR11-NAPI-RS-PUBLISHED-SOURCE-2026-09-24.md)
packages their common upstream repository-root MIT text after byte-matching
all 116 published source files to the identified commits. The two project-local
crates are covered only by the publisher's repository-root MIT text. Nested
notices and vendored source, copyright attribution, the precise linked binary
scope, the nonmatching local rebuild, Windows/Linux graphs and a qualified
distribution review remain open. All 61 entries plus the published binary in
`NATIVE_DEPENDENCY_REVIEW_LEDGER.json` remain `pending`. This record does not
promote IR-02/IR-11 or ADR-019.
