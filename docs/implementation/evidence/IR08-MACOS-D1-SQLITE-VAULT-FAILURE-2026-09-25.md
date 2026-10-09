# IR-08 / W-08-01 / D1: macOS local SQLite and Vault migration boundary

Date: 2026-09-25. This record closes **Mac engineering cell D1 only** from
[the fixed execution board](../REMAINING_RELEASE_WORK.md). It does not close
W-08-01, IR-08, or the distinct W-08-02 real public-old-installer requirement.
The historical Axterm producer in the earlier evidence was rebuilt from its
source and was not a preserved publicly distributed installer.

| D1 condition | Evidence and exact limit                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Success      | The [historical-source package journey](IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23.md) created a real old local profile and upgraded it in a packaged Mac app. On the current unsigned Mac artifact, the existing `packaged prior-schema upgrade preserves data, legacy sync configuration and the local vault` journey passed 1/1; this is a representative synthetic prior-schema fixture, not a public old binary.                                           |
| Exception    | A new fixture creates a valid pre-34 SQLite profile with a Host and removed built-in theme ID, then an SQLite trigger aborts the theme migration's actual `UPDATE`. `ProductDatabase.open` fails with `MigrationError`; the packaged app is launched against a private `--user-data-dir`, and a second backup proves Host supervision retried after the first failed Runtime attempt. This is controlled fault injection, not a naturally damaged user profile. |
| Backup       | The automatically created `axterm.sqlite.pre-migration-34.bak` is byte-identical to the closed pre-upgrade database in both the source integration test and the packaged run. The backup remains unchanged after recovery.                                                                                                                                                                                                                                      |
| Rollback     | Failed migration leaves the live database byte-identical, does not add the `migration:34` marker and retains the old theme selection. After removing only the synthetic failure trigger, source Runtime and the **same packaged app** reopen the profile; migration completes, the Host remains, the old theme falls back to Axterm's default, and the original backup remains intact. No automatic DB reset occurs.                                            |
| Secret       | A synthetic SSH password exists only in the application-local Host Vault. Its reference survives in SQLite; the Vault file hashes remain unchanged across failure and packaged recovery, and the password decrypts after failure. The test does not claim a portable export backs up Vault secrets.                                                                                                                                                             |
| Scope        | These tests exercise one risky migration (34), one representative Host/Vault secret and one Mac artifact. Other migration versions, real user data diversity and Windows/Linux remain separate requirements.                                                                                                                                                                                                                                                    |

Commands and result:

```sh
bunx vitest run tests/integration/migration-failure-vault.test.ts
# 1/1 passed
AXTERM_PACKAGED_APP=/tmp/axterm-s5-final.Q0rUE4/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  -g 'packaged prior-schema upgrade preserves data, legacy sync configuration and the local vault'
# 1/1 passed
AXTERM_PACKAGED_APP=/tmp/axterm-s5-final.Q0rUE4/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged -g 'packaged macOS D1 leaves SQLite'
# 1/1 passed, including successful relaunch after the injected failure
```

The common unsigned Mac `app.asar` SHA-256 is
`08b3edb130dbf616801adfa676a4c97353fbd3507440f4422b6cd8f05b724651`.
The fixture, integration test and packaged test source hashes at this check
were respectively
`acf137b8e8ede5af3bb97e90efee69962c799710dea8b6a7f7882e701efe1901`,
`d9d1287bcec7dc0db7b75758a6d73a274295d45ab6775f65ebc6ba58b00e0eb1`
and `b3112514fb122d0573a767bc616854d31100b8769d52159777773d8158ba74d8`.

Next fixed cell: **D2**, bookmarks and user-created themes. W-08-01 remains
open through D2–D4. W-08-02 still requires a verifiable old public Axterm
installer and sanitized representative profile. This record closes **0 W
items** and changes **0 IR gates**.
