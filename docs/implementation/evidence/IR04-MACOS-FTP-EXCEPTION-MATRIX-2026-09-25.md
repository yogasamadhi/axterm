# IR-04 macOS FTP exception and restart matrix — 2026-09-25

Scope: close **W-04-02 macOS engineering**, not IR-04 acceptance. The FTP
implementation did not change in this follow-up. The new source regression and
packaged journey cover two previously unproven shutdown paths against the
current unsigned macOS arm64 DMG app. Independent protocol/security and rights
review, signed distribution, Windows and native Linux remain separate tasks.

## Covered cells

| Scenario                                                                                             | Direct evidence                                                                                                                                                                                     | Result                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login denial, bounded passive range, listing/upload/download, root confinement and permission denial | `widget-server-adapters.test.ts`; current packaged FTP journey in `packaged.spec.ts`                                                                                                                | Source and package pass; denied operations do not escape the granted root.                                                                                                                         |
| Long upload, slow download and control-session recovery                                              | [Long upload](IR04-MACOS-FTP-LONG-TRANSFER-2026-09-25.md), [slow download](IR04-MACOS-FTP-SLOW-DOWNLOAD-2026-09-25.md), current DMG [install journey](IR13-MACOS-CURRENT-DMG-INSTALL-2026-09-25.md) | The transfer may outlive the control idle timeout; a post-transfer `NOOP` succeeds.                                                                                                                |
| Passive and active data stall                                                                        | [Passive stall](IR04-MACOS-FTP-STALLED-DATA-2026-09-25.md), [active stall](IR04-MACOS-FTP-ACTIVE-STALL-2026-09-25.md), current DMG [install journey](IR13-MACOS-CURRENT-DMG-INSTALL-2026-09-25.md)  | Existing target remains intact, partial stage is removed, and a fresh session works. Source active-mode test also proves `426` and same-session `NOOP`.                                            |
| `ABOR` during ordinary/resumed upload and active download                                            | `widget-server-adapters.test.ts` in this snapshot                                                                                                                                                   | Real TCP tests require `426` then `226`; ordinary/resumed upload stages disappear, target remains intact and the same control session answers `NOOP`.                                              |
| **Abrupt client control disconnect during active upload**                                            | New real-TCP test in `widget-server-adapters.test.ts`                                                                                                                                               | A nonempty root-anchored stage is first observed; destroying the control socket preserves `existing.bin`, removes `.part`, and a newly authenticated session answers `NOOP`.                       |
| **Widget stop while upload active, then restart on the same port**                                   | New opt-in packaged branch `AXTERM_PACKAGED_FTP_STOP_RESTART=1` in `packaged.spec.ts`                                                                                                               | A nonempty stage is observed before UI stop; upload fails, existing target and stage cleanup are checked, the same fixed control port is rebound, and a new FTP session passes `NOOP` and listing. |

## Commands and results

```sh
bunx vitest run packages/runtime/src/adapters/widget/widget-server-adapters.test.ts
# 36/36 passed

AXTERM_PACKAGED_APP=/tmp/axterm-macos-current-dmg.2kk8Po/mac-arm64/Axterm.app \
AXTERM_PACKAGED_FTP_STOP_RESTART=1 \
bunx playwright test --project=packaged \
  -g 'packaged FTP Widget runs the independent server'
# 1/1 passed (4.8 s total)
```

The app is the already [verified, mounted-and-copied current DMG candidate](IR13-MACOS-CURRENT-DMG-INSTALL-2026-09-25.md).
Only test and documentation files changed since that DMG was built; the
unchanged FTP server source and matching app archive were checked before the
packaged run. The opt-in branch runs **inside** the copied app journey, not a
source-server substitute. A baseline packaged journey without the opt-in flag
also passed 1/1. These results do not claim a signed or publicly downloaded
installer.

| Item                  | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| FTP server source     | `2e492b14abbd3b763eaf246bd55204dda9b0fcd3d76c6256b8a623e2e495d42c` |
| FTP Adapter test      | `c38ddf14e7ef8a63568636213e6d7dd7b109fc1ae071171d0226b0d0a7b1358f` |
| Packaged journey test | `3fd0afc2009e30f90441b02cefe2ef1b3875442a7f1097f96045ca5897807971` |
| DMG                   | `aaf99221aed3c1749acc48261dd7427f0c8cd0f40b77298368558df0846661a8` |
| App `app.asar`        | `01e2fa75cc7b674cb4f7561ad336127c47512219aa4faf6aa3099ca60f69bb20` |

W-04-02 closes at its macOS-engineering scope. W-04-01 independent
protocol/security review, W-04-03 native Windows/Linux package verification,
source-rights review and final signed publication remain open; IR-04 remains
**In progress**.
