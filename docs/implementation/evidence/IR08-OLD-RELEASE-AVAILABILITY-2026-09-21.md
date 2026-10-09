# IR-08 old-release fixture availability audit

Date: 2026-09-21  
State: **no qualifying older public artifact located; IR-08 remains In progress**

IR-08 requires migration evidence from actual older Axterm data and installed
artifacts. A synthetic JSON fixture or a current binary with its database schema
manually rolled back is useful regression coverage, but it is not evidence of an
older published binary or its complete user-data behavior.

## Read-only availability check

The following checks were made before any old repository/history deletion:

| Source                                                          | Command or evidence                                                         | Result                                                                                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Current Git remote tags                                         | `git ls-remote --tags origin`                                               | No tag lines returned.                                                                                                              |
| GitHub Releases                                                 | `GET https://api.github.com/repos/yogasamadhi/axterm/releases?per_page=100` | `[]` (no release records).                                                                                                          |
| Local reachable history                                         | `git log --all --format='%H %ad %s' --date=short`                           | Earliest reachable commit is `657b3cc1552cd3b0dc3b0f73df1c1a4a5a8a6a6e`, dated 2026-09-14 and titled `Initial open-source release`. |
| Product manifests at earliest, intermediate and current commits | `git show <revision>:package.json`                                          | All inspected commits report `0.10.0`.                                                                                              |
| Current local release directory                                 | `release/` inventory                                                        | Only `0.10.0` filenames are present; it is not an older release.                                                                    |
| Version-controlled migration fixtures                           | `tests/fixtures/migration/`                                                 | Only `legacy-legacy-prototype-data-v1.json` is present; it is deliberately synthetic legacy-data coverage.                          |

The remote at the time of the audit was
`https://github.com/yogasamadhi/axterm.git`. This record reports availability,
not a claim that a previous private build never existed.

## Required preservation action before repository replacement

The owner must obtain and preserve one or more genuine earlier Axterm release
artifacts, along with representative **sanitized** data created by those builds:

1. Original installer/directory artifact, version, platform/architecture and
   SHA-256.
2. A no-secret SQLite profile produced by that build, plus a separate
   application-local Vault fixture whose bytes and expected credential prompts
   can be checked without exposing secret values.
3. Old portable data files, both plaintext and encrypted sync examples, an
   `legacy-prototype://` link and a legacy `--batch-op` workflow; each needs a version,
   source and SHA-256.
4. A reproducible test plan that installs the old artifact, upgrades it to the
   migration build and verifies successful use, expected omissions, rollback
   behavior, old remote-object preservation and secret re-entry.

Store any raw artifacts and private data outside the new public repository.
Commit only synthetic/minimized fixtures, redacted manifests and hashes after
rights and privacy review. Do not edit a current `0.10.0` database or rename an
export and call it an old-release fixture.

Until that material exists, no code change may mark IR-08 accepted, start the
public migration window, or justify removal of Legacy Prototype compatibility paths.

The current macOS packaged regression does construct a prior local schema and
cross migrations 32, 34, 36 and 37. It verifies preservation of a password
Host, command, migrated built-in theme, a legacy WebDAV profile's remote
location/categories/schedule and three application-local Vault secrets; the
rebuilt sync profile remains explicitly `legacy-legacy-prototype-v1`. This narrows a
local data-loss regression risk, but because the fixture is created with the
current test tooling, it remains **not evidence of an older published binary**
and does not satisfy the preservation action above.

## 2026-09-23 historical-source follow-up

The earliest reachable commit can nevertheless provide stronger engineering
evidence than a database constructed by current repositories. A detached
worktree at exact commit `657b3cc1552cd3b0dc3b0f73df1c1a4a5a8a6a6e`
completed a frozen install and built an unsigned macOS arm64 directory app.
That historical package created a password Host/Bookmark, Quick Command and
application-local Vault through its own real UI; the current package then
upgraded the same user-data directory from migration 33 through migration 38.
The records and credential remained usable, every Vault file was byte-identical,
and the automatic pre-migration-34 rollback database had the exact pre-upgrade
SHA-256.

See
[IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23](IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23.md)
for the artifact and database hashes. This does not change the audit's central
finding: the package was rebuilt in 2026 from historical source, both manifests
say `0.10.0`, and no archived signed/public installer or earlier GitHub Release
was located. The remaining preservation and cross-platform requirements still
apply, so IR-08 remains **In progress**.

## 2026-09-23 fixture preservation update

The earlier fixture inventory above was accurate on 2026-09-21. It is now
superseded for portable-file coverage by
`tests/fixtures/migration/historical-axterm-portable-v2-657b3cc.json`: the
exact 11,477-byte JSON produced by the rebuilt historical package's real
export action, SHA-256
`250a533d009e2b62ccc3723425584f9fad90efe9849b60ea41e2dcb583f3c0dc`.
Its synthetic test values and absence of the three fixture secrets were
checked; it is a **provisional migration-period source fixture**, not a
preserved public installer or a rights/privacy sign-off for final publication.
The owner still needs the original distributed artifacts and the separate
review required above. See the
[historical package record](IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23.md).
