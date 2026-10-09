# IR-13 Linux x64 AppImage runtime gate — 2026-09-24

Status: **gate implemented locally; no successful native Linux run yet; IR-13 Open**.

The [current AppImage candidate](IR13-LINUX-X64-APPIMAGE-READ-HANDLE-2026-09-24.md)
passed static SquashFS/SPDX verification, but its direct execution under
emulated `linux/amd64` failed before Axterm code ran. Static extraction cannot
answer whether the distributable AppImage starts on a native Linux x64 host.

## Gate now present

- `scripts/test-linux-appimage.sh` requires Linux x64, selects one regular
  AppImage, and invokes the dedicated packaged Playwright journey under Xvfb.
- The journey copies the **AppImage file**, not `linux-unpacked`, outside the
  source checkout and restores the copied file's execute bit. It launches that
  copy with `APPIMAGE_EXTRACT_AND_RUN=1`, compares Electron's application
  version with the source manifest, waits for Desktop Runtime `ready` and
  creates a second local terminal tab. The copied image's size and SHA-256
  must match the sole AppImage entry in the Linux release-hash manifest before
  launch, and the bytes must still match after clean shutdown; mismatches
  prevent a success receipt.
- The workflow runs static payload verification followed by this runtime
  gate before upload. After artifact download it checks installer hashes and
  SPDX bytes, then repeats both AppImage gates. Only a passing downloaded run
  writes `AXTERM_APPIMAGE_RUNTIME.linux-x64.json`, containing the executed
  artifact's SHA-256, app version, host platform/architecture and observed
  runtime/tab assertions. The workflow uploads that receipt with the other
  roundtrip records.
- The extract-and-run path is [documented by AppImage](https://github.com/AppImage/appimagekit/wiki/fuse)
  for environments without FUSE access. It specifically does not test the
  default FUSE launch path or desktop integration.

## Local verification and remaining evidence

On the development host, `bunx vitest run
tests/unit/installed-package-gates.test.ts` passes **10/10**; `sh -n` accepts
the shell gate; Playwright lists the dedicated packaged journey. Invoking the
gate on this non-Linux host exits 2 with `The AppImage runtime gate requires
Linux x64.` The full `bun run check` passes 222 test files (1,124 passed,
33 skipped), 359 Level 1 architecture modules / 1,310 dependencies, all
267 Contract operations, build/package layout and 11 Axterm visual/accessibility
journeys. No native AppImage launch has been claimed from these checks.

Before upgrading IR-13, retain a successful native Linux x64 CI run and the
downloaded artifact/runtime receipt, then separately verify ordinary desktop
launch/integration, signed distribution, external SSH, historical-binary
upgrade and the public updater feed as required by the release matrix.
