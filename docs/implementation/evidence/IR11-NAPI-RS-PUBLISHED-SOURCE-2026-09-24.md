# IR-11 napi-rs source-root license supplement — 2026-09-24

Status: **exact four published Cargo source archives mapped to upstream commits; root license packaged; rights/binary review still pending**.

The [macOS arm64 `fs-safe` Cargo inventory](IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json)
has four registry crates that declare `MIT` but omit a root legal file in their
published `.crate` archives. Their manifests point to the official
[`napi-rs/napi-rs` repository](https://github.com/napi-rs/napi-rs). The archives'
`.cargo_vcs_info.json` files identify these exact source commits and paths:

| Published crate             | Locked `.crate` SHA-256                                            | Published VCS commit / path                                   | Matched source files |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- | -------------------: |
| `napi@3.12.2`               | `58c5f4d5375213fdb7be2655e152386e82f026f9a5ba36a75556e11359aafe09` | `444bf29b8534216dd1cec4695a71e5996a173e87` / `crates/napi`    |                   82 |
| `napi-derive@3.6.3`         | `0fa55ea69990c90b888e9e77044410e304ce7f35de599dc6d0b5c1923d2e59af` | `956e4525fea6a676ea3680b711382f167b899af9` / `crates/macro`   |                   12 |
| `napi-derive-backend@6.1.2` | `df4056ac7c18e4438ccf0edaed4340ca0d269278c8ec19284f7b23cb039fd0ae` | `956e4525fea6a676ea3680b711382f167b899af9` / `crates/backend` |                   18 |
| `napi-sys@3.3.0`            | `85fbf1fa9f1babfe396d74bbbf52b3643770243e8f5b0b46715d4caf7f0dfc9a` | `679eb79f5cf3c7c6b2850f4ab46092126f23dc5c` / `crates/sys`     |                    4 |

The opt-in `bun run licenses:napi:source-check -- <napi-rs Git checkout>
<fs-safe v0.13.1 checkout>` verified the pinned `fs-safe` Cargo.lock, each
published `.crate` hash against its lock checksum, VCS metadata, original
Cargo.toml and all **116** packaged regular source files against those Git
commits. It excludes only Cargo-generated packaging metadata from the
file-by-file comparison. The corresponding upstream `LICENSE` at
[`444bf29`](https://github.com/napi-rs/napi-rs/blob/444bf29b8534216dd1cec4695a71e5996a173e87/LICENSE),
[`956e452`](https://github.com/napi-rs/napi-rs/blob/956e4525fea6a676ea3680b711382f167b899af9/LICENSE)
and [`679eb79`](https://github.com/napi-rs/napi-rs/blob/679eb79f5cf3c7c6b2850f4ab46092126f23dc5c/LICENSE)
is byte-identical at all three commits: 2,138 bytes, SHA-256
`3f1ce66533302df3a32edbfdfc0b78f0dd34659e4c1f5817162e5ea3c2297215`.
The exact two-block MIT text, including both the LongYinan and GitHub
copyright notices, is preserved in
[`licenses/napi-rs-LICENSE.txt`](../../../licenses/napi-rs-LICENSE.txt).
`THIRD_PARTY_NOTICES.txt` maps it to the four published crates. The routine
`bun run licenses:napi:check` rejects license-byte or missing-root inventory
scope drift offline; it does **not** repeat the opt-in source download.

The legal text is included by the app's `licenses/*.txt` Legal/About display
and `electron-builder` legal directory copy. An isolated **unsigned macOS
arm64 directory package** at `/tmp/axterm-napi-license-36Xw6S/mac-arm64/Axterm.app`
contains `Contents/licenses/napi-rs-LICENSE.txt` with that same SHA-256.
The packaged legal-file inventory and copied-outside-checkout Legal/About
Playwright journeys passed (2/2), comparing every displayed license text
to the source bytes. Its artifact-level SPDX sidecar at
`/tmp/axterm-napi-license-36Xw6S/AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json`
verified against the exact app: SHA-256
`6446a8d33dadf04626cca9a70042e155e17a5ceca072aca17d6719749f5ac60c`,
102 packages, 250 files, 351 relationships and `app.asar` SHA-256
`217dd45b7bc66c8b065d7343f4d0630495f274e19e77d1e0f98ced2f0e15250c`.
These temporary artifacts are local engineering evidence, not a signed
distribution or notarization receipt.

This mapping is stronger than a manifest-only MIT label, but it does **not**
establish exactly which Rust code is linked into the published `fs-safe`
`.node`, complete nested notices/copyright, license applicability, or the
nonmatching local rebuild's reason. The four package and binary decisions
remain `pending` in `NATIVE_DEPENDENCY_REVIEW_LEDGER.json`; qualified review
and Windows/Linux target-native evidence remain necessary. IR-02/IR-11 are
**In progress**.
