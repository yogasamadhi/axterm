# IR-14 migration-period clean-checkout rehearsal

Date: 2026-09-25  
Status: **local engineering rehearsal passed; W-14-02/03 and IR-14 remain open**  
Platform: macOS arm64, Bun 1.4.0, Node 24.18.0, Docker 29.6.2

This exercise checks whether a prepared snapshot of the **current migration-period**
source can be cloned and checked independently of the old working tree. It is
not the final M3 removal snapshot or the owner's new public repository.

## Reproduction and result

With Docker running and a disposable working directory on the project volume:

```sh
TMPDIR=/Volumes/A/code/project/axterm-candidate-run.cdwpYa \
  bun run candidate:check --ssh --external-peers
```

The candidate script prepared a temporary Git root and a distinct
`git clone --no-local`, installed dependencies with the frozen lockfile, ran
`bun run check`, the authenticated SSH fixture and both independent external
SSH/PTY transfer peers. Its final report was:

- Temporary source-root commit: `3f57cb6c3f95263f8fea3bca8c80762c5aeeb488`.
- Clean clone tracked **966 files**. Audited source-tree SHA-256:
  `c270c54eafebc43652354da1187a04ba1c93cdbe14a7269a2b705459aa63f7e9`.
- Snapshot hygiene passed: no forbidden entries, `.gitmodules`,
  `vendor/legacy-prototype`, environment files, oversized files, symlinks, transient
  artifacts, generated API files, detected credential containers or
  high-confidence textual secrets.
- Frozen install and complete `bun run check` passed: **1,268** unit/integration
  tests passed (**38** skipped); **21/21** visual/accessibility journeys passed.
  Architecture, Contract, source-ledger, license, localization and build gates
  passed.
- Authenticated SSH fixture and its desktop journey passed **1/1** each.
  Independent external lrzsz SSH/PTY tests passed **16/16**; independent
  trzsz-go SSH/PTY tests passed **7/7**.
- Post-run exact-label checks returned no remaining
  `axterm.external-trzsz-ssh` or `axterm.external-lrzsz-ssh` Docker peer
  containers.

The first external-peer attempt had **one** failed test out of the seven
trzsz-go cases: the test queried `docker ps -a` immediately after the SSH/PTY
channel exited and sometimes observed Docker's `--rm` container before
asynchronous removal finished. A later exact-label check showed no remaining
container. The test now polls the _same_ no-container assertion for at most
five seconds at 50 ms intervals. It still fails if the container remains;
neither the cleanup assertion nor the scenario is skipped. The focused
trzsz-go suite then passed **four consecutive 7/7 runs**, followed by the
complete clean-clone command above passing. The changed test is
`packages/runtime/src/adapters/terminal-transfer/external-trzsz-ssh-pty.test.ts`.

## Release boundary

This verifies reproducibility and a bounded runtime cleanup assertion for
the local snapshot only. It does **not** establish copyright or trademark
clearance, complete secret-content review, signed/notarized packaged-app
behavior, Windows/Linux native behavior, owner-created remote Git history,
CI, or public-download integrity. Migration-period Legacy Prototype import/link/sync
compatibility is intentionally still present; its removal requires the actual
M2 migration window and M3 gate. Therefore this evidence does not close
W-14-02, W-14-03 or IR-14, and does not authorize deleting the old GitHub
repository. W/IR/M1 counts remain **4/46, 2/14, 14/14**.
