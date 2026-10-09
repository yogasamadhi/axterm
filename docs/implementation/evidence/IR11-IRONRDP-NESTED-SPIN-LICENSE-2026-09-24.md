# IR-11 — IronRDP target-tree nested `tracing-core` spin notice

Date: 2026-09-24  
Status: exact nested-text preservation; **not complete file-level or WASM-linkage review**

The pinned IronRDP `ironrdp-web` normal/build Cargo source graph includes
`tracing-core@0.1.36`. Its package-root `LICENSE` was already in the 470-file
root-text bundle, but the published crate archive also contains a distinct
`src/spin/LICENSE`. That nested MIT text credits **Mathijs van de Nes (2014)**;
the package-root text is not a substitute for that attribution.

The exact crates.io archive matches its locked SHA-256
`db97caf9d906fbde555dd62fa95ddba9eecfd14cb388e4f491a66d74cd5fb79a`.
The archived `src/spin/LICENSE` and
`licenses/tracing-core-spin-LICENSE.txt` match byte-for-byte, SHA-256
`58545fed1565e42d687aecec6897d35c6d37ccb71479a137c0deb2203e125c79`.
The latter is delivered separately in the app's `licenses/` directory and
Legal/About, with an explicit entry in `THIRD_PARTY_NOTICES.txt`.

An isolated unsigned macOS arm64 directory app packaged after this change
has `app.asar` SHA-256
`5255471484574ee1c3c4ef5e285b30d099d008361164a88de67c0a38a3d8b078`.
Its complete packaged SPDX sidecar re-verifies with SHA-256
`68f06d97870f6274eaa7b388435f557bf0776627a771a8e8cee2808f0e4b1936`.
The focused IronRDP artifact check confirms the external nested text and
published embedded WASM bytes. This is directory-app evidence, not a signed
or notarized installer.
The full Mac packaged Playwright suite passed **22 applicable journeys** with
11 platform/fixture skips, including exact Legal/About text access and
official IronRDP initialization outside the checkout. This did not connect
to a live RDP server.
The follow-up `bun run check` passed 233 unit/integration files (1,167 tests
passed, 34 skipped), the Level 1 architecture check over 360 modules and
1,310 dependencies, 267 Contract operations, source/legal checks, production
build and all 11 visual/accessibility journeys. The final-public composite
check passed the nested-text prerequisite but correctly left nine other
prerequisites pending and skipped the final source snapshot.

An opt-in source check validates all 236 locked registry archives against
the target inventory, scans their nested legal filenames and the 23 tagged
workspace package directories, and compares this file to the archived bytes:

```sh
bun run licenses:ironrdp:nested:source-check -- /path/to/IronRDP-tagged-checkout
```

On 2026-09-24 the pinned checkout at commit
`e45f68c7e52297ca50d33b44c0ace36c9940fbe6` produced exactly one nested
legal filename in those 259 package roots:
`tracing-core@0.1.36 src/spin/LICENSE`. The routine
`bun run licenses:ironrdp:nested:check` pins the source-package identity and
preserved bytes without requiring a local Cargo cache. The 260-entry human
review ledger now carries this nested text on the `tracing-core` candidate;
any change to its bytes or identity resets that entry's review.

This is a **filename-pattern sweep**: it is not a scan of copyright headers,
embedded legal prose, generated sources or a determination that every package
or the spin module contributes bytes to the published WASM. Source-to-WASM
reproducibility, applicable licensing choices, complete file-level attribution
and named rights review remain open; IR-02/IR-11 stay **In progress**.
