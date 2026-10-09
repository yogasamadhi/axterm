# IR-14 current ADR-021 source-clone rehearsal

Date: 2026-09-25  
Scope: local macOS arm64 engineering candidate, before this evidence note was added  
Command: `bun run candidate:check`

The command copied the current working tree into a disposable source-only snapshot,
created a new Git root commit, cloned it with `git clone --no-local`, installed with
`bun install --frozen-lockfile`, and ran the clone's full `bun run check`. It did not
write to the caller's checkout or create a remote repository.

| Observed item          | Result                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source-only snapshot   | 964 files; 24,519,454 bytes; tree SHA-256 `1f737a09cb37197d65d934c83928a72cc3997cf3a4d70400cbe73e4a551322a2`                                                                  |
| Disposable root commit | `855565df9e92f777f923a28b4c803c5384583de0`                                                                                                                                    |
| Clone                  | 964 tracked files; clean worktree; no `.gitmodules`, `vendor/legacy-prototype`, submodule, or checked-in generated OpenAPI file                                               |
| Source hygiene         | No forbidden entries, environment/secret candidates, transient artifacts, oversized files, or direct/lockfile dependency violations reported                                  |
| Clone checks           | 1,215 unit/integration tests passed, 38 skipped; 260 Contract operations, Level 1 architecture gate, source/license/build checks, and 21/21 visual/accessibility tests passed |

This supersedes the older migration-period clone as the **current technical
reproducibility** result for W-14-02. It does not prove that the current source
is the final public snapshot: historical references, tests, required data
identifiers and third-party notices remain to be dispositioned. The final-public
gate still depends on named provenance, rights, brand, locale and release-service
reviews. SSH and external-peer fixtures were not requested in this command;
Windows/Linux native installs, a signed Mac installer, public CI/downloads and
the owner's new repository were not exercised. No W or IR acceptance state is
changed by this rehearsal alone.

## Re-run after excluding two archived export fixtures

The two unused historical export fixtures were omitted by exact path after
their current bytes were matched to the private W-14-01 source archive. The
working-tree files and archive were not deleted. A second `bun run candidate:check`
from the updated source completed successfully: **963 tracked files**, source
tree SHA-256 `33c3d204ea116eef151c6aa996779faeb7e4d3a90cf7c69daf9c576cc7eae182`,
disposable root commit `003af50ae3673d9dd6ffe137d29152b18926fdeb`.
The new clone passed frozen installation, **1,216** unit/integration tests
(38 skipped), all regular architecture/Contract/source/license/build checks,
and **21/21** visual/accessibility tests. SSH/external peers and native
Windows/Linux installs were not requested. The source and rights limitations
above remain unchanged.

## Re-run after archiving two retired documents

The former migration-period boundary table and historical 1:1 design-token
map were omitted by exact path from the prepared source; the local worktree
and private W-14-01 evidence tar retain both. The upstream source audit was
**not** omitted because current source-rights regression assertions still
depend on it. The updated `bun run candidate:check` passed from a disposable
**961-file** root commit `17dbd3b9f1218941efbfa9c683a18b5b0ea1b407`, tree
SHA-256 `a1485e22dc5e70e5d05286df04e40169bd43b675f940942f49f045dceed7b5ec`.
The non-local clone completed frozen install, **1,216** unit/integration tests
(38 skipped), regular architecture/Contract/source/license/build checks and
**21/21** visual/accessibility journeys. It remains a local engineering
candidate, not the final reviewed public snapshot or platform release.

## Re-run after archiving four legacy migration records

Four superseded migration-period evidence notes, already present in the
private W-14-01 evidence tar, were omitted by exact path. Their current
documentation backlinks now point to controlled historical evidence rather
than to absent public files; the local originals were not deleted. The next
`bun run candidate:check` passed with **957 tracked files**, source tree SHA-256
`ea0d8940e6375e6265b38291be023ad9122aa68425da2cf8c8af62e9390995d8`
and disposable root commit `48dc615c911ca19ef424328b51ac55132fa5c05e`.
The non-local clone completed frozen install, **1,216** unit/integration tests
(38 skipped), architecture/Contract/source/license/build gates and **21/21**
visual/accessibility journeys. This remains a local engineering rehearsal;
no final source-rights, service, signing or native Windows/Linux gate is
accepted by it.
