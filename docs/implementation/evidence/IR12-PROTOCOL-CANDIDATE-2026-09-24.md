# IR-12 current protocol-candidate evidence — 2026-09-24

Status: clean-checkout engineering evidence for IR-12; it is not a rights,
brand, platform-installation, or signed-distribution approval.

## Reproduction

From the current worktree:

```text
bun run candidate:protocol:check
```

The command creates a clean non-local Git clone, performs a frozen install of
610 packages, rebuilds `node-pty` for the embedded macOS arm64 Node ABI, runs
`bun run check`, then verifies a real OpenSSH Runtime fixture, the production-
Electron B-12 Save-and-Connect journey, pinned external ZMODEM/XMODEM/TRZSZ
peers, and the `lrzsz`/`trzsz` SSH journeys.

## Result

- Result: passed on 2026-09-24.
- Source snapshot: 807 files, 18,311,621 bytes.
- Snapshot SHA-256: `7fecd5848a19958a885372d3e8170d0005d7df41a080bc390a9d0640411cd3e7`.
- Ephemeral root commit: `2fc07b436ecee581a53cfad1a4088e2c562d7699`.
- Full check: 220 test files passed, 5 skipped; 1,074 tests passed, 33
  skipped; 358 architecture modules / 1,307 dependencies; all 267 Contract
  operations; nine visual and two accessibility journeys.
- Real OpenSSH Runtime fixture and production-Electron B-12 journey: passed.
- Pinned external peers: 16 `lrzsz` SSH tests and seven `trzsz` SSH tests
  passed against Linux arm64 peers; the `lrzsz` Debian package hash was
  verified before use, and peer containers ran without network access.
- Cleanup: the temporary clone, SSH fixture and protocol-peer containers were
  confirmed removed after the run.

This revalidates clean independent-source build evidence for IR-12. It does
not close IR-02 rights review, IR-03/IR-04 source and platform reviews, IR-05
human language review, IR-07 asset/brand review, or IR-13 installed,
signed/notarized and update-feed evidence. It does not create the new public
repository or authorize deletion of the old one.

## Latest ExFAT/DMG-source replay

The same `bun run candidate:protocol:check` was rerun after the macOS ExFAT
failure-closed implementation, DMG-copied packaged journeys, historical
upgrade replay and OpenSSH revalidation had entered the current worktree.
It again created a **non-local clean clone without `.gitmodules` or the
Legacy Prototype submodule**, performed frozen installation (**617 packages**) and
passed the complete `bun run check`: **235 unit/integration files passed,
five skipped; 1,177 tests passed, 38 skipped; 360 architecture modules /
1,310 dependencies; 267 Contract operations; 11 visual/accessibility
journeys**. The Docker OpenSSH Runtime fixture and source Electron B-12
journey each passed **1/1**. The isolated external Linux arm64 SSH peers
passed **16 `lrzsz`** and **seven `trzsz`** tests.

The source snapshot contained **902 files / 23,620,041 bytes**, SHA-256
`1bada92d7d3146ef43f20ad0166142511c5164a28beacfbd17626bc4e7386776`.
The temporary root commit was
`2ac407ee8d93e05b51f40723f889b7d9fa834fe1`. The audit reported no
forbidden entries, environment files, oversized or transient artifacts,
high-confidence secrets, symlinks, or dependency violations. The candidate
directory was removed on exit; labeled SSH containers and fixture networks
were absent afterward. This is a local migration-period clone, not the
owner-created public repository, a final Legacy Prototype-free snapshot, source
rights approval or three-platform installed-release acceptance.
