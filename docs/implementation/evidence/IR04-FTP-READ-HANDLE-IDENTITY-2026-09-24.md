# IR-04 FTP read-handle identity boundary — 2026-09-24

Status: **deterministic regression and macOS packaged smoke verified; IR-04 remains In progress**.

## Finding and correction

The independent FTP server checked `realpath` confinement before opening a
regular file for `SIZE`, `MDTM` or `RETR`. `O_NOFOLLOW` protects the final path
component but not an ancestor: another local process could replace an ancestor
with a link to an outside-root directory between resolution and `open`. That
would let the resulting file handle point outside the granted root. This was a
read-disclosure boundary, distinct from the already documented mutation checks.

The read path now compares the resolved pathname and filesystem identity
before and after opening with the actual file-handle identity. It rejects a
non-regular file or any mismatch before sending metadata or bytes, and closes
the handle on rejection. The opener seam is used only by the deterministic
regression; production uses `node:fs/promises.open`.

The real-FTP regression exchanges an in-root ancestor for an outside-root
symbolic link precisely during `open`, restores it immediately, and requires
`SIZE`, `MDTM` and `RETR` to fail. It checks that no download bytes were
delivered, all opened handles were closed, both files were unchanged and the
authenticated control channel still accepts `NOOP`. The focused Adapter suite
passed **30/30**; `bun run typecheck` passed. The pinned Linux FTP source smoke
now runs the same injected read-ancestor swap under both `linux/arm64` and
`linux/amd64`. Both runs passed the new
`ftp-read-ancestor-swap-denial=pass` marker, and the focused source/script
regressions passed **31/31**.

After the Linux smoke and guard-test changes, `bun run check` passed: 222 test
files passed / 5 skipped; 1,122 tests passed / 33 skipped; 359 architecture
modules / 1,310 dependencies; 267 Contract operations; source-snapshot,
license/SBOM, build/package-layout and all 11 visual/accessibility journeys.

A fresh unsigned macOS arm64 directory package was built outside the source
checkout. Its Resources matched a generated SPDX sidecar byte-for-byte, and
the packaged independent FTP Widget journey passed **1/1**. This is a normal
production-opener journey; the deterministic swap is covered in the source
Adapter test, not by that packaged journey.

| Evidence item               | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| FTP server source           | `61a222eb0e67792af6782c9ba3d783fd45132275518cdc060491007add35f738` |
| Focused Adapter test        | `4f7034944f83b6f0e2b2f107f2df9104a28fe9a63c5c84271055d2e04eec7e39` |
| Linux source smoke          | `77b9118ea7c795247a350ba7a4be911501b5767378dc053d2c90fd030b40cce9` |
| Linux smoke guard test      | `a54e9066cede57f46320bce77cef4a80688e98eceec441d335e00607a0ce2e57` |
| macOS package `app.asar`    | `351f1c791b95facc2073bf10dd7a5bf44b06e4462efc0285dc595d4081eea862` |
| macOS packaged SPDX sidecar | `fd3a90491240c2f4620fa15191967a32c9b98307203968760c210baedb2dfb1d` |

## Remaining limits

The identity checks reject the demonstrated swap, but path-based Node APIs
are not a portable, atomic `openat`-style confinement primitive. An adversary
able to replace an ancestor multiple times across these checks may still
exploit a remaining time-of-check/time-of-use interval. The File Grant should
not be treated as a hostile local-writer sandbox without a separately reviewed
platform-specific or capability-based filesystem design. Independent protocol
and security review, Windows and native-Linux installed-package evidence,
source-rights approval and release signing remain outstanding. The Linux
containers are source-level architecture smokes, not native-Linux installed
packages. IR-04 is not Accepted, and this evidence does not alter the 2/14
matrix count.
