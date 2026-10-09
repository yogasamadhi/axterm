# IR-12 macOS arm64 no-submodule build evidence

Date: 2026-09-20  
State: **partial IR-12 evidence; not release acceptance**

This run used an uncommitted source-worktree copy at
`/tmp/axterm-independent-check.GmD68b`. The copy excluded `.git`, `vendor`,
`node_modules`, previous build/release/test outputs, `.env*` and local databases;
absence of both `.git` and `vendor` was checked before and after the runs.
`bun install --frozen-lockfile` installed dependencies and rebuilt Node PTY.
The source copy is **not** a fresh checkout of a committed new repository.

| Check in the isolated copy                        | Observed result                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run check`                                   | Passed: 813 unit tests, one skipped; Level 1/Zero Business IPC; 256 Contract operations; 15-language/45-key navigation checks; production build/layout; one Axterm visual and two accessibility Playwright tests.                                                      |
| `bunx playwright test --project=desktop`          | 73 passed, 11 conditionally skipped on macOS. The complete run followed correction of a stale success-message assertion in the terminal-theme E2E; it did not change product behavior or skip that journey.                                                            |
| `bun run package:dir` and `bun run test:packaged` | Unsigned macOS arm64 directory app built; 14 packaged journeys passed, nine Windows/Linux/fixture-conditional journeys skipped. The checkout-independent test copies the app outside the source tree, limits `PATH`, exercises PTY, SQLite, settings and cold restart. |
| `bun run test:ssh:packaged`                       | Real Docker OpenSSH integration, source Electron authenticated SSH and packaged Electron authenticated SSH each passed (one test each). Fixture containers and network were removed by the test script.                                                                |
| `bun run package` and `bun run test:dmg:macos`    | Unsigned arm64 DMG/ZIP built. `hdiutil verify` passed; the DMG was mounted, its app copied to a separate directory, detached, and the copied app passed 14 packaged journeys with nine conditional skips.                                                              |

The packaged journeys include exact legal-file/About comparisons, rebuilt native
modules, FTP Widget, local-PTY XMODEM/ZMODEM/TRZSZ roundtrips, RDP module
initialization, compatibility deprecation notice, local-Vault profile upgrade
and signed-update test-fixture behavior. A module initialization is not a live
RDP connection; local-PTY protocol tests are not every remote/platform case.

Artifact SHA-256 values from the final `bun run package` in this copy:

These hashes identify the earlier no-submodule snapshot before the later
third-party component index was added. The newer app/DMG hashes are recorded
in [IR-11 component-index evidence](IR11-COMPONENT-INDEX-2026-09-20.md).

| Artifact                                                        | SHA-256                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `release/Axterm-0.10.0-arm64.dmg`                               | `9f89f0bfe54656bf3a4ba4406354d009e3b65fd03e37160cd0912465308299db` |
| `release/Axterm-0.10.0-arm64-mac.zip`                           | `36494bf9f99f2dd351e190bc7e9244ee47690aff3f8856d42acdd979047cd347` |
| `release/mac-arm64/Axterm.app/Contents/Resources/app.asar`      | `d84bc9c7a6d30c48d3136579493f3e2cd594f20ca45d816990f5dea0037cd17f` |
| `release/mac-arm64/Axterm.app/Contents/THIRD_PARTY_NOTICES.txt` | `05966a21da8d98bc7e909c7648cbeda3fad627a7c437390843696f1320b14c88` |

## Current post-removal source-copy run

On 2026-09-21, a second temporary copy at
`/tmp/axterm-independent-current.9uoPMz` was made from the current worktree
after the historical material had been moved to the controlled archive. The
copy excluded `.git`, `.gitmodules`, `vendor/legacy-prototype`, `node_modules`, build
and release outputs, test outputs, and `.env*`; each excluded path was asserted
absent before installation. `bun install --frozen-lockfile` rebuilt the native
dependencies, and the complete `bun run check` passed: 839 unit tests passed,
one was skipped, the Level 1/Zero Business IPC gate and 262-operation Contract
gate passed, and production build plus the three Axterm visual/accessibility
journeys passed. This is current, stronger no-submodule source evidence, not a
committed fresh Git checkout, CI run, signed package, or cross-platform release
acceptance.

Still open: a committed clean Git checkout and actual CI result; Windows/Linux
source, installed package and upgrade runs; signed/notarized production macOS
artifact; complete third-party SBOM/source-rights and brand review; real
external-host/cross-platform protocol interoperability; public migration
window and final historical-artifact removal. Neither the unsigned DMG nor the
green macOS checks close IR-12, IR-13 or IR-14.
