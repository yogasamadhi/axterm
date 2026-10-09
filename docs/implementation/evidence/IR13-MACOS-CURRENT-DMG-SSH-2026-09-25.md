# IR-13 current DMG candidate — controlled OpenSSH fixture

Date: 2026-09-25. Result: **three focused tests passed; IR-13 remains Open**.

This follow-up uses the [fresh current-source unsigned DMG candidate](IR13-MACOS-CURRENT-DMG-INSTALL-2026-09-25.md), not a newly signed or publicly distributed release. Before and after the test, the unpacked application's `app.asar` SHA-256 was `01e2fa75cc7b674cb4f7561ad336127c47512219aa4faf6aa3099ca60f69bb20`; the source DMG SHA-256 was `aaf99221aed3c1749acc48261dd7427f0c8cd0f40b77298368558df0846661a8`. This identifies the exact candidate whose base DMG journey had conditionally skipped SSH.

Command:

```sh
AXTERM_PACKAGED_APP=/tmp/axterm-macos-current-dmg.2kk8Po/mac-arm64/Axterm.app \
  bun run test:ssh:packaged
```

`scripts/test-ssh-fixture.sh` created a private Docker network and three OpenSSH containers for a jump-chain fixture, verified all three TCP hops, then ran:

| Layer                                               | Result     |
| --------------------------------------------------- | ---------- |
| `tests/integration/ssh-fixture.test.ts`             | 1/1 passed |
| Source Electron B-12 authenticated save-and-connect | 1/1 passed |
| Current packaged application's SSH terminal         | 1/1 passed |

The script exited 0 and its trap removed the fixture containers/network; a subsequent label-filtered `docker ps` returned no containers. The script rebuilds source Electron output for its source-Electron journey, but does **not** repackage or modify the selected `Axterm.app`; the post-run ASAR hash remained the candidate hash above.

This is a local, controlled SSH fixture. It does not prove public-network operation, signed/notarized installation, real previous public-version upgrade, Windows/Linux native behavior, active update feed, or rights approval. The latest DMG's historical-package and real-volume conditional cases also remain separate. IR-13 therefore stays **Open**.
