# IR-02/IR-03 transfer-library publisher source trace — 2026-09-24

Status: **publisher leads and local distribution rebuild verified; original code lineage and qualified rights review remain open**.

Axterm currently runs `zmodem2@1.4.0` and `trzsz2@1.2.0` behind its
Runtime-owned adapters. Their common named publisher is also the Legacy Prototype
maintainer; removing `@legacy-prototype/*` from Axterm's direct dependencies does not
alone establish that the two libraries are unrelated to Legacy Prototype. ADR-018
permits them as separately published, attributed third-party components while
IR-02 and IR-03 remain unaccepted.

The fixed Legacy Prototype submodule commit also declares the **same two published
versions**; see the [reference comparison](IR02-TRANSFER-LEGACY_PROTOTYPE-REFERENCE-2026-09-24.md).
Their separate npm distribution must not be misdescribed as proof of no
Legacy Prototype ecosystem relationship.

## Exact published-package leads

The official npm registry version records point to these GitHub commits via
`gitHead`. Both commits are accessible in the publisher repositories. The
installed LICENSE and README files match the named commit's corresponding
files byte-for-byte; the package manifest hashes below identify the exact
installed metadata examined.

| Installed package | npm `dist.integrity`                                                                              | npm `gitHead`                                                                                                                         | Installed package.json SHA-256                                     | LICENSE SHA-256                                                    | README.md SHA-256                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `zmodem2@1.4.0`   | `sha512-2PG/XvD43I5LKKG09GSsC1irZW5pDTq/5yA29JP118gRv2o3vu+N69x1MzTjFi++O4Nm5nSRdpdZn3Z6D5EneA==` | [`b9f03ed3cdc362610dc76ce9401c7e02397ee0c8`](https://github.com/zxdong262/zmodem2-js/commit/b9f03ed3cdc362610dc76ce9401c7e02397ee0c8) | `66b7e0b83092c6199c8bc022a49ace47c28e1fc13fcc319b90616888cb2ab423` | `d1f16458bcc7a33ec2752ecc65314736cfca713337dec5cde6505504b8201b02` | `38e6d4275211507a32ef9bd782e1a8f4b6d01d362ea363916d63f94fa919adaa` |
| `trzsz2@1.2.0`    | `sha512-wJ/Z2CVaY0nnPG6Ev4IxzRyceya1o77V08zRsxSgNNeYxZ1kTaeQxHonLxsO+edaE/KhAiJZ404CI0xO3CrCWQ==` | [`d8ec536dab4fe86ee41acb6db8ae89d55e29153a`](https://github.com/zxdong262/trzsz2/commit/d8ec536dab4fe86ee41acb6db8ae89d55e29153a)     | `1a639cb7ea1e7f9d4628ce3a5a47ef2b8f4b9b06aed16e7584fa3020b8d1d47b` | `10adae8a4911e6f69c53417e564594a425a281eb85f4e115e80c0dd568624d2f` | `21790ef20853d0be9943235c1fadde9436de0d38b769dc58e5bc98a90c207c11` |

Registry metadata: [`zmodem2/1.4.0`](https://registry.npmjs.org/zmodem2/1.4.0),
[`trzsz2/1.2.0`](https://registry.npmjs.org/trzsz2/1.2.0). The corresponding
GitHub trees have seven `src/lib/*.ts` files each and no committed `dist/`
directory at these commits. Thus the matching LICENSE/README and npm
`gitHead` alone are publisher/source _leads_, not build or original-authorship
proof. A subsequent [isolated local rebuild](IR02-TRANSFER-REPRODUCIBLE-BUILD-2026-09-24.md)
reproduced the entire installed `dist/` for both packages, applying Axterm's
declared `trzsz2` patch to the latter. That result does not settle who authored
the publisher source or the rights attached to earlier code.

The installed CommonJS `index.cjs.map` files embed the publisher's executable
TypeScript source text. All **11** embedded `src/lib/*.ts` contents match the
corresponding files at the npm `gitHead` commits byte-for-byte (six zmodem2,
five trzsz2). The ESM module maps contain the same text. The exact source,
map and local bundle hashes are pinned in
[`IR02-TRANSFER-SOURCE-MAP-2026-09-24.json`](IR02-TRANSFER-SOURCE-MAP-2026-09-24.json)
and checked offline against the installed packages. The independent GitHub
comparison used the immutable raw-file URLs under those commits. This narrows
the source correspondence gap; source maps alone are publisher-provided
assertions. The separate local rebuild supplies the compilation check.
Axterm's `trzsz2` timeout
patch changes the installed CJS/ESM JavaScript but leaves the publisher's map
source text unmodified, so the patched section cannot be treated as a fresh
source-to-code map.

The `trzsz2@1.2.0` published `package.json` lists `@legacy-prototype/ssh2@^1.17.0`
only under `devDependencies`. Axterm's frozen `bun.lock` has no
`@legacy-prototype/ssh2` entry; this is not an Axterm runtime dependency, but it is a
relevant publisher-development link for the independent-source review. The
installed metadata, local legal texts and absence from the lockfile are
guarded by `tests/unit/third-party-license-evidence.test.ts`.

Local verification: the focused third-party source suite passes 31/31 tests.
After this record and its regression were added, `bun run check` passes 222
test files (1,126 passed, 33 skipped), 359 architecture modules / 1,310
dependencies, all 267 Contract operations, production build/package layout
and 11 visual/accessibility journeys. This is worktree evidence only; it is
not a native-platform installer or legal review. The separately recorded local
library rebuild is not included in the standard check.

Next, a qualified reviewer must compare the exact published implementation
and its source chain with Legacy Prototype and any upstream protocol code, decide
whether attribution/distribution terms are complete, and record a conclusion.
Neither a common author nor an npm `gitHead` is by itself a legal verdict.
