# IR-02/IR-03 transfer libraries against the fixed Legacy Prototype reference — 2026-09-24

Status: **shared third-party versions confirmed; source-rights decision remains open**.

The historical Axterm submodule pointer is Legacy Prototype commit
[`799bedef98c1deae676ae03041719de98d3b57f1`](https://github.com/legacy-prototype/legacy-prototype/tree/799bedef98c1deae676ae03041719de98d3b57f1).
An isolated, detached checkout at that exact commit was used for this
read-only comparison; its worktree was clean. Its [`package.json`](https://github.com/legacy-prototype/legacy-prototype/blob/799bedef98c1deae676ae03041719de98d3b57f1/package.json)
has SHA-256 `2cd7cf0b0faf97abb5f7a508e3e157fee53c905fd2e788a88622377d2623317d`
and declares `zmodem2: 1.4.0` and `trzsz2: 1.2.0`, exactly the versions
Axterm now ships. The reference also contains application-level
[`zmodem.js`](https://github.com/legacy-prototype/legacy-prototype/blob/799bedef98c1deae676ae03041719de98d3b57f1/src/app/server/zmodem.js)
and [`trzsz.js`](https://github.com/legacy-prototype/legacy-prototype/blob/799bedef98c1deae676ae03041719de98d3b57f1/src/app/server/trzsz.js)
wrappers that import those published libraries. Their SHA-256 values are
`18ac6367b36132547a2890c35425b7d0f61ddbec11b84c5f89103f512090dd3e`
and `010293232ec5cfa979cc8a70faaaec1dfc3d282c7ffff700a78afaacef47adc5`.
The reference's `xmodem.js` SHA-256 is
`0a9a0090eb4e55d3eab6695b570be103f313896e03740a150d051e1c07760a62`.

At the original 2026-09-24 comparison snapshot, Axterm's protocol wrappers
were separate files under
`packages/runtime/src/adapters/terminal-transfer/`, with respective
`xmodem.ts`, `zmodem.ts` and `trzsz.ts` SHA-256 values
`3058f9aaef900dd1496ce9bb42c22a00f650756d5c6db1bb96473209596005fe`,
`6393fabfa5da70483a9f2667b6da13778fc028d4bf43283b7c5456de91b8de1f`
and `937487e4b3946d822f2e001f9f65dcd12aefd3f5092d913edb5e7234bfc948b9`.
A narrow screen for identical substantive whitespace-normalized lines
(at least 35 characters, excluding comment lines) found zero lines in the
XMODEM and TRZSZ wrapper pairs, and five ZMODEM lines consisting of library
event-condition branches. This screen is **not** a semantic or legal similarity
analysis and cannot establish independent authorship. Product source at that
checkpoint and `bun.lock` have no `terminal-transfer/legacy-prototype` import or
`@legacy-prototype/ftp-srv`/`@legacy-prototype/ssh2` dependency.

The [publisher-source record](IR02-TRANSFER-PUBLISHER-SOURCE-2026-09-24.md)
and [local rebuild](IR02-TRANSFER-REPRODUCIBLE-BUILD-2026-09-24.md) show that
both library distributions can be traced and reproduced from separately
published source. This reference comparison adds a different fact: Legacy Prototype
itself uses the **same package versions**. A separately published MIT package
can be reused by multiple applications, but a package name, identical
published version, rebuild, or shallow wrapper-line screen does not settle
its original code lineage, attribution or legal distribution terms. A
qualified reviewer must examine that chain and decide whether these
dependencies satisfy the independent-release requirements or need replacing.
IR-02 and IR-03 remain **In progress**.

## 2026-09-25 current-wrapper repeat

The same exact Legacy Prototype commit was fetched into a separate, clean, sparse
checkout. Its `package.json` and three wrapper hashes still equal the fixed
reference above. Axterm's wrapper SHA-256 values at **this comparison
snapshot** are:

| Axterm wrapper | Comparison-snapshot SHA-256                                        |
| -------------- | ------------------------------------------------------------------ |
| `xmodem.ts`    | `95427b2902e28b083d4a1f8a7f080e450ccc2e084b682a444c575868da6173c4` |
| `zmodem.ts`    | `a5fa0e8a48655f64991ae9008e698d2485ba735850720a993df26e46c3d4ab38` |
| `trzsz.ts`     | `60a1ae5741df83145111cc7a2383451e38a8090ab40850b29aaed4ddca6a6af0` |

The narrow line screen was repeated on those exact bytes. It trims each
physical line, removes whitespace, excludes lines starting with `//`, `/*`,
`*` or `#`, keeps normalized lines of at least 35 characters, and matches
identical lines within each corresponding wrapper pair. XMODEM and TRZSZ
have **0** matches; ZMODEM has **5**, all library event-condition branches
(`FileStart`, `FileComplete`, `SessionComplete`). The filtered Axterm/reference
line counts are 152/108, 160/175 and 174/153 respectively. This verifies
only that one mechanical screen against one fixed Legacy Prototype commit. It does
not inspect semantic structure, earlier commits, third-party library ancestry
or copyrightable selection and arrangement; a qualified code-lineage and
rights review is still required on final retained bytes.

## 2026-09-25 ZMODEM safety byte update

Subsequent bounded-queue, copied-header-tail and staged-cleanup corrections
changed `zmodem.ts` to SHA-256
`beb0e266cfbab87ac1b20a21f7168a986f5f9973193a04b5e926e2b2a18a5b2e`.
The table and 0/5/0 narrow line counts above describe the **earlier**
comparison snapshot, not this newer ZMODEM byte sequence. This safety change
does not itself resolve code lineage or source rights; qualified review must
use the final retained bytes.

## 2026-09-25 XMODEM shutdown byte update

A later in-flight-publication shutdown correction changed `xmodem.ts` to
SHA-256
`555289a002d4c98ba51762b8648e873f02bfaf7744ad55e45685e0faa5928eee`.
The fixed Legacy Prototype comparison table above predates this change too. It remains
historical mechanical evidence, not a current-byte rights conclusion.

## 2026-09-25 XMODEM stage-cleanup byte update

The later path-redacted stage-removal correction changed `xmodem.ts` again to
SHA-256
`e2263734c85143228e3bd9280f4a1c8a31d176c8f2c1908fb34b6baa9314ebf0`.
Neither the earlier fixed Legacy Prototype line screen nor the preceding XMODEM hash
is a review of these final retained bytes. Independent rights review remains
required.

## 2026-09-25 ZMODEM finalizer byte update

The later session-finalizer and retriable handle-close correction changed
`zmodem.ts` to SHA-256
`950b6e13a4bd8a672bf8bc1492dd74e7d7c204327ed61bb6ffaae3a3e9762a2e`.
The earlier fixed Legacy Prototype line screen is a historical snapshot, not a
current-byte or legal independence conclusion for this revised wrapper.

## 2026-09-25 approved ownership-journal implementation bytes

The ADR-020 T2 implementation changed all three wrappers to commit a private,
bounded ownership record before creating a receive stage. The present source
SHA-256 values are `xmodem.ts`
`01acaf9cf6c8111465f0627a0a79ff55904bcd1b2c5b1ee7b85be7c482ff05f1`,
`zmodem.ts` `aa187f75401fe10df88075f11adb4cdc5636a5f12529cb5ba9c8192e1e2d995f`,
and `trzsz.ts` `c776f849730521f413c7fb28fa8dda9eb74327d9a31beefd8501861f04827130`.
Each wrapper now refreshes the recorded filesystem identity after successful
receive writes because macOS FAT may assign a new inode on first allocation.
The preceding exact-line comparison remains a historical mechanical screen,
not a current-byte rights conclusion. Qualified source-lineage review of the
retained wrappers is still pending.
