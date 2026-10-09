# IR-03 atomic no-replace publication candidate — 2026-09-24

Status: **historical isolated proof of concept; subsequently integrated as an
unsigned macOS arm64 worktree trial, not release-accepted**. See the
[packaged implementation record](IR03-MACOS-ARM64-NATIVE-PUBLICATION-2026-09-24.md)
for current behavior and artifact checks.

At the time of this proof of concept, the Runtime used `link()` first and
`COPYFILE_EXCL` when hard links were unavailable. [Node 24.18.0's `copyFile` contract](https://nodejs.org/download/release/v24.18.0/docs/api/fs.html#fspromisescopyfilesrc-dest-mode)
does not promise atomicity, even with `COPYFILE_EXCL`; it only attempts to
remove a destination after an error. The [fs-safe native architecture](https://fs-safe.io/native.html)
describes Linux `renameat2(RENAME_NOREPLACE)`, macOS
`renameatx_np(RENAME_EXCL)` and Windows handle-relative no-replace rename as
the candidate primitive. This is a design lead, not proof on all filesystems.

An isolated directory outside the repository installed exact
`@openclaw/fs-safe@0.13.1` with `npm install --ignore-scripts --no-audit
--no-fund`. The registry package declares MIT, unpacked size 3,045,948 bytes
and integrity
`sha512-nfsEjPirAKotKBaQoQt10JbZx3RwkFIcv2Ujj0m3DCJCP5Jre3AUnMatVinsNL/W60IL4XeRWEXCvlra7edx7g==`.
Its macOS arm64 optional binary declares MIT, unpacked size 1,593,977 bytes
and integrity
`sha512-dyPCOfMVJMXaP2yJIIyZrvK3TyQpCEduhvvfH3Zbcw/4SrdKP574qghgJM+VCVg2T9TEHTN4YBNO6z52iiMI3g==`.
The parent package's MIT `LICENSE` SHA-256 is
`8d703995c48aeb3726ab83f111a10ee696835e096802ee0329ac50216ab9434e`;
the binary subpackage has an MIT manifest but no separate `LICENSE` file,
which would require explicit notice handling if adopted.

With Node 24.18.0 on this macOS arm64 host, an isolated `root(directory)`
performed `move('.staged', 'received.bin')`: the final file contained the
complete source bytes and the staging pathname was consumed. A second move
against the existing destination raised `FsSafeError` code `already-exists`
while preserving both existing destination and new staging bytes. With native
mode configured `off` before constructing the root, the no-replace move raised
`helper-unavailable`; the staging file remained and no destination appeared.
These were direct POC calls, not Axterm protocol or packaged-app tests.

The exact package's public `@openclaw/fs-safe/durability`
`publishFileExclusive({ strategy: 'rename-noreplace' })` was then exercised
in another isolated Node 24.18.0/macOS arm64 process. Success returned
`method: 'rename-noreplace'` and `directorySync.status: 'synced'`, consumed
the staging pathname, and left the full bytes at the final name. A collision
raised native `EEXIST` without changing either file. Native mode `off` raised
`FsSafeError` code `helper-unavailable`, leaving the staging bytes and no
final name. A test-only injected directory-sync failure **after** the rename
raised `helper-failed` with `details.phase: 'directory-sync'`,
`targetCreated: true`, `directorySync.status: 'failed'` and
`cleanup: 'preserved'`; the source name was gone and the complete final bytes
remained. Axterm must not report this last case as if publication had never
occurred or delete the final file on a retry. These tests did not simulate a
crash or prove durability on removable/network filesystems.

The package's published `exports` and `.d.ts` surface contains no synchronous
`Root.move` or `publishFileExclusiveSync`: both supported operations return
`Promise`. Its private native binding does expose a synchronous primitive,
but importing unexported internals would couple Axterm to an unsupported
implementation detail. XMODEM then called `publishStagedFileSync()` in a
synchronous EOT completion path, so the candidate cannot safely cover all
three protocols without an async state/lifecycle refactor. That refactor must
fence cancel/destroy/new-session races, ensure the pending operation owns its
staging file, and ACK/emit completion only after publication settles.

At this POC stage the candidate was not in Axterm's `package.json`, `bun.lock`, installer or
third-party notices. Adoption would be a new Runtime-only native dependency
under [ADR-019](../../adr/ADR-019-atomic-no-replace-transfer-publication.md)
and requires exact source/binary rights review, native binding packaging,
Headless/Electron tests, all three installed platforms and actual
hard-link-limited filesystem evidence. Until then the existing
`COPYFILE_EXCL` non-atomic fallback was an unresolved IR-03 safety gate.

## Registry provenance cross-check

The official npm registry reports provenance attestations for exact
`@openclaw/fs-safe@0.13.1` and its macOS arm64 native package. In the same
isolated installation, `npm audit signatures --registry=https://registry.npmjs.org
--json --include-attestations` verified 15 registry signatures and two
attestations, with empty invalid/missing lists. The two verified SLSA
statements bind the respective package subjects' SHA-512 digests to
`openclaw/fs-safe` `.github/workflows/release.yml`, tag `v0.13.1`, resolved
commit `7022a0a10c53e36f34a467df68ed5614a1db1741` and GitHub Actions
run `35153270431` attempt 1. `git ls-remote` separately resolved that tag
to the same commit. The npm subject digests match the registry integrity
values recorded above. See [npm's provenance-verification procedure](https://docs.npmjs.com/viewing-package-provenance/)
and the [publisher's v0.13.1 release](https://github.com/openclaw/fs-safe/releases/tag/v0.13.1).

This establishes a verifiable publication/build-origin chain for the parent
and the one native package installed on this host; it is **not** a license or
security review of source lines, a local reproducible binary build, or
verification of the other six platform packages. The native subpackage still
has no separate `LICENSE` file in its tarball, so attribution and distribution
review remain open. This registry check itself changed no Axterm production
dependency or IR-03 state; the later worktree implementation is tracked in
the packaged implementation record linked above.
