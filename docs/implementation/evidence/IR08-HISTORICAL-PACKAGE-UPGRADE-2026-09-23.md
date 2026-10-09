# IR-08 historical-source package upgrade evidence

Date: 2026-09-23  
Status: local macOS arm64 engineering evidence; IR-08 remains **In progress** and
IR-09 remains **Open**

## Evidence boundary

The reachable repository history contains commit
`657b3cc1552cd3b0dc3b0f73df1c1a4a5a8a6a6e`, dated
2026-09-14T16:36:55+08:00 and titled `Initial open-source release`. Its product
version is `0.10.0` and its database ends at migration 33. A detached managed
worktree at that exact commit completed `bun install --frozen-lockfile`
(615 packages) and `bun run package:dir`. The resulting unsigned macOS arm64
directory application was then used as the **producer** of the upgrade test's
user data; the current test code did not construct or reverse-edit its database.

This is stronger than the current-schema rollback fixture, but it is still a
package rebuilt on 2026-09-23 from historical source. It is not an archived,
signed binary proven to have been downloaded by a user, and the old and current
manifests both report `0.10.0`.

| Initial-run artifact                  | Size        | SHA-256                                                            |
| ------------------------------------- | ----------- | ------------------------------------------------------------------ |
| Historical commit 657b3cc `app.asar`  | 97,180,726  | `5dc53bcc5997016a33e8fa41d588462a7b441cde759b181c95e4df6f91c916b0` |
| Current migration build `app.asar`    | 101,554,888 | `942c1bfa1bf049841db90c14bf8362c7fcccc9645e6af30926073739219d8145` |
| Current post-upgrade data screenshot  | 147,389     | `6a419dafae8e16e4a68493ad13be307edee1ee24a550cb23227317fed6e848bc` |
| Current migrated-theme screenshot     | 179,632     | `9a475203d7ed67af660de2995f0028952f2f44804ab2ffbd5c8b0b08e299484b` |
| Current legacy-sync screenshot        | 259,118     | `bf5be100d161f469d3887a477a89de2f9eb994f9ee6cc46f334ed9bb2fa39a4d` |
| Current encrypted-recovery screenshot | 171,316     | `bc6d2df61b46a77c1cb97b9edf2122026f98c2794fb40d99467f940c4bad8851` |
| Current plaintext-recovery screenshot | 171,281     | `fe628bea9ace9acc8aae5e9fcfdce05bdaa50822b4d49f95e287a64859e15e6b` |
| Machine-readable local evidence JSON  | 2,664       | `06559969b3c995dbc023b3656e0444c0447efee0f52c8444a13d177040e6e218` |

The screenshots and JSON were written to
`test-results/packaged-evidence/historical-package-upgrade.png`,
`test-results/packaged-evidence/historical-package-theme-migration.png`,
`test-results/packaged-evidence/historical-package-sync-profile.png`,
`test-results/packaged-evidence/historical-package-sync-recovery.png`,
`test-results/packaged-evidence/historical-package-plaintext-sync-recovery.png`
and
`test-results/packaged-evidence/historical-package-upgrade.json`; they are
local run output, not source inputs.
The later portable-file run below refreshed those ignored output paths; this
table identifies the first run, not the bytes currently at those paths.

## Executed transition

The conditional packaged Playwright journey
`current packaged app upgrades data produced by a historical packaged release`
performed the following sequence:

```bash
AXTERM_PREVIOUS_PACKAGED_APP=/absolute/path/to/historical/Axterm.app \
AXTERM_PACKAGED_APP=/absolute/path/to/current/Axterm.app \
bun x playwright test tests/e2e/packaged.spec.ts \
  --project=packaged --grep 'historical packaged release'
```

1. Copied both `.app` directories outside their checkouts and launched them with
   a restricted `/usr/bin:/bin` `PATH` and one fresh shared `user-data` path.
2. Drove the historical package's real UI to create a password-backed SSH Host
   and Bookmark plus a one-step Quick Command. It also selected the removed
   upstream built-in `3024 Day` (`…0003`) as the global terminal theme. Through
   Settings it also created a legacy WebDAV profile with access and sync-
   encryption passwords. All three synthetic secrets were saved through that
   package's application-local Credential Vault. The old package then used its
   production upload action against a controlled loopback WebDAV service and
   created both `/legacy-prototype/historical-desktop.json` as an encrypted object and
   `/legacy-prototype/historical-desktop-plaintext.json` as an unencrypted object. It
   restored the saved profile to the encrypted target before shutdown.
3. Closed the historical package and opened its SQLite database read-only. The
   test required migration 33, absence of migration 34, the Host's real
   `credentialRef`, the Quick Command, the exact `3024 Day` theme ID and the
   WebDAV profile's endpoint, remote name, category set and two credential
   references. It also proved all three plaintext secrets were absent from
   SQLite.
