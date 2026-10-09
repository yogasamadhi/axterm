# IR-11 Hono middleware publisher declarations

Date: 2026-09-23  
Scope: `@hono/zod-openapi@1.6.3` and `@hono/zod-validator@0.9.1` in the frozen production install  
Result: publisher attribution evidence added to the transition notice; IR-02/IR-11 remain **In progress**

Both installed package manifests declare `MIT` but omit a root
`LICENSE`/`COPYING`/`NOTICE` file. The installed packages do include their own
`README.md`, each naming Yusuke Wada as author and declaring MIT. The exact
installed README bytes match the corresponding official source-tag README:

| Package                     | Official tag commit                                                                                                                                     | Installed and tagged README SHA-256                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `@hono/zod-openapi@1.6.3`   | [`bc7d9e67119f870b5275569b371676663c74c976`](https://github.com/honojs/middleware/tree/bc7d9e67119f870b5275569b371676663c74c976/packages/zod-openapi)   | `526d11cb80f13a2b8a77754e274e64efbf13dec7073bc52db45197e4ed361778` |
| `@hono/zod-validator@0.9.1` | [`8de0f1ea32b76d40df0ec4a06ed5af2e100ccbfd`](https://github.com/honojs/middleware/tree/8de0f1ea32b76d40df0ec4a06ed5af2e100ccbfd/packages/zod-validator) | `6d10c6e36fd42589bc10aa2ae7507eebe4d9601ba45e8a3fee6348f3eec3462d` |

The tag commits were resolved with `git ls-remote --tags`; the installed and
tagged README hashes were compared independently. The source-tag manifests
identify the same package names, versions and MIT declaration; their complete
bytes are **not** the same as the installed publish-time manifests, so this
record does not claim a full source-to-binary match.

`THIRD_PARTY_NOTICES.txt` now states the publisher's author and MIT declaration,
identifies both exact tags, and points to its common MIT permission/disclaimer
text. `tests/unit/third-party-license-evidence.test.ts` pins the installed
README hashes, package identities, declarations and notice references. The
existing source/package/About legal-document checks compare the transition
notice bytes across those locations.

Verification of the updated source snapshot: `bun run check` passed 218 test
files (five skipped), 1,008 tests (33 skipped), the 358-module / 1,304-dependency
Level 1 gate, 267 Contract operations, production build/layout and all nine
visual/accessibility journeys. A fresh unsigned macOS arm64 directory app had
`app.asar` SHA-256
`ecd8d3fcc580df344e851ffa2c4cea5b24f5f7674c2e264e1ed874a1ded5033f`;
its regenerated packaged SPDX sidecar verified byte-for-byte with SHA-256
`e2132556baa911edb11d33ae26e867ce82d82f16686c770c46744f35b1c35eed`.
Both focused packaged license-file and About journeys passed against that app
(2/2), including exact source/package notice content comparison. The updated
source notice SHA-256 is
`45a56c3ded2515e5d7f886ad18e8bcf11d3cf54e8ff881e8bae7d778cbd3ce16`.

The README says **author**, not an exact package-specific copyright holder or
year. Neither a generic MIT text nor that metadata is treated as a substitute
for a publisher copyright notice or qualified rights review. Both packages
remain in `LICENSE_ATTRIBUTION_REVIEW_LEDGER.json` with pending review; signed
and installed Windows/native-Linux artifacts are also still unverified.
