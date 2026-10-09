# IR-11 — published IronRDP crates without their own root legal files

Date: 2026-09-24  
Status: publisher-source text preservation; **not license or source-to-WASM clearance**

The [WASM-target source inventory](IR11-IRONRDP-WASM-SOURCE-SCOPE-2026-09-24.md)
identifies six crates.io archives in the pinned `ironrdp-web` normal/build graph
that contain no legal file at their own package root. This supplement preserves
both `LICENSE-APACHE` and `LICENSE-MIT` from each published crate's declared
repository at its exact `.cargo_vcs_info.json` commit. It does not replace the
470 already preserved package/upstream root files.

| Published crate                    | Publisher repository  | Exact commit                               |
| ---------------------------------- | --------------------- | ------------------------------------------ |
| `asn1-rs-impl@0.2.0`               | `rusticata/asn1-rs`   | `a20e5f7319c896737ad0f2557037817b91ad854f` |
| `gloo-net@0.7.0`                   | `rustwasm/gloo`       | `d69fcff62ee63f37076c4a0715a6f828b0036599` |
| `gloo-timers@0.4.0`                | `rustwasm/gloo`       | `c8feeb18bf5dde6b7aed80c749e1aef89b34fb52` |
| `gloo-utils@0.3.0`                 | `rustwasm/gloo`       | `e6280d4b93c86a478a8f2f31af5f13d770b156b7` |
| `rustcrypto-ff_derive@0.14.0-rc.0` | `zkcrypto/ff`         | `8417973539baabf561975144e0a68d166d0f9a95` |
| `winscard@0.3.2`                   | `Devolutions/sspi-rs` | `fee71292aa03c569caeb44ec2782f3b5598f20c8` |

For each entry, `scripts/commercialization/ironrdp-missing-root-licenses.mjs`
checks the `.crate` archive SHA-256 against the locked source inventory,
confirms its VCS commit and path, and byte-compares the published `src/lib.rs`
with the file at that immutable publisher commit. It then captures the two
repository-root legal texts with their original bytes and individual hashes.
The deterministic [record](IR11-IRONRDP-MISSING-CRATE-ROOT-TEXTS-2026-09-24.json)
has SHA-256
`91695e3bd448ff1464247288f1000f55314f39a7a0a17df934079dd313c24b3a`.
The 12-text `licenses/IronRDP-MISSING-CRATE-ROOT-LICENSES.txt` bundle is 75,782
bytes, SHA-256
`7768aaf3d75c05f6c75923fbecad728e3c9325c05268098db3a6ac8e8b2851b0`.
The bundle is a separate third-party notice in packaged `licenses/` and
Legal/About.

An isolated unsigned macOS arm64 directory app built after this supplement
has `app.asar` SHA-256
`81cbd9b4fb880c8b06d81299806cee1a3baee3ccd1bdb8437cd0ad5f7dbac364`.
Its complete packaged SPDX sidecar re-verified against that app with SHA-256
`81f5f27cc40ce5b34843ccb0d80c489d71670d309047f9e3671de22c1fe0dfeb`.
The actual external legal file has the same SHA-256 as the source bundle;
`licenses:ironrdp:source:artifact-check` also confirmed the packaged
IronRDP WASM hash
`68b5c65280e5348ea418cd0aba2e4e28f9bd4051c2cf9fd4b84d721847ef3363`.
This is Mac directory-app evidence, not a signed/notarized installer.
The complete macOS packaged Playwright suite passed **22 applicable journeys**
with 11 platform/fixture skips. It included exact Legal/About text comparison
against every source `licenses/*.txt` file and official IronRDP initialization
outside the checkout; it did not exercise a live RDP server.
The follow-up `bun run check` passed 232 unit/integration files (1,164 tests
passed, 34 skipped), the Level 1 architecture check over 360 modules/1,310
dependencies, 267 Contract operations, source/legal checks, production build,
and all 11 visual/accessibility journeys. The final-public composite check
passed the new missing-root-text prerequisite but correctly left nine other
prerequisites blocked and skipped the final snapshot.

Reproduce the offline checks from the frozen Axterm install with
`bun run licenses:ironrdp:missing:check`. To recheck publisher sources, first
obtain those four official repositories with the exact commits above and the
locked crates.io archives, then run:

```sh
bun run licenses:ironrdp:missing:source-check -- \
  /path/to/gloo /path/to/asn1-rs /path/to/ff /path/to/sspi-rs
```

The source check passed against four temporary publisher checkouts and the
locked Cargo cache on 2026-09-24. Matching one `src/lib.rs` per crate is a
cross-check, **not** a comparison of every published source file. Repository
root texts need not be present in the published crate itself; this bundle
explicitly labels that provenance rather than representing them as archived
crate contents. Five IronRDP workspace crates still have no own root legal
file, though the tagged upstream root texts are preserved separately.
Nested/file-level attributions, whether each crate actually contributes bytes
to the published WASM, the exact Rust source-to-WASM build and each
dual-license option still need qualified review. All 260 review-ledger entries
remain pending, and IR-02/IR-11 remain **In progress**.
