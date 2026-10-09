# IR-11 — macOS fs-safe Cargo source-scope SPDX inventory

Date: 2026-09-24  
Status: engineering inventory only; **not legal or release clearance**

## Scope and result

`AXTERM_FS_SAFE_MACOS_CARGO_SOURCE.spdx.json` is a deterministic SPDX 2.3
inventory of the 61 normal Cargo package identities in the pinned
`@openclaw/fs-safe@0.13.1` source tree. Its input is
`IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json`, which records the upstream
tag, commit, Cargo.lock hash, package versions, manifest license declarations
and available root legal-file hashes. The source SPDX SHA-256 is
`4a457b6817f1d4a1f85458b19fa83f995db01b0200959db274887b59f074ed7d`.

This is a **separate source scope** from the Bun production dependency SPDX and
the SPDX sidecar generated from a particular packaged app. The Cargo graph
includes build-time/proc-macro packages; inclusion does not mean every package
was linked into the published `.node`. Every package's concluded and declared
SPDX license is `NOASSERTION`. Manifest license strings and 110 available root
texts are leads for qualified review, not a selected dual-license option or a
file-level rights finding. The 61 source-package decisions and one published
binary decision remain pending in `NATIVE_DEPENDENCY_REVIEW_LEDGER.json`.
Nine package entries also carry the
[source-header candidate counts and digests](IR11-FS-SAFE-SOURCE-HEADER-CANDIDATES-2026-09-24.md);
the SPDX comments preserve these review leads without concluding that the
files entered the published native binding.

The optional artifact comparison verified the existing unsigned macOS arm64
`Axterm.app` Resources directory and its exact packaged SPDX sidecar. The
observed `fs-safe-native.node` SHA-256 is
`78ca69b52d05da239bf50a6768867134265aace0195c8494f64f65b6d1ba6db0`;
the observed `app.asar` SHA-256 is
`999aa1b3f697298ae83799514dc917d34380fe115fdbbee5046fc5a2f71f34ad`.
The comparison also checked the installed npm package identity and the bytes
of the four then-packaged native legal supplements: the fs-safe Rust root-text
archive, napi-rs MIT text and two nested Zstandard legal files. The later
source-header candidate bundle adds a fifth material to the artifact gate;
the historical hash above predates that addition. This does **not** infer
the binary's exact Rust crate linkage from its file hash. The separate
[npm attestation record](IR11-FS-SAFE-NPM-ATTESTED-PROVENANCE-2026-09-24.md)
addresses publication-to-installed-byte identity; the local tagged-source
rebuild still differs from the published binary.

## Reproduction

From a frozen repository install:

```sh
bun run sbom:native:macos:check
bun run sbom:native:macos:artifact-check -- \
  /path/to/Axterm.app/Contents/Resources \
  /path/to/AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json
```

The first command is part of `bun run check`; it fails if the committed SPDX
bytes drift from the pinned source inventory. The second is macOS arm64-only:
it re-inventories a concrete package, verifies the complete packaged SPDX
sidecar and compares native module, package identity and legal-supplement
bytes. Regenerate only after source-scope review with
`bun run sbom:native:macos:generate`.

The full `bun run check` passed after this addition: 229 unit/integration test
files passed (1,153 tests passed, 34 skipped), architecture and Contract gates
passed, the native source SPDX matched its pinned input, and all 11
visual/accessibility journeys passed.

## Remaining acceptance work

Qualified reviewers must determine the actual binary's source/component
lineage, applicable license choices, file-level attribution and nested notices;
explain or reproduce the published/local binary difference; and sign the 62
native review entries. A final signed/notarized macOS installer needs its own
packaged sidecar and installation review. Windows/Linux source and artifact
scopes remain separate platform work. IR-02 and IR-11 remain **In progress**.
