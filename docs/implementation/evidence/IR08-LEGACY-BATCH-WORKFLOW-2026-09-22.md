# IR-08 legacy command-line workflow migration evidence

Date: 2026-09-22  
Status: implementation evidence; IR-08 remains **In progress** and IR-09 remains **Open**

## Boundary closed by this change

During the migration window, `--batch-op` accepts a narrowly bounded legacy
workflow array in addition to Axterm's native batch-operation document. The
translator already discarded inline credentials, but the user previously saw
only a generic deprecation notice. Unsupported connection, parameter and
command properties could therefore be omitted without a field-level report.

The parser now returns a Renderer-memory-only result containing:

- the validated Axterm batch-operation request;
- an exact source-format marker; and
- up to 64 unique unsupported or shadowed source paths, each limited to 80
  Unicode code points with control and format characters replaced.

The report contains field names only. It never contains source values. Inline
passwords remain unmapped and the migration notice identifies
`workflow[0].params.password` without displaying its value. The first command's
`prevDelay` is also reported when present because no preceding Axterm command
can represent it; later `prevDelay` values combine with the preceding
`afterDelay` under the existing 65,535 ms bound.

The source second-instance regression exposed a separate queue race. A
`deep-link.available` event arriving while the preceding Renderer drain was
active could return without arranging another drain, leaving the newly queued
intent unclaimed. The Renderer now latches that request and replays the drain
after the current pass finishes. If a protocol editor is open, normal editor
completion remains the serialization boundary.

## Shared synthetic fixture and evidence

`tests/fixtures/migration/synthetic-legacy-legacy-prototype-batch-operation-v1.json`
is the single version-controlled input used by the parser, source Electron and
packaged macOS journey. It contains:

- one saved-SSH connection step;
- two command steps whose mapped delays are 50 ms and 0 ms;
- representative unsupported `retry` and `expect` fields; and
- the literal test-only inline secret
  `SYNTHETIC_LEGACY_WORKFLOW_SECRET`.

Verification completed on 2026-09-22:

- `bunx vitest run tests/unit/command-line-batch-operation.test.ts` passed four
  tests. It verifies the exact mapped commands/delays and field paths, rejects
  ungranted transfer steps, bounds/sanitizes hostile field names and proves
  omitted values are not returned.
- The focused source F-08 Electron journey passed with both legacy notices
  visible, non-overlapping and viewport-bounded. It requires the password and
  command omission paths and rejects the secret from the DOM notice.
- The source G-12 second-instance journey passed three consecutive runs after
  the drain-latch fix. It imports the native request followed by a legacy
  request and confirms the legacy notice, operation and no browser-storage
  secret.
- A fresh unsigned `package:dir` macOS arm64 application passed the focused
  packaged migration journey. It consumes the same fixture through real Main
  path grant and second-instance ingress, creates the translated operation and
  two named step results, shows the field report, and finds the secret in
  neither browser storage nor SQLite. The same journey also imports portable
  settings and verifies the imported workspace survives restart. A race found
  during repetition is closed by suspending current-session layout persistence
  from import start through the required restart; rejected imports release the
  suspension and uncertain commit responses remain protected.
- The packaged migration journey passed three consecutive runs against the
  tested 101,540,201-byte `app.asar` with SHA-256
  `def175cc7f9995102b6e4536be2379e8ceedab07f0b8ac2f220c44bb4e34c5d4`.
- Typecheck, production build and directory packaging passed before the
  focused packaged run.
- The complete current-worktree `bun run check` passed 217 test files with
  five skipped files (963 tests with 33 skips), 368 modules / 1,313
  dependencies, 267 Contract operations, the four-catalog/2,544-key
  localization gate, production layout, five visual journeys and two
  accessibility journeys.
- A fresh `bun run candidate:check` prepared 755 files / 15,797,670 bytes with
  source-tree SHA-256
  `a6e0f1062276ea489943236952d09454df0df24f4c984cd29c6a1f64c64acac0`.
  Temporary root commit `cda5ad67740d3dfc0b82cc0415fd4401b07d490e`
  and a distinct `git clone --no-local` tracked those same 755 files; frozen
  install rebuilt macOS arm64 `node-pty`, and the clone passed the same full
  gate. Every snapshot category was empty and the temporary roots were removed.

Batch execution history intentionally persists operation/target/step result
metadata, not raw command text. The unit and source conversion assertions prove
the command and delay mapping; the packaged database assertion uses the actual
persisted operation shape instead of claiming that command bodies are stored.

## Limits and remaining exit gates

This fixture was authored for the current regression suite. It is **not** an
export captured from an older public Legacy Prototype or Axterm release and does not
prove every historic workflow variant. The packaged artifact is an unsigned
macOS arm64 directory app, not an installed, signed or notarized release.
Windows x64 and native Linux x64 installed-app evidence remains missing.

No public stable migration release/date/window has been recorded. The legacy
translator remains intentionally available, and this evidence does not
authorize its removal. A genuine old-version artifact, public migration
milestones and the remaining platform evidence are still required before IR-08
can be accepted or IR-09 can move out of Open.
