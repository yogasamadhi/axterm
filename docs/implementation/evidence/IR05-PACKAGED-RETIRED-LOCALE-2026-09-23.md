# IR-05 packaged retired-locale migration evidence — 2026-09-23

State: **unsigned local macOS directory-package regression; IR-05 remains In progress**

## Artifact identity

The current worktree was packaged into a fresh temporary output directory with
`node scripts/package-desktop.mjs --dir --output
/tmp/axterm-p04-retired-language.21Aaju`. The tested artifact was Axterm
`0.10.0`, macOS arm64, Electron `44.3.0`, electron-builder `26.16.1`, on
Darwin `27.0.0`. Its packaged `app.asar` was 101,669,992 bytes with SHA-256
`4ab964a4f7166446778c792130e3d3413fb9db04c0fbf6b1c8635535e15dbcd7`.

The package and seeded user data were temporary and removed after the test.
This was an ad-hoc unsigned, unnotarized directory package, not a published
release or mounted/installed DMG.

## Check performed

The focused packaged test passed **1/1**:

```sh
AXTERM_PACKAGED_APP=/tmp/axterm-p04-retired-language.21Aaju/mac-arm64/Axterm.app \
  ./node_modules/.bin/playwright test --project=packaged \
  --grep 'packaged upgrade migrates a retired language to English and preserves its database backup'
```

The test seeds a current Axterm SQLite database with the retired language ID
`de` and removes migration marker 38, launches the packaged app, and verifies
the ready renderer and Settings selector use English with exactly four
available languages. After shutdown it verifies the database stores `en`, the
migration marker was recorded, and the single pre-migration backup still
stores `de`.

## Limits

This proves the migration path in a locally seeded database using the current
macOS arm64 package. It does not prove a real historical release upgrade,
Windows or native-Linux behavior, full language/rights review, or migration
release readiness. IR-05 remains **In progress**.
