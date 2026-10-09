# IR-11 — IronRDP target-source copyright and SPDX header candidates

Date: 2026-09-24  
Status: source-line attribution preservation and human-review handoff; **not file-level rights clearance**

The pinned `ironrdp-web` normal/build graph for `wasm32-unknown-unknown` has
259 source-package identities. A deterministic sweep of `.rs`, `.c`, `.cc`,
`.cpp`, `.h`, `.hpp`, `.s`, `.js` and `.ts` files under those package roots
examined **6,958 code files**. Explicit copyright or SPDX identifier lines
appeared in **719 files from 51 packages**, yielding **798 candidate lines**.
This is a wider scope than the root/nested legal-filename preservation checks:
for example, `chrono@0.4.44/src/format/parse.rs` credits John Nagle in a
source comment although the preserved package-root `LICENSE.txt` does not
name him.

The machine-readable
[candidate record](IR11-IRONRDP-SOURCE-HEADER-CANDIDATES-2026-09-24.json)
records package identity, path, full source-file SHA-256, original line number,
line text and match kind. Its SHA-256 is
`5b9fb5eea9d123bcbe5542c6690e0b9077d4ab2adf5c20b3a44694017eb28915`.
The separate `licenses/IronRDP-SOURCE-HEADER-ATTRIBUTIONS.txt` preserves all
798 matching lines with the same file identities/hashes and is intended for
the package and Legal/About; SHA-256
`d90d38584895a626cdfb61f600e8eb4670d0f1734206b5c0c7cdd52a10712084`.
The 51 affected package entries in `IRONRDP_DEPENDENCY_REVIEW_LEDGER.json`
now carry candidate file/line counts and a scope digest, so a changed
attribution candidate invalidates a prior package review instead of being
silently ignored.

`bun run licenses:ironrdp:headers:check` verifies the committed inventory,
candidate record and text bundle offline. To reconstruct them, provide the
tagged IronRDP checkout and locked Cargo cache:

```sh
bun run licenses:ironrdp:headers:source-check -- /path/to/IronRDP-tagged-checkout
```

The source check passed at commit
`e45f68c7e52297ca50d33b44c0ace36c9940fbe6` on 2026-09-24. It checks
the checksums of all 236 registry archives and byte-compares **each of the
719 matching source files** with its archive member or the tagged workspace
commit. Files without a matching line are scanned from the local extracted
Cargo cache or tagged checkout but are not individually compared with the
archive. The check therefore does not prove that the filename/line-pattern
sweep found every possible notice.

An isolated unsigned macOS arm64 directory app includes the separate text at
`Axterm.app/Contents/licenses/IronRDP-SOURCE-HEADER-ATTRIBUTIONS.txt`, with
the exact SHA-256 above. Its `app.asar` SHA-256 is
`f9233dfb8d14547275d0315cae83ef51de6639c723d451b72bf0fb0000bf7903`;
the verified complete packaged SPDX sidecar has SHA-256
`e21c44527af2c599e0422778cb356529b8e19471dc750c668c7a33412aae8003`.
The focused IronRDP artifact check passed against that app and sidecar. All
22 applicable packaged journeys passed with 11 platform/fixture skips,
including exact Legal/About text access. This is not a signed or notarized
installer and does not exercise a live RDP server.

This bundle is **not a substitute for the original source licenses or complete
header blocks**. It includes build-time/proc-macro packages and source files
that may not be linked into the published WASM; the original source-to-WASM
build remains unreproduced. Its matches can include false positives, and
missing or unusual wording can evade the pattern. A qualified reviewer must
decide actual file-level rights, attribution, license alternatives and final
artifact notice disposition for all 260 review entries. IR-02/IR-11 stay
**In progress**.
