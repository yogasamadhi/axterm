# IR-03 ZMODEM/TRZSZ remote filename confinement — 2026-09-24

Status: **real protocol-pair regression passed locally; packaged and native-platform review remain open**.

The [Legacy Prototype transfer filename advisory](https://github.com/legacy-prototype/legacy-prototype/security/advisories/GHSA-38j7-23hf-9mhc)
describes a `../` filename escaping a user-selected download directory in
older Legacy Prototype application handlers. This record tests the analogous boundary
in Axterm's current Runtime adapters; it does not claim that the separately
published protocol libraries themselves are affected or that the current
Legacy Prototype release is vulnerable.

Both new tests drive a real published-library handshake rather than calling
the sanitizer in isolation:

| Protocol             | Remote-supplied name | Verified result                                                                                                                                                                           |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZMODEM via `zmodem2` | `../outside.bin`     | Existing `outside.bin` beside the selected directory remains byte-exact; received binary bytes appear only as `downloads/.._outside.bin`; no absolute path is emitted in transfer events. |
| TRZSZ via `trzsz2`   | `../outside.bin`     | The same confinement, preserved outside file, binary contents and path-free event boundary hold after the complete transfer handshake.                                                    |

The tests are in `packages/runtime/src/adapters/terminal-transfer/zmodem-protocol.test.ts`
and `trzsz-protocol.test.ts`. Their focused run passed 30/30 tests across both
files. The full `bun run check` passed 1,128 tests with 33 skips, including
architecture, Contract, build/layout and 11 visual/accessibility journeys.
The adapters use the shared `safe-transfer-name.cjs` leaf sanitizer
before joining the name to the canonical selected directory. This protects
the tested traversal case; it is not proof against every filename encoding,
reparse point, symlink race, filesystem policy or external peer. Installed
macOS/Windows/Linux and independently operated SSH evidence are separate
IR-03 gates.

Publication has a separate limitation: the normal same-directory hard-link
path is atomic and no-overwrite, while the hard-link-unsupported
`COPYFILE_EXCL` fallback is no-overwrite but **not guaranteed atomic** by
[Node 24.18.0's filesystem API](https://nodejs.org/download/release/v24.18.0/docs/api/fs.html#fspromisescopyfilesrc-dest-mode).
An interrupted fallback may expose an incomplete destination during the copy;
Node only attempts to remove it after an error. This test does not close that
filesystem-portability/safe-publication gate. A cross-platform atomic
no-replace strategy or a reviewed policy for unsupported filesystems remains
necessary before IR-03 acceptance.
