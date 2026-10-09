# IR-11 fs-safe macOS Mach-O toolchain comparison — 2026-09-24

Status: **published binary identity checked; compiler fingerprint narrowed; byte reproducibility remains unproven**.

This follows the exact published `@openclaw/fs-safe-darwin-arm64@0.13.1`
binary and the [tagged-source rebuild](IR11-FS-SAFE-NATIVE-SOURCE-2026-09-24.md).
The package is still pinned in Axterm's production graph. On macOS arm64,
`bun run licenses:native:check` now resolves the actual installed optional
`.node` **from the parent package** and hashes its bytes against
`NATIVE_DEPENDENCY_REVIEW_LEDGER.json`'s published-binary identity. A matching
manifest version without the expected binary bytes no longer passes this
routine gate; other platforms do not pretend to possess the macOS optional
package.

## Same tagged source, two local compilers

The `v0.13.1` tag again peeled to
`7022a0a10c53e36f34a467df68ed5614a1db1741`. Its frozen pnpm install and
exact macOS release-workflow `napi build --release --platform --target
aarch64-apple-darwin --output-dir ../artifacts` succeeded twice in a temporary
checkout. The source `Cargo.lock` SHA-256 remained
`d169c18102ef5a465cf645ceecc15956aafd2f694031d2006284bbcb59284bbd`.

| Binary                                       |     Bytes | SHA-256                                                            | Embedded Rust commit                       | Mach-O SDK / linker | `__TEXT` file size |
| -------------------------------------------- | --------: | ------------------------------------------------------------------ | ------------------------------------------ | ------------------- | -----------------: |
| Published, packaged macOS arm64              | 1,593,384 | `78ca69b52d05da239bf50a6768867134265aace0195c8494f64f65b6d1ba6db0` | `48a229ceaefd4985c50990b14116b6d856af0985` | 15.5 / 1167.5       |          1,179,648 |
| Local Rust 1.98.0, Xcode 27.0                | 1,609,928 | `5f2ad0a214473c4f26fdb29aada81c4c6364f85acc53169a3d75d4b0c9ce7e0c` | `88d9e12ae178fab0fb5cc050a94da85685d449ea` | 27.0 / 27037.1      |          1,196,032 |
| Same checkout, local Rust 1.98.1, Xcode 27.0 | 1,609,912 | `6c80d9c7dfeba5cc3c6025d2a392ecb3a9495c6b80597bd4782c907305bf2ca9` | `48a229ceaefd4985c50990b14116b6d856af0985` | 27.0 / 27037.1      |          1,196,032 |

The compiler commit appears in `/rustc/<commit>/` strings embedded in each
binary; it is a **fingerprint**, not an authenticated build log. The
[`1.98.1` Rust source tag](https://github.com/rust-lang/rust/tree/1.98.1)
and local `rustc -Vv` map `48a229...` to Rust 1.98.1. The published Mach-O
`LC_BUILD_VERSION` records SDK 15.5 and `ld` 1167.5, while both local
rebuilds record SDK 27.0 and `ld` 27037.1. Its `LC_ID_DYLIB` also embeds
`/Users/runner/work/fs-safe/fs-safe/target/...`; the local binary embeds a
different temporary checkout path. Changing only the local Rust toolchain
changed the file by 16 bytes in this checkout, **not** the 16,528-byte gap
between the Rust-1.98.1 local build and the published binary. The executable
`__TEXT` segment differs by 16,384 bytes, so the current evidence does not
support treating the mismatch as merely a changed package manifest or
filename. No specific compiler, SDK, linker, path or stripping effect has
been isolated as the complete cause.

The tagged source's `[profile.release]` sets `strip = false`, and its release
workflow contains no explicit strip command. The local Rust-1.98.1 binding
loads with 34 native exports; a direct `renameNoReplace` fixture moved complete
bytes, then returned `EEXIST` without changing either collision file. The
published binary's same behavior was previously checked in the packaged
application. These behavioral matches are **not** byte or rights equivalence.

The host has Xcode 27.0 plus Command Line Tools SDKs 26.5/27.0, but no local
SDK 15.5. A meaningful byte-reproducibility attempt still needs a controlled
macOS toolchain reporting SDK 15.5 and `ld` 1167.5, Rust 1.98.1, the exact
tag/lockfile and an accounted-for checkout path. The pinned release workflow
uses GitHub's `macos-15` runner for `darwin-arm64`. A later
[official npm provenance verification](IR11-FS-SAFE-NPM-ATTESTED-PROVENANCE-2026-09-24.md)
ties the exact published tarball and installed `.node` to the successful
tagged-source release run, although that run's unauthenticated log endpoint
returned HTTP 403 during this review. Until
that build environment is matched or a qualified source-to-binary review
explains the difference, the published binary and all native dependency
rights entries remain `pending`; IR-02/IR-11 and ADR-019 are not promoted.
