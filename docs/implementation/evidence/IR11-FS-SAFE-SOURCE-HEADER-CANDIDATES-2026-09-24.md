# IR-11 — fs-safe macOS source copyright and SPDX header candidates

Date: 2026-09-24  
Status: source-line attribution preservation and human-review handoff; **not file-level rights clearance**

The pinned macOS arm64 `fs-safe-native` normal-source graph has 61 Cargo
package identities. A deterministic scan of `.rs`, `.c`, `.cc`, `.cpp`, `.h`,
`.hpp`, `.s`, `.js` and `.ts` files under those package roots examined **2,157
code files**. Explicit copyright or SPDX identifier lines appeared in **156
files from nine packages**, yielding **156 candidate lines**. For example,
`futures-channel@0.3.34/src/mpsc/queue.rs` credits Dmitry Vyukov in a source
comment; the parent `@openclaw/fs-safe` MIT label does not identify that
author. This is separate from the two Zstandard nested legal texts already
preserved.

The machine-readable
[candidate record](IR11-FS-SAFE-SOURCE-HEADER-CANDIDATES-2026-09-24.json)
records package identity, path, source-file SHA-256, original line number,
line text and match kind. Its SHA-256 is
`013a6d6447d5650991da26fc134c3d5578a8c8f345a8934fcd54d5676f052c83`.
`licenses/fs-safe-SOURCE-HEADER-ATTRIBUTIONS.txt` preserves the 156 matching
lines with file identities and hashes; SHA-256
`52186f73b215d7863766c152499f6bb2caea70187f8e6fe7165a4f6c65a95a8a`.
The nine affected entries in `NATIVE_DEPENDENCY_REVIEW_LEDGER.json` now carry
candidate counts and digests. The macOS source-scope SPDX records the same
review leads; its SHA-256 is
`4a457b6817f1d4a1f85458b19fa83f995db01b0200959db274887b59f074ed7d`.

`bun run licenses:native:headers:check` pins the committed record and bundle
offline. To reconstruct them from the tagged upstream checkout and locked
Cargo cache:

```sh
bun run licenses:native:headers:source-check -- /path/to/fs-safe-v0.13.1-checkout
```

The source check passed at upstream commit
`7022a0a10c53e36f34a467df68ed5614a1db1741` on 2026-09-24. It verifies
the pinned `Cargo.lock` and all 59 registry crate archive checksums, then
byte-compares each of the 156 matching source files with the published
archive member or tagged upstream commit. Files without matching lines are
scanned from local source roots but are not individually compared with the
archive. The check therefore does not prove that the bounded line-pattern
sweep found every possible notice.

An isolated unsigned macOS arm64 directory app contains the exact text at
`Axterm.app/Contents/licenses/fs-safe-SOURCE-HEADER-ATTRIBUTIONS.txt`.
Its `app.asar` SHA-256 is
`625a4e2f0b986a3e277797de3f2c18270f2c6b6fb7c5b8964a01e4e5433e2b14`;
the complete verified packaged SPDX sidecar SHA-256 is
`089f5aa3c0671a9c907a0780ee97b4f95eacd02b1918be283a695d89710aa9d2`.
The focused native artifact check compared the binding, package identity and
all five supplemental legal files with this app and sidecar. All 22 applicable
packaged journeys passed with 11 platform/fixture skips, including exact
Legal/About text access. This is not a signed/notarized installer or
source-to-binary reproduction.

The text bundle is **not a substitute for original source licenses or full
header blocks**. It includes proc-macro/build-time packages and source files
that may not be linked into the published `.node`, whose local rebuild is not
byte-identical to the published binary. Matches can include false positives;
missing or unusual wording can evade the scan. A qualified reviewer must
decide actual file-level rights, attribution, license alternatives, binary
scope and notice disposition for all 62 native review entries. IR-02/IR-11
stay **In progress**.
