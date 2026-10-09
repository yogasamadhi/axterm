# Local clean-root Mac engineering candidate — 2026-09-26

Scope: a source-only local Git root and an unsigned, unnotarized macOS arm64
engineering candidate. This is not public commercial-release approval.

## Changes

- The previous repository and frozen candidate remain unchanged as controlled
  backups. The new source root has no inherited `.git`, submodule, remote, or
  reference assets.
- ADR-023 starts Desktop data in `data-v2/` and credentials in `vault-v2/`.
  Earlier database profiles are rejected by a read-only preflight before any
  migration; the previous directories are not read or rewritten by Desktop.
  Manual Axterm configuration import remains available, without passwords.
- Removed retired import tables and unsupported sync formats from fresh
  database migrations. An optional non-runtime translated package README was
  excluded from the Mac ASAR; the component's license and source notices remain
  present and accessible.
- Added a case-insensitive ASCII/UTF-16 retired-name guard for source and
  installed-app paths and bytes. The DMG acceptance script runs the app guard.

## Verification

| Check                                                        | Result                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun install --frozen-lockfile`                              | Passed                                                                                                                                           |
| `bun run check`                                              | Passed: 1,213 unit/integration tests and 21 visual/accessibility tests, plus architecture, contracts, licenses, source and build gates           |
| Source, generated bundle, app, DMG and ZIP retired-name scan | Zero case-insensitive matches in paths and bytes                                                                                                 |
| `bun run test:dmg:macos`                                     | Passed: DMG verified, mounted, copied independently; 36 packaged tests passed, 19 skipped by platform/fixture conditions                         |
| `bun run test:ssh:packaged`                                  | Passed: controlled integration, Desktop SSH/SFTP journey, and packaged SSH journey                                                               |
| Previous data isolation                                      | Packaged test confirms old database and Vault bytes unchanged and no remote request; direct Runtime preflight rejects old schema without writing |

Exact hashes for the final package invocation are written to the local,
ignored `release/LOCAL_ACCEPTANCE.md` after that invocation and its DMG
acceptance run. Do not reuse a previous package run's hashes: the packager did
not produce byte-identical DMG/ZIP/ASAR across two local invocations, even
though the source content and name guard stayed unchanged. This is a local
engineering limitation, not a reproducible-build claim.

## Limits

The result is literal/source-history isolation, not independent-authorship or
distribution-rights clearance. Retained copyright notices and third-party
components need qualified review on the actual release bytes. No Developer ID
signature, notarization, public download, or Windows/Linux native test was
performed. Prior optional migration and crash-recovery fixture cells were
skipped where their separate prerequisites were absent; no skip is recorded as
a pass. The four formal conditions in the minimum release document remain
unchecked.

Historical documentation in this source candidate uses explicitly redacted
placeholder identifiers; its old package names, paths and URLs must not be
treated as factual provenance. The unchanged prior repository retains the
original records for controlled review. Frozen-install `node_modules` is
generated, untracked and excluded from the source/artifact zero-name scope;
third-party publisher README and development metadata within that local cache
can still mention the retired name. Those files are not included in the Mac
artifact, and a fresh dependency installation will recreate the cache.