4. Inspected both remote documents before launching current code. The encrypted
   object was an 8,869-byte AES-256-GCM + scrypt envelope with SHA-256
   `a43d5bc9dbcbde23c66123f3a066e75483348f5a6ca278d0006e0cdcc0347a58`;
   neither the Host/Quick Command names nor any SSH, WebDAV access or sync-
   encryption password appeared in its bytes. The plaintext object was a
   6,568-byte version-1 envelope with SHA-256
   `1a7ef3993f6a8a0764a18e3a27930bae48e3cf1d8fc764b724b1da1dcb136008`.
   It contained the expected Quick Command in its document but none of the
   three secrets.
5. Launched the current package against exactly the same user-data path. The
   current UI rendered both the historical Host/Bookmark and Quick Command,
   and showed the four-entry independent catalog with the mint Axterm `Default`
   selected. Its active terminal background was `#0d1d1a`. Settings rendered
   the historical WebDAV profile under the explicitly selected legacy format,
   including both saved-Vault placeholders without exposing either secret.
6. Closed the current package and required migrations 34–38, the same Host
   credential reference and the same Quick Command. The global terminal theme
   ID was migrated from removed `…0003` to stable Axterm `Default` (`…0001`).
   The old profile acquired migration 36/37's immutable
   `legacy-legacy-prototype-v1` format while retaining its endpoint, remote name,
   username and both credential references.
7. Opened `axterm.sqlite.pre-migration-34.bak` as a rollback database. It still
   had migration 33, did not have migration 34, and retained the Host,
   credential reference, command, original `…0003` theme selection and the
   complete pre-format WebDAV profile.
8. Compared every Vault file before and after upgrade and then opened that Vault
   with the current implementation. `master.key`, `metadata.json` and the
   three credential ciphertexts were byte-identical, and the expected Host,
   WebDAV access and sync-encryption passwords all decrypted successfully.
9. Closed the current package, deleted `Historical package command` from the
   migrated database and changed the local appearance setting. On relaunch,
   the current package downloaded and decrypted the old package's remote
   document, presented the existing legacy preview and required an explicit
   `Confirm apply` commit. That reviewed commit restored both the deleted Quick
   Command and the changed appearance setting. The remote bytes remained
   identical: the server observed three authenticated reads and only the one
   historical-package write, with no recovery-side write.
10. Copied the closed upgraded user-data directory, changed the copied profile
    through the current Settings UI to the old package's plaintext remote
    target and again deleted the Quick Command and changed the appearance
    setting. A second current-package launch presented the same preview and
    explicit-commit boundary and restored both values. The plaintext object was
    also byte-identical after three reads and its single historical-package
    write.

The focused invocation passed one of one journeys in 10.9 seconds. Its primary
encrypted-profile database hashes were:

| State                     | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| Before current app        | `bed4a296707d50eb18abc52c71c2d8bb3c62e3cfb9454f97387117259954da3b` |
| Pre-migration-34 rollback | `bed4a296707d50eb18abc52c71c2d8bb3c62e3cfb9454f97387117259954da3b` |
| After migration 38        | `b7adb1e452576ef76fdfb7116636290d1e82da90d0a9677d0313c101ab199e4f` |

The identical first two digests prove that this run's automatic rollback copy
preserved the exact closed database bytes presented to the current package.

## Remaining gap

This run closes concrete macOS data-producer, theme-catalog, saved-sync-profile
and controlled encrypted/plaintext remote-recovery gaps: the old schema,
removed built-in selection, pre-format WebDAV row, Vault bytes and both remote
documents now come from an independently built historical Axterm package, not
from current repositories or manual `ALTER TABLE` rollback. It does **not**
prove:

- a version-number transition, because both manifests say `0.10.0`;
- an original archived or signed public installer;
- Windows x64 or native Linux x64 installed-package upgrade;
- a live cloud/provider account or every historical document/data shape;
- a user-approved public migration date/window; or
- final removal of migration-period compatibility code.

The owner still needs to preserve any genuinely distributed historical
installer and sanitized representative user artifacts before deleting the old
repository history. IR-08 therefore remains **In progress**, and this evidence
does not authorize IR-09 removal.

## 2026-09-23 actual historical-package portable-file handoff

