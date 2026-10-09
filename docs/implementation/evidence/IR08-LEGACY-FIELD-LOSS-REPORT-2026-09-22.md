# IR-08 legacy-import field-loss reporting evidence

Date: 2026-09-22  
Status: implementation evidence; IR-08 remains **In progress** and IR-09 remains **Open**

## Boundary closed by this change

The migration-period legacy data importer previously returned fixed
`mappedFields` and `omittedFields` lists for bookmark groups, Profiles and
Quick Commands. Those lists could omit unknown source properties, nested
protocol properties and the rejected part of a partially accepted array. They
also did not prove that the preview used the same bounds as the eventual
Quick Command write.

The preview now derives those three entry reports from the same conversion
rules used by commit:

- group reports cover the actual accepted scalar/relationship fields and every
  present unsupported property;
- Profile reports use nested paths such as `telnet.username` and
  `telnet.password`, while unsupported nested properties such as `telnet.port`
  remain visible;
- Quick Command reports identify unused legacy `command`, rejected steps,
  step properties, partially accepted tags and invalid counters while applying
  the target limits of 32 steps, 32 tags and 60 characters per tag and
  top-level name;
- a partially converted field may deliberately appear in both lists, making
  partial loss explicit rather than misreporting the whole field as mapped;
- field names are bounded and control characters are replaced before they
  reach the preview. Secret values are never included.

The corresponding commit regression proves that only the nested Telnet secret
enters the application-local Credential Vault, an orphan passphrase does not,
and the stored Quick Command contains only the accepted step and tag with the
invalid counter normalized to zero.

## Evidence

- `packages/runtime/src/application/legacy-prototype-data-service.test.ts` exercises
  actual preview and commit against group, Profile and Quick Command records.
- `tests/fixtures/migration/legacy-legacy-prototype-data-v1.json` adds unsupported
  `level`, `expanded`, `forwardAgent` and `groupId` properties to the
  version-controlled fixture.
- `tests/e2e/desktop.spec.ts` drives the native File Grant migration UI and
  requires the visible Chinese loss rows `未映射：level, expanded`,
  `未映射：forwardAgent` and `未映射：groupId`.
- Focused verification passed eight Application tests and the one production
  Electron migration journey on 2026-09-22. Typecheck and production build
  also passed.

The complete current-worktree `bun run check` then passed 217 test files with
five skipped files (961 tests with 33 skips), the 368-module / 1,313-dependency
architecture gate, 267 Contract operations, all source/release hygiene checks,
production build/layout, and five visual plus two accessibility Electron
journeys. A fresh `bun run candidate:check` prepared a 753-file / 15,763,557-byte
source snapshot with tree SHA-256
`8342f5b137bbb8d3a89de044f37a200b0f73c22bdef857b2e29f47c76354ef92`.
Temporary root commit `623416e58a98e377577d7419ea3112b3c6db2f62` and a distinct
`git clone --no-local` tracked the same 753 files; frozen install rebuilt
macOS arm64 `node-pty`, and the clone passed that same complete gate. Every
snapshot category was empty and the temporary roots were removed.

## Limits and remaining exit gates

The version-controlled fixture is synthetic current test data. It is **not**
an export captured from an older public Axterm or Legacy Prototype binary and does not
prove every historical format variant. No public stable migration build or
migration-window date has been recorded, the old compatibility entry points
remain intentionally present, and Windows/native-Linux installed-app migration
evidence is still missing. This evidence therefore narrows field-loss risk but
does not accept IR-08 or authorize IR-09 removal.
