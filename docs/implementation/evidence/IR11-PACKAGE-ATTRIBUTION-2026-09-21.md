# IR-11 package attribution metadata — 2026-09-21

Release gate: [IR-11](../INDEPENDENT_RELEASE_MATRIX.md)  
Status: **mechanical source/package evidence; not copyright clearance**

## What is recorded

`THIRD_PARTY_LICENSE_TEXTS.json` is generated from the frozen production Bun
graph. In addition to the 119 preserved root `LICENSE`/`COPYING`/`NOTICE` files,
each of its 125 package entries now records:

- role-tagged, exact `package.json` `author` and `contributors` values when
  publishers supplied them; object records retain their published fields rather
  than being reduced to a display name;
- a non-empty `package.json` `copyright` field when the publisher supplied one;
- exact lines beginning with `Copyright` or `©` in the preserved root legal
  files, including the originating filename; and
- an explicit `missingCopyrightDeclarations` queue when neither source exists.

The queue currently has eight entries:

```text
@devolutions/iron-remote-desktop-rdp@0.7.0
@hono/zod-openapi@1.6.3
@hono/zod-validator@0.9.1
@novnc/novnc@1.7.0
@xterm/addon-serialize@0.14.0
@xterm/headless@6.0.0
drizzle-orm@0.45.2
tweetnacl@0.14.5
```

An entry in this queue means only that these two machine-readable sources were
empty. It does **not** mean that the package has no copyright holder, has no
other notice, or can be distributed without qualified review.
Manifest author/contributor entries are preserved as publisher metadata but do
not clear the queue or establish copyright ownership.

`LICENSE_ATTRIBUTION_REVIEW_LEDGER.json` is generated from this queue with a
SHA-256 hash of the sorted package identities. `bun run licenses:attribution:check`
rejects a ledger whose scope no longer matches the archive. Each record starts
as `pending`, with no asserted reviewer, date, evidence or conclusion. Before
a record may be `reviewed` or `needs-follow-up`, it must contain a named
qualified reviewer, ISO date, non-empty primary-source/notice reference and
note, plus an explicit conclusion. Regeneration retains those fields only for
an unchanged package identity; entries removed from the current source queue
are not carried forward. This makes review work traceable across legitimate
dependency updates without treating a ledger status as legal clearance.

## Artifact and UI verification

The rebuilt unsigned macOS arm64 directory app has these hashes:

| Material                                           | SHA-256                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| Source `THIRD_PARTY_LICENSE_TEXTS.json`            | `e50c5963ee771a25176d21bbe23a8c16ef9529043732bb3ae8bb66b4d61dd5f2` |
| Packaged `Contents/THIRD_PARTY_LICENSE_TEXTS.json` | `e50c5963ee771a25176d21bbe23a8c16ef9529043732bb3ae8bb66b4d61dd5f2` |
| Packaged `Contents/Resources/app.asar`             | `055aa095fac2eb44a39d2711b0733c3f920356c0d4f44186570542d029acc74b` |

Verification succeeded with:

```text
bun run licenses:texts:check
bun run licenses:attribution:check
bun run package:dir
bunx playwright test tests/e2e/packaged.spec.ts --project=packaged --grep 'packaged app (includes Axterm and transition third-party license notices|exposes its exact license and notices in About)'
```

The two packaged tests assert the source/package archive identity, the exact
eight-entry queue, an unmodified `ssh2` manifest author record and preserved
copyright line, and the rendered About metadata view.

## Limits and next actions

This record is an audit aid, not a complete copyright notice set. It does not
read nested/generated/inlined/native/WASM files, determine whether a manifest
field is complete or authoritative, resolve the eight queued packages, assess
Electron/Chromium, test Windows/Linux artifacts, or satisfy LGPL/MPL source and
distribution duties. These matters remain in IR-02/IR-11's qualified review
and three-platform artifact work.

## noVNC's embedded Pako notice — 2026-09-23

An artifact-directed follow-up found a nested notice relevant to the product:
`@novnc/novnc` imports its own `vendor/pako` implementation from
`core/inflator.js` and `core/deflator.js`. Its root `LICENSE.txt` names that
copy as MIT-licensed and points to `vendor/pako/LICENSE`, but the earlier
Axterm legal materials only included generic MIT text and the separate
production-graph `pako` package's different notice. The embedded copy's exact
MIT text contains `Copyright (C) 2014-2016 by Vitaly Puzrin`.

Axterm now preserves those installed bytes in
`licenses/noVNC-pako-LICENSE.txt` (SHA-256
`3bc404ffa7888053253eedcc5a667619aa08dc1be0bea400e5ff28c51602180f`),
names the file and copyright in `THIRD_PARTY_NOTICES.txt`, and makes it
readable in Settings → About. The existing `extraFiles` rule includes the
complete `licenses/` directory. A source test compares the file byte-for-byte
with the installed noVNC copy and checks both imports; a fresh unsigned macOS
arm64 directory app, created in an isolated temporary output without
overwriting retained candidates, passed the packaged legal-file and About
journeys (2/2). The temporary app was removed after verification.