A later run expanded the historical-source producer to a bookmark group,
two SSH Hosts/Bookmarks (one direct-password, one linked to a connection
Profile), one username-only connection Profile and the one-step Quick
Command. The focused journey passed; the subsequent full macOS package run
passed 18 applicable journeys with nine conditional skips in 1.3 minutes.
It used the same exact historical-source `Axterm.app` (`app.asar` SHA-256
`5dc53bcc5997016a33e8fa41d588462a7b441cde759b181c95e4df6f91c916b0`)
and a new copied current-source unsigned macOS arm64 app (`app.asar` 101,556,613
bytes, SHA-256
`70da8c8f466c9e691cb0324f488d6b37acc6759f4bdb45279d2a9c0fd77862a1`).
After creating those records and a Vault-backed WebDAV profile through the
old packaged UI, that same UI used its production save-file Grant to export
an 11,477-byte legacy portable JSON file. The test
stubbed only the Host file-dialog response to select its temporary path; it
did not bypass the UI action, File Grant or Runtime exporter. This run's
export SHA-256 was
`51909cb8c392490210fedd249aee8927a11b4c644624a1a71244c9f9fe57151d`.
The file contained a version-2 `_axterm` extension, the group, both
Bookmarks, the Profile and Quick Command, and `credentials: omitted`;
none of the synthetic SSH,
WebDAV-access or sync-encryption passwords appeared in its bytes.

The current packaged app then launched with a **fresh, separate user-data
directory**, opened that exact old-package file through its production
open-file Grant with the same dialog-response stub, displayed the migration
preview and committed only after the test
clicked its explicit five-item action. The preview reported five creates, one
unchanged setting and one skip: **three credential-metadata records**, not
three restored secrets. The group row showed its source `level` field was
unmapped; in this earlier run, the Quick Command row also showed that the
top-level `command` and `commands[].id` source fields were unmapped; its
`uptime` command step still reached the imported product record. Read-only
SQLite inspection after app close found the direct SSH Host at `127.0.0.1`
with username `historical-user`, both Bookmarks under the imported group, the
second Bookmark pointing to the imported connection Profile, and the Quick
Command. The direct Host's `credential_ref` was null and no fixture password
entered the fresh database. In the separate in-place upgrade path, the group,
Profile and two Bookmark foreign-key relationships were identical in the
historical closed database, automatic pre-migration rollback database and
upgraded database. The
existing shared-user-data upgrade and both old remote-recovery branches also
passed in this same focused journey; the rollback database again matched the
pre-upgrade database byte-for-byte. This is a real old-source export/current-
package import path, while the exported file and test accounts are synthetic
and deliberately removed with the temporary test directory.

| Earlier local output                        | Bytes   | SHA-256                                                            |
| ------------------------------------------- | ------- | ------------------------------------------------------------------ |
| Historical-file preview screenshot          | 386,356 | `adbe361eaf35fe53fe41d644d466309c6d99d0ca4b94642fc9a167efe4964d97` |
| Historical-file import screenshot           | 391,192 | `b846e15dd1586f6a088eb2efb2b9b45faad0a991338289b1ef2b118837f587bd` |
| Refreshed machine-readable upgrade evidence | 3,112   | `f9734d985982376dc3fd7a9195081df6cb488d48615cc9ba30f939cc3a8bff5b` |

These outputs are under `test-results/packaged-evidence/` and are not source
inputs. The portable JSON is not retained in the public tree because it is
generated test data and its timestamp/IDs make the digest run-specific; the
test can regenerate it from the pinned historical package. This strengthens
IR-08's actual historical-source file conversion evidence but is **not** a
preserved publicly distributed installer, representative real-user export,
complete legacy-field compatibility, Vault backup, Windows/native-Linux
handoff or public migration release. IR-08 remains **In progress**.

## 2026-09-23 cold full-profile backup and restored-package launch

The same historical-source package test now covers a separate recovery branch
_before_ upgrading its original profile. After closing the old package, the
test copies its entire user-data directory, including `data/`, `vault/` and
other desktop state, to a cold backup; it verifies the copied SQLite file and
every Vault file against the closed source. It then copies that backup to a
third user-data directory and launches the current unsigned macOS arm64
packaged app there. The restored app reaches Runtime ready, displays the
historical Host and saved WebDAV profile, and crosses migration 38 while
preserving the group/Profile/Bookmark relationships and mapping the removed
`3024 Day` theme to Axterm `Default`. After closing it, the test confirms all
three saved SSH/WebDAV/encryption secrets decrypt through the copied Vault.
The original historical database and cold-backup database remain byte-identical
to their pre-upgrade bytes; their Vault files also remain unchanged. The
original profile then proceeds through the existing in-place upgrade, encrypted
and plaintext sync recovery, and portable-file handoff branches.

The focused packaged journey passed **1/1 in 15.9 seconds**. The rebuilt
current `app.asar` SHA-256 was
`2c752afb7406193f4cb29457f82d0ca6f4c1792a7e53e11f1257a6c75122c5d1`;
the run-specific machine-readable evidence is
`test-results/packaged-evidence/historical-package-upgrade.json` (3,404 bytes,
SHA-256 `108d419b98af0f18c6a4d93ea954a3adf048b4d600929fb8667cc5433c5e6df0`).
It records `fullProfileRestore` without including credential values. The
[draft migration guide](../MIGRATION_GUIDE.md) now describes a protected,
app-closed complete user-data copy and distinguishes it from portable files
and the automatic SQLite-only rollback copy.

