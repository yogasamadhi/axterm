# IR-02/IR-03 transfer-library local rebuild — 2026-09-24

Status: **2026-09-25 current patched distribution files reproduced locally;
source-rights review remains open**.

The first audit below is the **2026-09-24 patch snapshot**, not current-byte
proof by itself. A 2026-09-25 repeat using the current binary-header,
POSIX/Windows line and queued-input patch is recorded after it. Installed
output hashes are pinned in the
[IR-02 transfer source maps](IR02-TRANSFER-SOURCE-MAP-2026-09-24.json).

This audit used separate temporary clones of the publisher repositories at the
exact npm `gitHead` commits: `zmodem2@1.4.0` at
`b9f03ed3cdc362610dc76ce9401c7e02397ee0c8` and `trzsz2@1.2.0` at
`d8ec536dab4fe86ee41acb6db8ae89d55e29153a`. Both were built under the
official `node:24.18.0-bookworm-slim` Linux arm64 container (pull-reported
digest `sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`).
Each clone used its committed `package-lock.json` with
`npm ci --ignore-scripts --no-audit --no-fund`; the subsequent `npm run build`
ran with container networking disabled. The containers used a non-root user,
no added capabilities and no-new-privileges. The build resolved Vite 5.4.21
for zmodem2 and Vite 7.3.1 for trzsz2.

| Package                             | Compared files                                                                                           | Result                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zmodem2@1.4.0`                     | Whole rebuilt `dist/` against `packages/runtime/node_modules/zmodem2/dist/`                              | `diff -qr` found no differences. Rebuilt/installed `dist/cjs-full/index.cjs` SHA-256: `1ec99688fee89163cd1f1e7668ea15b65125e088c92d6a2f8edf5aad460e89de`.                                                                                                                                                                                                                                                      |
| `trzsz2@1.2.0`, before Axterm patch | Whole rebuilt `dist/` against installed `dist/`                                                          | Exactly two files differed: `dist/cjs-full/index.cjs` and `dist/esm/transfer.js`, the two declared patch targets. Unpatched hashes: `eef664eb73b2b50900bcb61a05bdfb03275ae124401d9789284fa2df04855f67` and `bd0483392bf90f57614f568c06d8b26b9457298f028c3537cb4be6c29de721d3`, respectively.                                                                                                                   |
| `trzsz2@1.2.0`, after Axterm patch  | Applied the repository's `patches/trzsz2@1.2.0.patch` to the isolated clone, then compared whole `dist/` | `git apply --check` and `git apply` succeeded; `diff -qr` found no differences. Patched CJS SHA-256: `c0a038aa8f445d3f7ab2d2ab3f38ed6fc93fa6b9329e5072c44640225717fc70`; patched ESM transfer SHA-256: `79bb4c091ca323230a7e295f99e1ba224c4a6f7c932d7b8e345e0165e6c857bc`. Patched `package.json` SHA-256: `1a639cb7ea1e7f9d4628ce3a5a47ef2b8f4b9b06aed16e7584fa3020b8d1d47b`, matching the installed package. |

The publisher's `trzsz2` development installation included its declared
`@legacy-prototype/ssh2` development dependency. Before the network-disabled build,
that directory was moved outside `node_modules/@legacy-prototype/ssh2`, so it was not
resolvable by the build; the build and full output comparison still succeeded.
This is an **isolated diagnostic**, not an Axterm release dependency. Axterm's
frozen `bun.lock` does not include `@legacy-prototype/ssh2`.

## 2026-09-25 repeat for the current trzsz2 patch

The publisher repository was freshly cloned into a separate temporary
directory and checked out at the same npm `gitHead`,
`d8ec536dab4fe86ee41acb6db8ae89d55e29153a`. Its committed
`package-lock.json` SHA-256 was
`92dcb5addd2e1f8bc3bd8a3af24df095ba196ede315e4ca2397448b81598aa2c`;
the embedded `src/lib/buffer.ts` and `src/lib/transfer.ts` hashes still match
the pinned publisher-source map record. No workspace source or installed
`trzsz2` distribution file was mounted into the build container.

The build used the already-pinned official `node:24.18.0-bookworm-slim`
Linux arm64 image, SHA-256
`6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`.
`npm ci --ignore-scripts --no-audit --no-fund` installed the committed lockfile
as an unprivileged user; it resolved Vite 7.3.1. The declared development-only
`@legacy-prototype/ssh2` directory was moved out of `node_modules` before building.
The container was then disconnected from every network and `npm run build`
ran as the unprivileged user with all capabilities dropped and
`no-new-privileges`. The container had no host mounts.

Before Axterm's patch, `diff -qr` against the currently installed package's
whole `dist/` tree reported exactly three differing files:
`dist/cjs-full/index.cjs`, `dist/esm/buffer.js` and
`dist/esm/transfer.js`. `git apply --check` and `git apply` of the **current**
`patches/trzsz2@1.2.0.patch` (SHA-256
`16d94b8ddf9558f1e2ff73d3aac254b8fb1f8e8525212d4e8bfd08bb8ccb0694`)
then succeeded on that isolated build. A second `diff -qr` returned **no
differences across all 33 `dist/` files**. The patched `package.json` also
matched the installed file at SHA-256
`1a639cb7ea1e7f9d4628ce3a5a47ef2b8f4b9b06aed16e7584fa3020b8d1d47b`.
Selected matching executable SHA-256 values are:

| File                      | Isolated rebuilt + patched = installed                             |
| ------------------------- | ------------------------------------------------------------------ |
| `dist/cjs-full/index.cjs` | `333600a28cfd794c0e9eca0c2d8b1b6e32830ab964775332a96382c2359e63a3` |
| `dist/esm/buffer.js`      | `4055e6436d76d0fdde4f388fc3d0bc65de5632a2d48a126e399499182388b065` |
| `dist/esm/transfer.js`    | `bff938669ebf2bc42c5046025f8a3d2a26d61e9766d73036d784997fe8f68ca2` |

This establishes repeatable **local distribution-file bytes** from that
publisher snapshot plus the declared Axterm patch. It does not prove the
publisher independently authored every source line relative to Legacy Prototype,
settle attribution or license obligations, or replace the qualified
source-rights and protocol/security decisions in W-02-03 and W-03-01. IR-02
and IR-03 remain **In progress**.

The 2026-09-24 result established reproducibility of that day's **installed
library distribution files** under the local toolchain and then-current
`trzsz2` patch. The independent [source-map record](IR02-TRANSFER-SOURCE-MAP-2026-09-24.json)
pins embedded source and installed output hashes for offline regression. This
does **not** establish that the upstream source was independently authored
relative to Legacy Prototype or all earlier protocol work, settle rights/attribution,
prove Windows/native-Linux installed Axterm behavior, or constitute qualified
legal approval. IR-02 and IR-03 remain **In progress**.