This closes one identifiable embedded notice omission, not the eight pending
package-attribution reviews or a complete generated/inlined/native/WASM and
three-platform legal audit. IR-02 and IR-11 remain **In progress**.

## noVNC's referenced AUTHORS file — 2026-09-23

The same installed noVNC `LICENSE.txt` begins with a copyright reference to
`(./AUTHORS)`, which the earlier packaged legal materials did not expose.
`licenses/noVNC-AUTHORS.txt` now preserves that 13-line installed file
byte-for-byte (SHA-256
`16ee0ef356d5107a4bc039f91abc99a341dc62b9aa8dd47547a2baed38507509`).
The third-party notice points to it, and Settings → About renders it. A source
test compares the exact bytes and root-license reference; an isolated unsigned
macOS arm64 directory app passed the packaged legal-file and About journeys
(2/2) without overwriting retained release candidates. The upstream AUTHORS
file itself states that its contributor list is incomplete, so this is
preservation of the publisher's referenced record—not a completeness or
ownership determination. IR-02/IR-11 remain **In progress**.

## noVNC RFB source-header archive — 2026-09-23

The production VNC adapter dynamically imports `@novnc/novnc`, whose installed
1.7.0 manifest exports `core/rfb.js`. A deterministic browser-ESM import-graph
walk now records the 52 reached installed source inputs: 42 noVNC core files
and ten bundled `vendor/pako` files. `licenses/noVNC-SOURCE-NOTICES.txt`
records each source SHA-256 and its verbatim leading legal/source-origin
comments. It identifies 32 files with such a comment and explicitly labels
the other 20 as _not detected_, not notice-free. In particular, the reached
`core/base64.js` retains its MPL header and Mozilla source-origin line; the
separately preserved DES and Pako notices remain in force. The archive is
regenerated or checked with `bun run licenses:novnc:generate` and
`bun run licenses:novnc:check`, respectively, and the latter is in the default
source gate. Version, package entry and production import changes stop the
generator for review rather than silently reusing an old archive.

The source archive SHA-256 is
`077a989ef983af9c9ede129a8488c688a97e43fdd8b88027f7fb445640401994`.
An isolated unsigned macOS arm64 directory app copied the exact same bytes to
`Contents/licenses/`, exposed the archive in Settings → About, and passed the
two packaged legal/About journeys. Its `app.asar` SHA-256 was
`d391080104a463eed8fdf2601dc1aa574c4738f3b018938b62e4c32cb2004b55`.
The temporary app was moved to the user's Trash after verification; retained
release candidates were not overwritten.

This is an esbuild import-graph source-header inventory, not an exact Vite
bundle-input map, proof that all file-level comments survive minification,
complete Electron/native/WASM/non-code inventory, MPL source-availability
compliance, or qualified rights sign-off. IR-02/IR-11 remain **In progress**.

## Actual Vite module-to-chunk mapping — 2026-09-23

The renderer production build now emits
`out/renderer/axterm-novnc-bundle-provenance.json` from Rollup's actual chunk
module list. It records each noVNC source path and installed SHA-256, the
emitted chunk filename, and the chunk's build-time SHA-256. A post-build gate
compares its module paths and hashes with all 52 entries in the separately
generated source-header archive, then hashes the bytes on disk to detect a
changed chunk. The current manifest SHA-256 is
`4da93a3f9e2e4dc3cc7f0c830290d99f63e574f9139c1a6e2f2b592276f43bca`;
all 52 sources map to `assets/rfb-CxsXsMUX.js`, SHA-256
`de332067c65ed8e994202e8e082f608bd9f65d47554406a91832296b42672a49`.
`bun run check` now executes `licenses:novnc:bundle-check` immediately after
the production build, avoiding a stale previous-output pass.

A fresh isolated unsigned macOS arm64 directory package has `app.asar` SHA-256
`2464c6e48372679f846456f663652dc944d1b8e425d795d66f8f336c1cb06e29`.
Its packaged-license journey extracted the ASAR manifest, required byte
identity with the current build, rehashed the packaged RFB chunk, and passed.
The About/legal journey also passed; both tests were 2/2. The temporary app was
moved to Trash, recoverably, and no retained release candidate was replaced.

This closes the narrower _actual Vite noVNC module-list versus installed
source-header archive_ trace for this unsigned macOS build. It still does not
map all bundled components, establish MPL source availability, prove a
source-to-binary relation through minification, supply rights clearance or
cover installed Windows/native-Linux products. IR-02/IR-11 remain **In
progress**.
