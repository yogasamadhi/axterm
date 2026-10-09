# Current macOS arm64 packaged-suite evidence — 2026-09-24

Status: unsigned directory-package engineering evidence only. This record does
not accept any independent-release matrix row by itself.

## Artifact and reproduction

- Product version: `0.10.0`
- Host: macOS `27.0.0`, arm64
- Electron: `44.3.0`; electron-builder: `26.16.1`
- Output: isolated directory package under
  `/tmp/axterm-reimport-packaged.paP3Pu/mac-arm64/Axterm.app`
- Signing/notarization: none; ambient macOS code-signing discovery was
  disabled by the packaging script.
- `Contents/Resources/app.asar` SHA-256:
  `fdbd4ea10e283a11bad833ed7ef53c28aa50e3c56f7518bc55cd6d70fb384289`
- `Contents/AXTERM_PRODUCTION_DEPENDENCIES.spdx.json` SHA-256:
  `02e91008c35e1a368b90ec55f280c459158727b8c78c291fdf7df634da55e80b`
- `Contents/THIRD_PARTY_NOTICES.txt` SHA-256:
  `45b153c0c9ae06814f8a2ef22999bcbf9ba92951a05fef29c8d980a9f6ce4332`
- `Contents/THIRD_PARTY_COMPONENTS.json` SHA-256:
  `00cd2b503cd623fe958eee182149b90bc49ed65940c12c29bab4035d5480c8ce`
- Temporary artifact cleanup: after verification, this isolated package directory
  was moved to the macOS Trash (recoverable); the build command below recreates
  it at the recorded output path.

Build command:

```text
mkdir -p /tmp/axterm-reimport-packaged.paP3Pu
bun run --cwd apps/desktop package:dir --output /tmp/axterm-reimport-packaged.paP3Pu
```

Suite command:

```text
env AXTERM_PACKAGED_APP=/tmp/axterm-reimport-packaged.paP3Pu/mac-arm64/Axterm.app \
  bun run test:packaged
```

Result: **21 passed, 10 skipped**, 31 tests discovered, one worker, 1.3 minutes.
The passed scenarios cover packaged third-party notices and About content,
Electron-ABI native modules, exactly four Electron locale families, the
independent FTP server, TRZSZ/ZMODEM/XMODEM over local PTYs, rendered migration
and configuration accessibility, sanitized Legacy Prototype custom-theme migration
(field-redacted preview, built-in-row skips, selected-theme remapping and
single-row persistence), IronRDP initialization, legacy WebDAV and Gist/Custom
conversion/recovery, updater-path isolation, checkout-independent startup,
Host Key confirmation, shell/workspace behavior, four-locale
restart-persistence, retired-language database migration and backup,
historical Axterm portable import, and prior-schema/Vault upgrade. The custom
theme test refreshes a stale preview only after the Runtime rejects its
settings precondition and verifies that the failed attempt created no partial
or duplicate user theme. A repeated packaged import is also previewed as two
unchanged entries, reveals no palette values, and disables the zero-item
commit; the database still contains exactly one mapped user theme.

The ten skipped scenarios are explicit platform/fixture limits: two Linux-only
tests, six Windows-only tests, one historical packaged-release upgrade with no
preserved old binary fixture, and one optional SSH-fixture journey. No skipped
scenario is counted as passed.

## Scope limits

This is a copied-outside-checkout unsigned macOS directory app, not a mounted
DMG installation, notarized release, Windows package, native Linux package,
public migration build, or signed binary-to-binary update. It supplies useful
current-source packaged evidence for P-04/P-05/P-06/P-07/P-08; source-rights,
human language/brand review, public migration approval and three-platform
distribution gates remain separate.
