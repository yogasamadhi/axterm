# IR-08 / W-08-01 / D2: Mac bookmark and user-theme upgrade continuity

Date: 2026-09-25. Scope: **Mac engineering cell D2 only** in the
[fixed execution board](../REMAINING_RELEASE_WORK.md). The existing historical
upgrade journey was rerun against the current unsigned Mac app; this is not a
new public release, a legal review, or W-08-02's real public-old-installer
upgrade. Both app manifests report `0.10.0`.

The previous app is an independently rebuilt package of exact Git commit
`657b3cc1552cd3b0dc3b0f73df1c1a4a5a8a6a6e`, whose UI creates a Host,
Bookmark/group, linked connection Profile, custom theme and a selected old
built-in theme. Its `app.asar` SHA-256 is
`5dc53bcc5997016a33e8fa41d588462a7b441cde759b181c95e4df6f91c916b0`.
The current app's `app.asar` SHA-256 is
`08b3edb130dbf616801adfa676a4c97353fbd3507440f4422b6cd8f05b724651`.
The Playwright test source hash is
`b3112514fb122d0573a767bc616854d31100b8769d52159777773d8158ba74d8`.

| D2 condition            | Observed result                                                                                                                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bookmark links          | The old UI-created Host, Bookmark, group, Profile link and credential reference remain linked after the current app opens the same profile. The packaged test asserts these rows in both pre-migration backup and upgraded database.                                                            |
| Old built-in reference  | The selected upstream `3024 Day` ID `…0003` becomes Axterm `Default` ID `…0001`; the automatic rollback database retains the old selection.                                                                                                                                                     |
| User-created theme      | `Historical user theme` keeps its ID, name, `builtIn: false`, exact payload, created/updated timestamps and version across upgrade. It remains visible in the current Theme workspace. Its terminal/UI palettes survive Axterm configuration export and explicit reimport into a fresh profile. |
| Backup and cold restore | The closed old database and automatic pre-migration-34 rollback copy share SHA-256 `ba9ce53b4ac42b11587ba978dabd2fa9dbf1f737f741fefad650785c27f0ef30`. A complete cold profile copy opens in the current package; its original source and backup remain unchanged.                              |

The conditional package journey passed **1/1 in 17.7 seconds** on macOS arm64:

```sh
AXTERM_PREVIOUS_PACKAGED_APP=/Users/h/.codex/worktrees/axterm-initial-release/axterm/release/mac-arm64/Axterm.app \
AXTERM_PACKAGED_APP=/tmp/axterm-s5-final.Q0rUE4/mac-arm64/Axterm.app \
  bunx playwright test --project=packaged \
  -g 'current packaged app upgrades data produced by a historical packaged release'
# 1/1 passed
bunx vitest run \
  packages/runtime/src/adapters/sqlite/theme-catalog-migration.test.ts \
  packages/runtime/src/adapters/sqlite/bookmark-migration.test.ts
# 2/2 passed
```

The packaged journey also wrote an ignored, machine-readable diagnostic
receipt at `test-results/packaged-evidence/historical-package-upgrade.json`.
Its random IDs and profile-specific hashes vary per run, so the above stable
app identities and assertions—not that receipt's whole-file hash—anchor this
record. The custom-theme payload SHA-256 in this run was
`6b918ed43cdd4c9b157be937470b181729b44d1a186826a59ad7a48b02264c39`.
The older historical custom-theme record in the private evidence archive
describes the test's field-level assertions and migration-guide warning that
the old portable export omitted user-created themes.

The producer is a **source rebuild**, not an archived binary proven publicly
distributed; no real customer profile, different-version upgrade, signed app,
Windows/Linux or migration-window result is inferred. D2 meets its scoped Mac
engineering stop line. Next fixed cell: **D3**, old links and portable
import/export/conversion failure boundaries. W-08-01 and IR-08 remain open;
this record closes **0 W items** and changes **0 IR gates**.
