# IR-11 noVNC source-copy and installed-package trace

Date: 2026-09-23  
Scope: `@novnc/novnc@1.7.0`, local unsigned macOS arm64 directory app  
Result: exact published source copy and package trace added; **IR-02/IR-11 remain In progress**.

The unchanged published npm tarball is supplied as
`licenses/noVNC-1.7.0-source.tgz`, SHA-256
`32689f18d6abe96bc6530828a6bd0b9ae33bda07c083a6575ed255b5a8f2e903`.
Its SHA-512 is the same
`sha512-ucEJOx4T2avIRCleodk7YobZj5O2Ga2AeLfQ69A/yjG9HHba2+PDgwSkN3FttrmG+70ZGx21sElNFouK13RzyA==`
integrity pinned for `@novnc/novnc@1.7.0` in `bun.lock`. The publisher's
[noVNC 1.7.0 release](https://github.com/novnc/noVNC/releases/tag/v1.7.0)
and the installed `package.json` identify the upstream project and version.
The tarball has 66 files; every path and byte matches the package used for
Axterm's build. It includes all 52 RFB import-graph sources (42 core, ten
embedded Pako), package `LICENSE.txt`, `AUTHORS`, Pako LICENSE and the other
published companion texts. No upstream-source edits were made for this copy.

`bun run licenses:novnc:source-check` runs offline in the default gate. It
checks the fixed archive SHA-256 and locked SHA-512, safe tar entries, the full
66-file match against the installed npm package and the hashes of the 52
source inputs already recorded in `noVNC-SOURCE-NOTICES.txt`. The existing
Vite provenance gate separately binds those 52 installed inputs to the
Renderer RFB chunk and checks its bytes. `noVNC-SOURCE-README.txt` explains
the archive in Settings → About; the source archive itself sits alongside it
in the installed `licenses/` directory. The exact source archive and guide
are both checked in the packaged Legal/About journeys.

An isolated unsigned macOS arm64 directory app passed both packaged
Legal/About journeys (2/2). Its `app.asar` SHA-256 is
`eb86b1865a487a3810cd5fec7ddc48afd9817cc1b583ad0db9c498aa68358ad0`.
Its regenerated 87-package / 243-file SPDX sidecar passed byte-for-byte
verification; SHA-256
`549b93c1599ef9d4576fddd4e75dcbea0749df34b01ff27e85ced166aa6d3b6e`.
The tarball is a separate `ARCHIVE` entry with the exact SHA-256 above.

The [MPL 2.0](https://www.mozilla.org/en-US/MPL/2.0/) addresses executable
distribution and source availability. This technical evidence does not by
itself settle whether the final signed macOS, Windows and Linux products meet
all MPL notice/source-delivery duties, whether an additional modification
record is needed, or the completeness of all third-party attributions. The
publisher's AUTHORS file explicitly says its contributor list is incomplete.
Qualified rights review and final-platform artifact checks remain open.
