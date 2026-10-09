# IR-12 independent source-copy check — 2026-09-21

Status: passed source-copy evidence; **not** a new-repository or release sign-off

## Scope

This check exercises the current working-tree snapshot without Git metadata, the
Legacy Prototype submodule, installed dependencies, previous build output, release
artifacts, test results or `.env` files. It is intended to prove that the
current code and frozen dependency graph can build and run their normal gates
without those excluded source-tree artifacts.

It does not claim that the source was committed, that a new repository exists,
or that a platform installer has passed its release evidence.

## Method

1. Created `/tmp/axterm-independent-20260921.O9YS04` with `mktemp -d`.
2. Copied the current tree with `rsync -a`, excluding `.git/`, `.gitmodules`,
   `vendor/`, `node_modules/`, `out/`, `release/`, `test-results/`, `.env` and
   `.env.*`.
3. Asserted that `.git`, `.gitmodules`, `vendor/legacy-prototype`, `node_modules` and
   `out` did not exist before dependency installation.
4. Ran `bun install --frozen-lockfile`. The postinstall native preparation
   rebuilt `node-pty` on macOS arm64 from the frozen graph.
5. Ran `bun run check` in the isolated copy.

## Result

The isolated copy completed successfully:

- 855 unit tests passed; one test was intentionally skipped.
- The Level 1 architecture gate checked 365 modules and 1,301 dependencies.
- The OpenAPI/Contract drift gate passed with 267 operations.
- Component index, packaged-license text, SPDX SBOM, 15 navigation catalogs,
  legacy-key scope and Renderer localization checks passed.
- The production Desktop/Runtime build and package-layout check passed.
- The Axterm visual baseline (including the guarded sync-migration state) and
  two accessibility/reduced-motion Electron journeys passed.

## Reproducible snapshot-audit rerun

After the initial record, the repository gained
`bun run audit:independent-snapshot -- --snapshot <path>`. It is a read-only
Stage-5 preparation tool with unit fixtures for both a clean source tree and
the prohibited cases. It rejects old Git/submodule/reference-material paths,
installed/build/test output, non-example `.env` files, symbolic links and
direct `@legacy-prototype/*`/old generated-package markers in workspace manifests or
the frozen Bun lock. It deliberately does not treat migration-period product
references or historical documentation as a pass/fail proxy for IR-09.

On 2026-09-21 it was run before installation against a second fresh copy at
`/tmp/axterm-independent-snapshot.dUl9F1`, prepared with the exclusion set
above. The audit passed with all violation lists empty:

- 671 source files and 22,699,607 source bytes;
- source-tree SHA-256 `a73550441d5d5903a0ae094c7e3fbbdaae1b3173479f5c2aa3a114bcffcc2463`;
- no `.git`, `.gitmodules`, `vendor/legacy-prototype`, installed/build/test output,
  environment files, symbolic links or old direct dependency markers.

`bun install --frozen-lockfile` then rebuilt `node-pty` from the frozen graph,
and `bun run check` passed in that copy: 859 tests passed and one skipped across
193 files; the Level 1 architecture gate checked 365 modules / 1,301
dependencies; Contract drift checked 267 operations; component/license/SBOM,
15-language/localization, production build/layout and all three default
visual/accessibility journeys passed. The source tree deliberately failed an
earlier copy when a newly edited fixture had not been formatted; the clean rerun
above was made only after the source lint/format check passed.

After the migration-period legacy theme-file labels and packaged verification
were added, a third fresh copy at
`/tmp/axterm-independent-snapshot.baLXYt` used the same exclusion set. The
audit passed before dependency installation with all violation lists empty:

- 676 source files and 26,791,321 source bytes;
- source-tree SHA-256 `14b63f19af26ec3b6d1d2edc6187dfc2414d230c4c6d82483e6e6ed1f579601b`;
- no `.git`, `.gitmodules`, `vendor/legacy-prototype`, installed/build/test output,
  environment files, symbolic links or retired direct dependency markers.

Its `bun install --frozen-lockfile` rebuilt `node-pty` on macOS arm64 from the
copy's frozen graph. `bun run check` then passed 862 tests with one intentional
skip across 194 passing files; it checked 365 modules / 1,301 dependencies and
267 Contract operations, then passed component/license/SBOM, 15-language and
Renderer-localization gates, the production build/layout check and all three
default visual/accessibility Electron journeys. This verifies the current
source-copy state after the P-05 change; it carries exactly the same limits as
the earlier copies and is not an independent release or new-repository sign-off.

After adding the first-party asset inventory gate, a fourth fresh copy at
`/tmp/axterm-independent-snapshot.HKoiWW` again used the same exclusion set.
Before installation, the audit passed with all violation lists empty:

- 679 source files and 26,804,151 source bytes;
- source-tree SHA-256 `5bbf30505d35c3ae9eb4fee8a2918ec1cdc98e8b81c3bca827b65e3f3868ac2c`;
- no `.git`, `.gitmodules`, `vendor/legacy-prototype`, installed/build/test output,
  environment files, symbolic links or retired direct dependency markers.

Frozen installation rebuilt `node-pty` on macOS arm64 from that isolated
graph. Its complete check passed 864 tests with one intentional skip across
195 passing files; it checked 365 modules / 1,301 dependencies and 267 Contract
operations, then passed component/license/SBOM/**product-asset** inventories,
15-language and Renderer-localization gates, production build/layout and all
three default visual/accessibility Electron journeys. This proves the current
source-copy gate includes the asset-drift control; it is still neither a new
Git repository nor a release, rights or three-platform acceptance.

The repository now has a portable `bun run snapshot:check` pre-install gate.
It creates a temporary source-only copy, excluding Git metadata, `.gitmodules`,
the entire `vendor/` tree, installed modules, build/release/test output,
historical parity material and non-example `.env*` files, then invokes the same
snapshot auditor. GitHub Actions runs that check on macOS, Ubuntu and Windows
before its frozen install. The workflow's normal checkout/install/full check
continues to verify the actual committed source on each platform; the portable
copy check makes the source-snapshot exclusion policy executable on every run.
It does not run a second installation in the temporary copy and therefore does
not replace the full manual isolated-copy evidence above or IR-12's final
new-repository gate.

The new portable preparation path was also exercised as a full isolated-copy
check on macOS arm64. It first produced a passing audited source copy through
`prepareIndependentSnapshot()`, then ran `bun install --frozen-lockfile` and
`bun run check` inside that copy. The isolated dependency installation rebuilt
`node-pty`; the complete gate passed 865 tests with one intentional skip across
196 passing files, 365 modules / 1,301 dependencies, 267 Contract operations,
component/license/SBOM/product-asset inventories, localization, production
build/layout and all three default visual/accessibility Electron journeys. The
copy was created from an uncommitted working tree and was not a signed release,
new Git repository, CI run or Windows/Linux installation; those limits remain
unchanged.

## Limits and required next evidence

The copy was made from a dirty, uncommitted working tree, so it is not a Git
checkout and cannot prove a future new repository's initial commit or CI.
`bun run check` intentionally runs the default visual/accessibility Electron
journeys, not the complete desktop or packaged suites. It also does not supply
the required Windows/Linux package, installed-upgrade, signing/notarization,
updater, live-provider, source-rights or migration-window evidence. Keep
IR-12 **In progress**, IR-13 **Open** and IR-14 **Open** until those scoped
gates are independently satisfied.