This proves one synthetic macOS cold-copy recovery from the rebuilt historical
source package. It does **not** provide an in-app full-backup feature, validate
arbitrary real-user data or cross-device restore, replace signed/installed
Windows and Linux evidence, or begin the public migration window. IR-08 stays
**In progress**.

## 2026-09-23 historical Quick Command field retention

The previous preview exposed avoidable loss in the real old-package portable
export. Its top-level `command` is the same text as the first step, but the
importer always reported that redundant value as omitted. Its first step also
has a valid UUID, but the importer always generated a replacement ID. The
current conversion now treats the top-level value as mapped **only when it
exactly matches** the first accepted step. It retains a valid UUID step ID
when it is unique within the command; invalid, duplicate or dropped-step IDs
still receive a new ID or are omitted, and the preview continues to report
that loss. The intentionally unmapped group `level` is unchanged.

The Runtime test uses a two-step command with a duplicated UUID: it confirms
the first ID survives import/export, the second is regenerated, and the
field-level preview reports both mapped and omitted `commands[].id` rather
than falsely claiming complete preservation. The exact historical-source
macOS package journey now checks the exported top-level text and UUID, shows
`command` and `commands[].id` as mapped with no Quick Command omission, and
compares the old exported step ID to the fresh-profile imported SQLite payload.
The latest focused packaged test passed **1/1 in 18.3 seconds**. Its current
`app.asar` SHA-256 was
`f2aa0d57af2dd3e2545c56b3580f7b650166b76c497d7b8eafc7086d1bed2c4e`;
the run-specific evidence JSON was 3,404 bytes with SHA-256
`994798e2472face16e44daa96e1a319fe587786d047a003ea9fbbb33b04689b0`.
The refreshed preview screenshot SHA-256 was
`94e249d1ce7be2e300943594f328edb253050fd321c9f476bf5c864f66d8d0fc`.
This is a targeted
old-source field conversion improvement, not proof that every historical
format or unrelated field has been migrated. IR-08 remains **In progress**.

## 2026-09-23 frozen historical-source portable fixture

The exact 11,477-byte portable JSON generated through the historical
`657b3cc` package's production export action is now frozen at
`tests/fixtures/migration/historical-axterm-portable-v2-657b3cc.json`.
The tracked fixture and the run's ignored raw output were compared
byte-for-byte; both have SHA-256
`250a533d009e2b62ccc3723425584f9fad90efe9849b60ea41e2dcb583f3c0dc`.
The producer remains the unsigned rebuilt historical package whose
`app.asar` SHA-256 is
`5dc53bcc5997016a33e8fa41d588462a7b441cde759b181c95e4df6f91c916b0`.
No reformatting or field normalization was applied to the fixture; it is
excluded only from Prettier so its byte-level provenance can be asserted.

The source data was created solely by this controlled test, with synthetic
host names, credentials and command. Before freezing it, the export was
checked for the three fixture secret values; the portable file contains
credential **metadata**, not their values or references. It is nevertheless
a migration-period artifact that must remain in source/rights and final-
snapshot review; the check does not authorize publishing real user exports.

An unconditional Runtime test now checks this file's SHA-256, previews and
commits five records, preserves group/Profile/Bookmark relationships and the
Quick Command step ID, confirms three credential metadata records are skipped
without creating a saved secret, and verifies repeat-import idempotence. A
source Electron test and a copied-outside-checkout macOS packaged-app test
each use the **same frozen file** through the native open-file Grant, inspect
the loss report and commit explicitly; the focused runs passed 1/1 each
(source 1.9 seconds, package 4.3 seconds). The packaged test is written to
run on other supported platforms when their installers are available, but
these runs do not claim Windows or native Linux package evidence.
The subsequent complete unsigned macOS arm64 packaged suite passed **18 of
28** tests with ten platform/fixture skips; the tested `app.asar` SHA-256 was
`f2aa0d57af2dd3e2545c56b3580f7b650166b76c497d7b8eafc7086d1bed2c4e`.

This makes the known old-source portable shape reproducible in a clean
checkout without the old package at test time. It is not an archived publicly
distributed installer, real-user data, all historical shapes, a Vault backup,
or a completed public migration release. IR-08 remains **In progress**.

## 2026-09-23 sanitized historical-source sync fixtures

The same conditional packaged journey was rerun against the rebuilt historical
`657b3cc` app and the current unsigned macOS arm64 app; its focused run passed
**1/1**. The historical app uploaded both version-1 WebDAV objects through its
production UI. The test now writes their exact response bodies to ignored,
mode-`0600` files under `test-results/packaged-evidence/` after checking that
the three synthetic password values are absent. This run produced:

