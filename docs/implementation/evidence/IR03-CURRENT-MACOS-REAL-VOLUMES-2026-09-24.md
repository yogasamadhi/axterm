# IR-03 current macOS candidate on real FAT16 and ExFAT volumes

Date: 2026-09-24  
State: **local engineering evidence; IR-03 and IR-13 remain unaccepted**

This run used the current unsigned macOS arm64 candidate documented in
[IR-13](IR13-MACOS-UNSIGNED-CANDIDATE-2026-09-24.md), not an older directory
build. Immediately after the tests, its `app.asar` SHA-256 was
`23e23e99948b22b72fcb84394d977fb3d4a62fc252ab9736e998c75a8185dd5c`;
the corresponding DMG SHA-256 was
`321e4ffdcfb947a6d221237129b3f1808a4322b730611c6325763724d4127986`.
The tests launched a copy of that candidate app; they did not install a signed
release or run from a mounted DMG.

## FAT16: completed publication

A temporary writable 64 MiB `MS-DOS` disk image was mounted at a private test
path. `diskutil info` identified its actual filesystem personality as **MS-DOS
FAT16**. With `AXTERM_REAL_NOHARDLINK_DIRECTORY` set to that mount:

- The focused real-volume `staged-file-publication.test.ts` case passed **1/1**
  (eight unrelated cases filtered/skipped). It first asserted that a real
  same-directory hard link is rejected, then verified that native no-replace
  publication consumes the staging name, creates the complete final bytes, and
  preserves both an existing destination and new staging bytes on `EEXIST`.
- The current packaged app passed the real local-PTY **TRZSZ, ZMODEM and
  XMODEM** binary send/receive journeys **3/3**. Each download-directory
  fixture again asserted real hard-link rejection before exercising the
  Runtime fallback through the application's File Grant and terminal UI.

## ExFAT: fail-closed publication

A separate writable 128 MiB image was formatted only after its `/dev/disk5`
device was verified as the newly attached, 134,217,728-byte temporary disk
image; `diskutil info` identified the mounted volume as **ExFAT**. With
`AXTERM_REAL_NO_REPLACE_DIRECTORY` set to this mount:

- The focused Runtime publisher and three protocol-peer tests passed **4/4**
  (57 unrelated cases filtered/skipped). The publisher case establishes that
  this volume rejects a real hard link and native no-replace publication,
  preserves an existing destination, and does not create an incomplete final
  file. XMODEM, ZMODEM and TRZSZ report the unsupported-destination failure
  and clean their transfer staging files.
- The same packaged app passed the three real-volume local-PTY refusal
  journeys **3/3**. Each reached `failed`, showed the localized instruction
  to choose another destination, and left no final payload or transfer `.part`
  file. This is **not** successful ExFAT download support.

Both mounted volumes were inspected after the tests: FAT16 had no remaining
test entries; ExFAT had only its OS-created `.fseventsd` directory. The two
images were detached and the exact temporary image directory was removed.

The result updates the earlier [macOS native-publication trial](IR03-MACOS-ARM64-NATIVE-PUBLICATION-2026-09-24.md)
for the current candidate's bytes. It does not establish crash durability,
successful publication on ExFAT or SMB/NFS, all removable volumes, a signed
and notarized installer, legal/source-rights clearance, or Windows/native-Linux
behavior. IR-03 remains **In progress** and IR-13 remains **Open**.
