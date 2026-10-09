# IR-11 macOS native publication source and Rust dependency handoff — 2026-09-24

Status: **source graph mapped; published macOS binary not byte-reproducible in this local rebuild; rights and notices not accepted**.

This record follows the exact `@openclaw/fs-safe@0.13.1` and
`@openclaw/fs-safe-darwin-arm64@0.13.1` package pair introduced for IR-03.
The registry signature/attestation evidence is in the
[original candidate record](IR03-ATOMIC-PUBLICATION-NATIVE-POC-2026-09-24.md).
The publisher's annotated `v0.13.1` tag was cloned outside Axterm at commit
`7022a0a10c53e36f34a467df68ed5614a1db1741`. Its root MIT LICENSE has
SHA-256 `8d703995c48aeb3726ab83f111a10ee696835e096802ee0329ac50216ab9434e`;
the `native/Cargo.toml` crate also declares MIT. The published macOS native
subpackage declares MIT but has no own root LICENSE. The Axterm transition
notice currently supplies the parent license with that caveat; a qualified
review must still decide whether it covers every statically included source.

## Local source build and comparison

The exact tagged source's `pnpm-lock.yaml` installed with
`pnpm install --frozen-lockfile`. On this macOS arm64 host, Node 24.18.0,
pnpm 11.25.0, Cargo/rustc 1.98.0 and the installed aarch64-apple-darwin
target ran the native command in the publisher's `.github/workflows/release.yml`:

```sh
pnpm --filter @openclaw/fs-safe-native-build exec napi build --release --platform --target aarch64-apple-darwin --output-dir ../artifacts
```

The source `Cargo.lock` SHA-256 is
`d169c18102ef5a465cf645ceecc15956aafd2f694031d2006284bbcb59284bbd`.
The rebuild succeeded, but **did not reproduce the published bytes**:

| Native `.node`                       |     Bytes | SHA-256                                                            |
| ------------------------------------ | --------: | ------------------------------------------------------------------ |
| Local tagged-source rebuild          | 1,609,928 | `26a6caf7e70aa614d32f32e3c5daab6dba8a8b84ff86f93973802382c7fb2231` |
| Installed, packaged published binary | 1,593,384 | `78ca69b52d05da239bf50a6768867134265aace0195c8494f64f65b6d1ba6db0` |

Both files are Mach-O arm64 shared libraries and expose the same 34 N-API
property names. In separate temporary directories, their `renameNoReplace`
entry points each moved complete bytes while consuming the staging name;
both returned `EEXIST` on a second target and preserved the collision source
and existing final file. This is a narrow semantic comparison, **not** binary
equivalence or a source-to-binary rights conclusion. The local compiler and
build environment may differ from the publisher's macOS runner, but the
reason for the byte difference is not proven. The release workflow fixes
`macos-15`, Node, pnpm and target but does not pin a Rust compiler version.
The later [Mach-O toolchain comparison](IR11-FS-SAFE-MACHO-TOOLCHAIN-2026-09-24.md)
identifies an embedded Rust-1.98.1 fingerprint and the published SDK/linker
versions, then repeats the local build with Rust 1.98.1. It still does not
reproduce the bytes under the available Xcode 27.0 toolchain.

## Native transitive source scope

The machine-readable [Rust source inventory](IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json)
selects the tagged `fs-safe-native` normal Cargo graph for
`aarch64-apple-darwin` using the locked tree. It conservatively includes
proc-macro sources and is **not** a map of precisely linked machine code.
It lists **61 package identities**, all with manifest license declarations,
and hashes **110 published root legal files**. Six package identities have
no root legal file in their own source directory: two project-local crates
covered at repository root (`fs-safe-native`, `fs-safe-archive-core`) and four
`napi`-family crates requiring separate notice/source review. The graph also
contains `bzip2-1.0.6`, `BSD-3-Clause` and a Unicode-3.0 conjunction among
its license expressions; these cannot be reduced to the parent package's
single MIT label without reviewing the chosen license paths and included
source. The current Bun production component index and packaged SPDX sidecar
identify the npm parent/native package, **not** these Rust subcomponents or
their exact per-crate copyright text. The later
[root-text package record](IR11-FS-SAFE-RUST-ROOT-TEXTS-2026-09-24.md)
preserves all 110 available source-root legal files in the macOS app and
Legal/About; it does not determine license applicability or complete the
remaining file-level and binary review.

## Release implication

The npm provenance attestation and successful macOS runtime/FAT16 tests prove
different things from a full native source, binary and license audit. Before
IR-02/IR-11 acceptance, retain applicable Rust dependency texts and copyright
attribution in source, Legal/About and every actual platform installer;
review the exact compiled dependency set (including Windows/Linux target
branches), resolve the four `napi`-family missing root files, and either
reproduce the released binary under a matched toolchain or retain a qualified
source-to-binary explanation. No status or legal clearance is inferred here.
