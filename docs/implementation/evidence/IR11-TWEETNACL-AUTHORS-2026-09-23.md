# IR-11 TweetNaCl.js author/source-chain availability

Date: 2026-09-23  
Scope: frozen production dependency `tweetnacl@0.14.5`  
Result: exact publisher AUTHORS file added to source, application and package legal materials; IR-02/IR-11 remain **In progress**

The installed `tweetnacl` manifest declares `Unlicense` and names
`TweetNaCl-js contributors` as author metadata. Its root `LICENSE` is already
preserved byte-for-byte in `THIRD_PARTY_LICENSE_TEXTS.json`, but that file
does not name an individual copyright holder. The installed README points to
`AUTHORS.md`, which credits the TweetNaCl.js contributors and identifies the
TweetNaCl and Poly1305-donna public-domain source authors whose code was used.

The official [`v0.14.5` source tag](https://github.com/dchest/tweetnacl-js/tree/cce829e473b1ae299a9373b5140c713ee88f577f)
resolves to commit `cce829e473b1ae299a9373b5140c713ee88f577f`. The
installed and tagged files have the same SHA-256 values:

| File         | Installed and source-tag SHA-256                                   |
| ------------ | ------------------------------------------------------------------ |
| `AUTHORS.md` | `8feb6d2a264181d5c3ec1fd41cd5d70052bb319f7a0dcaf71bd7305eba61c635` |
| `LICENSE`    | `88d9b4eb60579c191ec391ca04c16130572d7eedc4a86daa58bf28c6e14c9bcd` |

`licenses/tweetnacl-AUTHORS.txt` preserves the 875-byte installed AUTHORS
file exactly. `THIRD_PARTY_NOTICES.txt` now points to that file and describes
the publisher's source chain without asserting copyright ownership. The
existing `licenses/` packaging rule and automatic About legal-text indexing
include the file; the package and UI journeys verify the current directory's
exact filenames and contents. A focused source test pins package identity,
license and author-file hashes, byte identity, and the notice reference.

Verification on 2026-09-23:

- `bun run check` passed: 1,013 tests passed, 33 skipped; Level 1 and 267
  Contract-operation gates passed; nine visual/accessibility journeys passed.
- The source `THIRD_PARTY_NOTICES.txt` SHA-256 is
  `7ee177f0b5ac9672a997ef3927e6666d2454e4fa3c511f15094b64a590db0377`.
- A fresh unsigned macOS arm64 directory app includes the exact legal files.
  Its `app.asar` SHA-256 is
  `88e3359160907b2d57b8d1e30351a9e804a64bafda1cb331e63397c24baa9039`;
  the regenerated and independently verified packaged SPDX sidecar SHA-256 is
  `09187028df6420e2b12fd0e4ee906702f551f1358034f54d03a3fa0b2331cc76`.
- The packaged file/notice journey passed. The About-page journey compared
  all current `licenses/*.txt` names and exact contents, including this AUTHORS
  file. In the first combined invocation, its assertions passed but Electron
  shutdown exceeded the test timeout; a separate single-test rerun passed in
  37.4 seconds. The combined teardown instability is not marked as a green
  combined run.

The authors file is attribution evidence, not a legal conclusion that every
contributor or derivative work is fully accounted for. The original
`LICENSE_ATTRIBUTION_REVIEW_LEDGER.json` entry remains `pending`; qualified
rights review, final platform artifacts and the overall third-party notice
audit remain open.
