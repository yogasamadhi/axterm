# IR-10 macOS packaged connection-configuration accessibility — 2026-09-24

State: **unsigned local directory-package evidence; IR-10 remains In progress**

## Artifact and command

A fresh macOS arm64 Axterm `0.10.0` directory app was built from the current
worktree into a new temporary directory outside the checkout. Electron-builder
`26.16.1` packaged Electron `44.3.0`; automatic ambient code-signing identity
discovery was disabled. The app was unsigned and unnotarized. The packaged
`Contents/Resources/app.asar` was 109,695,491 bytes, SHA-256
`8b1233b184e68b0d511031231e0ab490ef7787500bdda84309b825a48af87ebe`.
The temporary output was moved to the user's Trash after testing; it is not a
retained or published installer.

The focused packaged journey passed **1/1**:

```sh
AXTERM_PACKAGED_APP=<fresh-output>/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  --grep 'packaged migration and configuration surfaces pass rendered accessibility scans'
```

The test copies the app outside the checkout again, starts it with a fresh user
profile and restricted `PATH`, then injects test-only axe-core into the packaged
renderer. In addition to its existing Shell, migration, configuration-export
preview and populated Host Manager scans, it now audits the SSH and SPICE
connection-configuration editor states. It focuses the SSH protocol tab,
selects SPICE using End, verifies focus and selection, and Tabs into SPICE's
first input. Both states pass the configured WCAG 2.0 A/AA, 2.1 A/AA, 2.2 AA
and axe best-practice scan.

This verifies a real packaged renderer and keyboard route, not a signed DMG,
public installation, screen-reader human review, source/brand rights, or
Windows/native-Linux behavior. It does not accept IR-10 or IR-13.