| Ignored raw old-package output             | Bytes | SHA-256                                                            |
| ------------------------------------------ | ----- | ------------------------------------------------------------------ |
| `historical-package-remote-plaintext.json` | 7,290 | `3d14425d07328a31e4be3b611e89eb10713ae8264f53f0bb27d5e22e20eb76f1` |
| `historical-package-remote-encrypted.json` | 9,833 | `d7faf928761930bc31606a1e1f533be72f92bde60972dae55578e4e52ccb900f` |

The raw plaintext document and the decryptable encrypted document both
contained the test machine's real device name. **Neither raw object is tracked
or suitable for publication.** The two tracked fixtures in
`tests/fixtures/migration/` are explicitly marked `.sanitized.json`:

| Tracked derivative                                           | Bytes | SHA-256                                                            |
| ------------------------------------------------------------ | ----- | ------------------------------------------------------------------ |
| `historical-axterm-sync-plaintext-v1-657b3cc.sanitized.json` | 7,303 | `6036e72b2970f97457d13081cbc34aae26d1f570d3c7f237f7dbaf4870679849` |
| `historical-axterm-sync-encrypted-v1-657b3cc.sanitized.json` | 9,849 | `39e4f8342bb92c73c4d6df919aaf2c03af84b051611c260d4bf1e2123bc81056` |

The plaintext derivative changes only the device-name string to
`axterm-migration-fixture.local`. For the encrypted derivative, the raw object
was decrypted with the synthetic test encryption password, that same field was
replaced, and the document was re-encrypted with fresh AES-256-GCM/scrypt salt
and IV. Therefore the tracked encrypted bytes are **not** the historical app's
byte-identical output. The derivative digests identify these exact checked-in
test inputs, while the raw digests identify this one local producer run; future
old-package runs may vary because identifiers and cryptographic randomness
vary. Both derivatives were checked for the real device-name string and the
three synthetic password strings. Their compact bytes are excluded from
Prettier and guarded by SHA-256 assertions.

Unconditional Runtime tests now load both derivatives and exercise the real
legacy envelope decoder, category comparison, preview and explicit commit
without changing the remote revision/body. A separate Runtime adapter test
loads the plaintext derivative into a fresh real database through
`Legacy PrototypeSyncDataSource`, confirms the Quick Command category is reported for
creation, commits it, and verifies the Quick Command and SSH Bookmark exist.
The focused two-file suite passed **21/21**. This makes a representative
historical-source remote shape available in a clean checkout; it does not
turn the derivative into an original old-package artifact or replace the
conditional packaged upgrade, privacy/source-rights review, real-user data,
other document shapes, public migration window or cross-platform acceptance.
IR-08 remains **In progress**.

## 2026-09-25 public-artifact availability check

