# IR-05 packaged locale-migration evidence — 2026-09-24

Status: current-worktree macOS arm64 engineering evidence; IR-05 remains
**In progress**.

## Artifact

- Product version: `0.10.0`
- Platform: macOS arm64, packaged with Electron `44.3.0` / electron-builder
  `26.16.1`
- Package: unsigned directory app, produced in the isolated output directory
  `/tmp/axterm-commercial-p04.dF8mV8/package/mac-arm64/Axterm.app`
- `Contents/Resources/app.asar` SHA-256:
  `cd72a3b9d1f5e21250a2099ffa40347995764c824f4094447cdb8c4551f13add`
- Signing/notarization: none; electron-builder reported code signing skipped.

## Reproduction and results

The current source `bun run check` passed before packaging. The package was
built without using or overwriting the repository's existing `release/` output:

```text
bun run --cwd apps/desktop package:dir --output /tmp/axterm-commercial-p04.dF8mV8/package
```

The following packaged Playwright command passed **2/2**:

```text
env AXTERM_PACKAGED_APP=/tmp/axterm-commercial-p04.dF8mV8/package/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged --grep "packaged migration and configuration surfaces pass rendered accessibility scans|packaged upgrade migrates a retired language to English and preserves its database backup"
```

1. `packaged migration and configuration surfaces pass rendered accessibility
scans`: the packaged app previews a sanitized legacy configuration containing
   `config.language: "fr"`. The Chinese UI explicitly states that the retired
   language will migrate to English, the preview passes axe, and the test cancels
   rather than committing the synthetic import.
2. `packaged upgrade migrates a retired language to English and preserves its
database backup`: the test seeds a database with persisted `de` and migration
   38 unapplied, then starts the current package. It verifies the rendered
   language is English, exactly four languages are selectable, SQLite stores
   `en`, the migration marker exists, and one pre-migration backup still stores
   `de`.

## Scope limits

These tests cover a copied, unsigned local macOS package and synthetic fixtures.
They do not establish native Windows/Linux package behavior, an upgrade from a
preserved publicly distributed old installer, human language/rights review,
design approval, a public migration release or its migration-window date.
The evidence therefore does not accept IR-05 or IR-08.
