# IR-13 current macOS DMG — conditional packaged journeys

Date: 2026-09-25. Scope: the **unsigned, local** current-source macOS arm64 DMG candidate in [the independent-install record](IR13-MACOS-CURRENT-DMG-INSTALL-2026-09-25.md). Its `app.asar` SHA-256 was `01e2fa75cc7b674cb4f7561ad336127c47512219aa4faf6aa3099ca60f69bb20` before and after these runs; the DMG SHA-256 was `aaf99221aed3c1749acc48261dd7427f0c8cd0f40b77298368558df0846661a8`.

The base DMG suite passed 23 applicable journeys and skipped 14 conditional ones. The controlled [OpenSSH follow-up](IR13-MACOS-CURRENT-DMG-SSH-2026-09-25.md) covered its SSH condition. This record covers the other **seven macOS conditions**: one historical-source package upgrade and six real-volume transfer journeys. The six Windows/Linux cases still require their own native platforms.

## Historical-source package upgrade — 1/1

The old application was rebuilt from commit `657b3cc1552cd3b0dc3b0f73df1c1a4a5a8a6a6e` in a detached worktree. Its `app.asar` SHA-256 was `5dc53bcc5997016a33e8fa41d588462a7b441cde759b181c95e4df6f91c916b0`. Both old and current manifests report `0.10.0`; this is a synthetic historical-source upgrade, **not** a customer upgrade from a verified public old installer.

```sh
AXTERM_PREVIOUS_PACKAGED_APP=/Users/h/.codex/worktrees/axterm-initial-release/axterm/release/mac-arm64/Axterm.app \
AXTERM_PACKAGED_APP=/tmp/axterm-macos-current-dmg.2kk8Po/mac-arm64/Axterm.app \
bunx playwright test tests/e2e/packaged.spec.ts --project=packaged \
  --grep 'current packaged app upgrades data produced by a historical packaged release'
```

The focused packaged journey passed **1/1**. It exercises the old package's creation of synthetic SQLite/Vault/profile/theme/WebDAV data, the current package's upgrade and rollback copy, and explicit recovery rather than silent remote mutation. The test's ignored receipt was not retained after later Playwright runs; this evidence records the observed command result and exact application hashes, not a durable receipt hash. A real archived public installer and sanitized user-data scope remain W-08-02/W-13-02 work.

## Real FAT16 and ExFAT volumes — 6/6

A new 64 MiB writable disk image was mounted at a private temporary path. `diskutil info` reported `File System Personality: MS-DOS FAT16`, 67,108,352 disk bytes, and a writable, mounted image device. With `AXTERM_REAL_NOHARDLINK_DIRECTORY` set to that mount, the current packaged-app TRZSZ, ZMODEM and XMODEM binary roundtrip journeys passed **3/3**. The test first verifies a real hard-link rejection on the destination, then completes the native no-replace publication path.

```sh
AXTERM_REAL_NOHARDLINK_DIRECTORY=<verified FAT16 mount> \
AXTERM_PACKAGED_APP=/tmp/axterm-macos-current-dmg.2kk8Po/mac-arm64/Axterm.app \
bunx playwright test tests/e2e/packaged.spec.ts --project=packaged \
  --grep 'packaged app roundtrips (TRZSZ|ZMODEM|XMODEM) binary data'
```

A separate new 128 MiB writable image was mounted at a private path. `diskutil info` reported `File System Personality: ExFAT`, 134,217,216 disk bytes, and a writable, mounted image device. With `AXTERM_REAL_NO_REPLACE_DIRECTORY` set to that mount, all three packaged protocol journeys passed **3/3** by rejecting unsupported publication without an incomplete final file or staging residue. This is **fail-closed behavior, not successful ExFAT downloading**.

```sh
AXTERM_REAL_NO_REPLACE_DIRECTORY=<verified ExFAT mount> \
AXTERM_PACKAGED_APP=/tmp/axterm-macos-current-dmg.2kk8Po/mac-arm64/Axterm.app \
bunx playwright test tests/e2e/packaged.spec.ts --project=packaged \
  --grep 'packaged app rejects unsafe real-volume publication through'
```

Both test mounts were empty after the journeys. The exact temporary devices were detached, `hdiutil info` no longer listed either image, and their images and empty mount directories were removed. No user volume was formatted.

Together with the OpenSSH record, this covers all eight **macOS conditional cases** omitted by the base DMG suite, on this candidate's `app.asar`. It does not demonstrate SMB/NFS success, arbitrary removable-volume compatibility, a signed/notarized installer, a real public-old-version upgrade, an active updater or Windows/Linux native operation. W-13-01 may close, but IR-03, IR-08 and IR-13 remain unaccepted.