At 2026-09-25T03:42:38Z, the configured `origin` was
`https://github.com/yogasamadhi/axterm.git` and local `HEAD` was
`290895c930be379d367bf41cc77a467e3258b025`. The public
[GitHub Releases page](https://github.com/yogasamadhi/axterm/releases)
reported no releases. Its public REST `releases` and `tags` endpoints each
returned `[]`; the public Actions artifacts endpoint returned
`{"total_count":0,"artifacts":[]}`. `git ls-remote --tags origin` exited
successfully with no tag refs. These checks describe that repository at that
time; they cannot rule out a package distributed by another channel or later
removed from GitHub.

The ignored local `release/` directory **does** contain older-looking,
independently built `Axoterm 0.10.0` artifacts. This is a candidate for an
additional old-binary engineering test, not evidence of public distribution:

| Local artifact                         |       Bytes | SHA-256                                                            |
| -------------------------------------- | ----------: | ------------------------------------------------------------------ |
| `release/Axoterm-0.10.0-arm64.dmg`     | 152,370,653 | `496bf7e712639d1dc265db28ac0065a57535318410e335b3b2c290311813aa99` |
| `release/Axoterm-0.10.0-arm64-mac.zip` | 146,973,515 | `fca121500f70b18eda5cd88d8f9fef0d0d685e88237b417e516d151bd5e74d25` |

The ZIP's `Info.plist` identifies `CFBundleExecutable=Axoterm`, bundle ID
`dev.axoterm.desktop`, version `0.10.0`, and an `app.asar` integrity hash
`7c41813e18b95799971fecc24554491a81493b747645b44f96a4d2af35bd9721`.
File timestamps and product version do not establish provenance, signing,
user distribution or a version-number transition. The current conditional
packaged-upgrade fixture expects a historical `Axterm` executable, so this
candidate has **not** passed that journey. The extracted ZIP's full
`app.asar` SHA-256 is
`812b9fd95f092f7e52b9c66b230485a0f664fa9a5acfa4628b11885c03a07879`;
it is a different measurement from the plist's Electron integrity field.

An isolated diagnostic temporarily taught the conditional packaged journey
to launch the ZIP's own `Axoterm` executable; those fixture edits were then
reverted rather than changing the established green acceptance test. The
old binary launched against a fresh temporary `--user-data-dir`, created the
fixture Host/bookmark/profile/command and Vault files through its UI, and
exported a portable document. Unlike the later historical-source package,
that document lacks the `_axterm` version-2 extension and has no credential-
metadata skip row. The old package wrote `data/axoterm.sqlite` (plus Vault
files) under that temporary profile, whereas the current Runtime opens
`data/axterm.sqlite`. The diagnostic stopped at the test's hard-coded old
database filename, **before** it could claim a complete current-package
upgrade. This is a concrete legacy-format/database-name compatibility
question, not a passing upgrade or evidence of data loss in a released build.
The source-path difference indicates that an explicit name-transition path
would be needed if this old binary was distributed; that last statement is
an inference from the observed files and current Runtime path, not yet a
packaged migration result.

The release owner must now identify any old installer actually distributed
outside this GitHub Releases page, with channel, immutable bytes/hash and a
sanitized representative profile. If the owner confirms there was **no** prior
public Axterm/Axoterm installer, W-06-02, W-08-02 and W-13-02 need an explicit
release-acceptance decision for the no-prior-public-installer case; neither
the historical-source rebuild nor this local `Axoterm` package is silently
promoted to a public-old-installer substitute. Until one branch is decided,
the three work items and IR-08 remain open.

## 2026-09-25 preserved Axoterm binary → current Mac portable-file handoff

The owner has now stated in this conversation that the old Axoterm/Axterm
installer was **not publicly distributed**. This resolves the distribution-
fact question for the execution board; it does not by itself approve an
alternative release acceptance test or change the migration-window decision.
The old ZIP above was extracted without modifying it. Its `Axoterm.app` ran
from a fresh temporary profile, reported version `0.10.0` and Runtime ready,
and created a synthetic password-backed SSH Host/Bookmark through its actual
UI. The old app exported a 9-KiB portable JSON document through its own save
dialog; it contained the `_axoterm` extension and the synthetic bookmark but
not the plaintext fixture password.

The current unsigned Mac directory package, with `app.asar` SHA-256
`bd0afa6bfa5a7a01463bcfff805fc51950a1f441a052b2c39cbb9bba83999396`,
opened that exact old-produced JSON through its real file-dialog/import
preview, then committed one SSH Host/Bookmark. After shutdown, its SQLite
row retained the expected name, hostname and username and had
`credential_ref = NULL`; the portable transfer did not silently transport
the old application's Vault secret. The optional packaged Playwright test
`current Mac package imports a portable file produced by the preserved
Axoterm package` passed **1/1** in 8.9 seconds with:

```bash
AXTERM_PREVIOUS_AXOTERM_APP=/absolute/path/to/Axoterm.app \
AXTERM_PACKAGED_APP=/absolute/path/to/Axterm.app \
bun x playwright test tests/e2e/packaged.spec.ts --project=packaged \
  --grep 'portable file produced by the preserved Axoterm package'
```

The local ignored result `test-results/packaged-evidence/axoterm-portable-handoff.json`
records old `app.asar` SHA-256
`812b9fd95f092f7e52b9c66b230485a0f664fa9a5acfa4628b11885c03a07879`
and the current package hash above. The JSON export hash is run-specific
because the old app creates new UUIDs; one passing run produced
`0990c12f3c4a00917d6b6123641377b10548629ad3f3d34cfb2d892b707fe104`.
Only synthetic data was used. The test is conditional because the old binary
is an ignored local artifact, not a source-controlled test dependency.

A separate same-directory diagnostic copied the closed old temporary profile
and launched the current package without explicit export/import. It reached
Runtime ready but did **not** show the old synthetic Host: the old data is in
`data/axoterm.sqlite`, while current Runtime creates/opens
`data/axterm.sqlite`. The old file remained present. This is not an automatic
database/Vault upgrade, not a real user-data test, and not evidence that a
released old installer existed. If the first public release must migrate
private Axoterm profiles automatically, that requirement needs a distinct,
safe database/Vault-name transition and failure/rollback tests. If the
approved first-release scope is explicit portable export/import from the
unpublished prototype, the tested path is available, but saved passwords
must be re-entered and documented. W-06-02, W-08-02, W-13-02 and IR-08 remain
open pending the release owner's named scope decision and other gates.

### Separate user-created theme handoff in the same binary journey

The old package's portable JSON **omits** user-created terminal themes: an
isolated old profile had a saved custom theme in its `terminal_themes` table,
but its real `导出数据` output contained no `terminalThemes` key or theme name.
Therefore the portable JSON alone is not a complete manual migration path.
The same old UI can export each selected custom theme as a separate
`themeName=...` text file. The current migration-period Mac UI accepted that
exact text through `导入旧主题文件` and persisted the custom theme under the same
name. The conditional packaged journey now exercises both steps in one fresh
synthetic run: password-backed Host via portable JSON, custom theme via its
separate file. It passed **1/1** in 9.2 seconds after typecheck. Its ignored
machine-readable result records old/new `app.asar` hashes above, portable
SHA-256 `3356bb3ae815d74374a8756dd975e325640c48a21f53e99a4f1b12ef890d398d`,
theme-file SHA-256
`6382af740eeba5b5878e06752488e9c3f99f3809705b7ea03f7353a4e4333204`,
and confirms the theme was separate from portable JSON. These hashes identify
this synthetic run, not a user profile.

This proves a bounded **two-file-type** path, not automatic migration of all
old data. It does not transfer old Vault credentials, every theme variant,
background image content, settings-sync state or an unknown number of user
themes in one operation. If manual migration is approved, release instructions
must explicitly require separate export/import of each custom theme and
re-entry of passwords; otherwise the auto-migration scope remains open.

### 2026-09-25: two-theme handoff and rejected-file preservation

The same conditional journey now creates **two** named user themes in the
preserved, unpublished Axoterm binary and exports each through its real UI
to a separate text file. The rebuilt current unsigned Mac directory package
imports both through its real UI after importing the portable Host JSON.
The test compares the complete `ui` and `terminal` palette payload of each
current SQLite row against the row created by the old binary, not only the
names. It then imports a copy of the old theme text with an unsupported
property, observes the failure, and verifies both previously imported rows
and their palettes remain unchanged. The bad file does not add a third row.
The old-produced portable JSON still contains neither theme name nor the
synthetic SSH password; the current Host still has no `credential_ref`.

The optional packaged journey passed **1/1** in 8.4 seconds. Its current
ignored result is `test-results/packaged-evidence/axoterm-portable-handoff.json`;
the inspected UI screenshot is
`test-results/packaged-evidence/axoterm-two-theme-import.png`. The old
`app.asar` SHA-256 is
`812b9fd95f092f7e52b9c66b230485a0f664fa9a5acfa4628b11885c03a07879`,
the current `app.asar` SHA-256 is
`0d65d4069a00ad317811d86c4cef9612ab228dfdc1a675376bc6b3466401a7f0`;
the two old-exported theme files have SHA-256
`d0de86b8b7f2f11cc867f9438156b70903c1f4dfeaecd1effee21a0adb244a68`
and `0c4bc89e41c94be5640dea45dfc527a80dc2703a561404379ddd5d53747a962e`.
The malformed-file hash is
`86b0672cfcad985b030129bd4ad51fb8568a39e8df4db73f67dbf813f8bcf5d6`;
the screenshot hash is
`ceaabe78ad5afa536dbecce1fb8003d8d9be49f74d1486de5d0402c766a92d63`.
The portable JSON hash varies with old-app UUID generation and is in the
run-local JSON. No real user's data was used.

This strengthens the explicit manual theme-file path and one **theme-file**
failure case. It does not prove automatic database/Vault migration, arbitrary
numbers of themes, background-image transfer, full multi-step migration
rollback or a real prior public release. W-06-02, W-08-02 and IR-08 still
require the release owner's approved first-public-release scope and their
other stated gates.

### 2026-09-25: approved manual scope, cold-backup restore and malformed-file retry

The owner subsequently approved the limited first-public-release path: portable
data, individual custom-theme files and re-entry of passwords; no automatic
`axoterm.sqlite`/Vault conversion. The same optional packaged journey was
extended and rerun against the preserved unpublished ZIP (SHA-256
`fca121500f70b18eda5cd88d8f9fef0d0d685e88237b417e516d151bd5e74d25`)
and the current unsigned Mac app (`app.asar` SHA-256
`be90deb22e347751e0458be27d96985705d76a509fed2d9f47f2ddbda8c970fe`):
**1/1 passed**. Before importing, it copied the old app's entire closed
user-data directory, checked the SQLite and Vault file hashes, restored that
copy to a fresh location, launched the actual old app against the restore and
observed the Host. The current Vault reader also decrypted the synthetic old
Host password from the restored copy. The untouched backup DB SHA-256 was
`c2f55df6f7baeaa7a593b650b361347949932908e5c438f15795589c807bfc3f`;
the run-specific Vault hashes are in ignored local
`test-results/packaged-evidence/axoterm-portable-handoff.json`.

The current app first selected a truncated old portable JSON. Its import error
appeared, while both `hosts` and `bookmarks` tables remained empty. The UI then
selected the intact old-produced JSON and successfully imported the Host, then
both old-produced theme files. The invalid third theme was still rejected
without changing the two imported palettes. The old cold backup remained
byte-identical; the new Host's `credential_ref` remained null, matching the
approved instruction to re-enter passwords. This is a synthetic local Mac
journey, not a signed/installed or publicly distributed old-version upgrade.
Background image bytes, arbitrary old presets, late SQLite failure specifically
from this Axoterm file, other platforms and release-owner sign-off remain open.

### 2026-09-25: removed built-in, background image and explicit password re-entry

The same real-old-package/current-package journey now begins with the old UI
applying removed built-in `3024 Day` (`00000000-0000-4000-8000-000000000003`)
globally and importing a synthetic PNG as its terminal background. Read-only
inspection of the closed old database and original asset file proved that the
selected theme ID and image bytes were present. The old UI's portable JSON
instead named Axterm's stable Default theme ID and `kind: none`; it contained
neither the old image asset ID nor the image bytes. The fresh current package
initially had no imported background asset. The test then used the current UI
to reselect the original PNG and apply it; the new SQLite settings referenced
a **new** image asset ID and the new asset bytes matched the source. Both old-
created user themes still imported with their exact `ui`/`terminal` palettes.
This establishes an explicit manual image step and avoids silently shipping
or selecting the removed built-in palette; it is not a claim that background
images travel inside portable JSON or that every historical preset is covered.

Immediately after importing the old portable Host, the current Host had no
`credential_ref` and its Vault had no credential ciphertext. The current Host
editor then accepted a **different**, synthetic re-entered password. Its final
`credential_ref` was not the old reference, and the new application-local
Vault decrypted exactly the re-entered value. Neither password appeared in
the old portable bytes. This verifies the owner-approved manual password
step, not automatic transfer of the old Vault.

For a late-failure probe using the exact old-produced portable file, the test
installed a temporary `BEFORE INSERT ON bookmarks` abort trigger in the new
database. The UI import failed, and read-only counts for `hosts`, `bookmarks`
and `legacy-prototype_import_entries` all remained zero; the new Vault still had no
credential file. After removing only that test trigger, the UI reselected the
same intact file and completed the import. The separate malformed JSON and
bad-theme failures continue to pass. The current optional package journey
passed **1/1** in 10.3 seconds with old `app.asar` SHA-256
`812b9fd95f092f7e52b9c66b230485a0f664fa9a5acfa4628b11885c03a07879`
and current `app.asar` SHA-256
`be90deb22e347751e0458be27d96985705d76a509fed2d9f47f2ddbda8c970fe`.
The run-specific portable, backup and screenshot hashes are in the ignored
`test-results/packaged-evidence/axoterm-portable-handoff.json`; the synthetic
PNG and secrets were not added to the repository. This completes the bounded
Mac engineering examples in the approved manual scope, but W-06-02/W-08-02
still require release-owner sign-off; arbitrary presets, real old public users,
signed installers and Windows/Linux native behavior are not proven.

### 2026-09-25: four-language safety copy verified in a freshly packaged Mac candidate

After adding the migration-panel reminder in `en`, `ja`, `zh-CN` and `zh-TW`, a
fresh **unsigned macOS arm64 directory package** was built in a private sibling
directory with signing auto-discovery disabled. Its `app.asar` SHA-256 is
`8f85eda6c4bb3116001bdda3f197db21f65e74a40157e908155d945b33425c23`;
the preserved old ZIP still yielded old `app.asar` SHA-256
`812b9fd95f092f7e52b9c66b230485a0f664fa9a5acfa4628b11885c03a07879`.
The optional packaged test now asserts that the current Chinese migration
panel visibly warns about missing custom themes, background images and
passwords, and retaining a complete old-profile backup before it continues
the actual old-to-new import, failure/rollback, password re-entry and image
steps. In the same Playwright invocation, the packaged migration and
configuration accessibility journey also passed: **2/2 packaged tests**.
Two additional tests on this same candidate confirmed that the packaged
third-party legal files are present and that About opens the exact applicable
license/notices: **2/2 passed**. This is an unsigned-candidate content check,
not W-11-04's signed final-package acceptance.

The run-local evidence JSON was copied before Playwright's next run to the
mode-`0700` private candidate directory
`../axterm-mac-candidate.fthqPh/axoterm-portable-handoff.json`
(mode `0600`, SHA-256
`1bfb15add1b3f47076151a13ea47078e65009e7855610de3f7aee742bf67e2a6`);
it records the two package hashes and synthetic-file hashes. The run's
`axoterm-two-theme-import.png` screenshot was also copied to that private
directory (mode `0600`, SHA-256
`56e892661ec050051fe3e6a61f3797655c5c4b459455149b55e078c8af7af93b`).
The new source also passed the
four-language copy test and 200%-zoom migration-panel assertions; full
`bun run check` is recorded in [STATUS](../STATUS.md). The package is a local
unsigned candidate, not a signed/notarized DMG, publicly distributed build,
human translation review or release-owner acceptance. W-06-02/W-08-02 remain
open pending that acceptance; Windows/Linux results and the public migration
window remain separate gates.
