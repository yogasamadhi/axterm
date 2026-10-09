# Historical reference archive — controlled evidence outside the release tree

Date: 2026-09-20  
State: archived locally for owner-controlled recovery; **not** a release artifact

The retired source name and related historical path/package/URL labels in this
copy are redacted placeholders. They are not names of actual downloadable
artifacts or valid recovery commands. Use the unchanged controlled prior
repository to locate and verify originals before any rights or recovery work.

The historical 1:1 reference source, screenshots, traces and harness were
removed from the Axterm worktree only after a recoverable, owner-local archive
was created. The archive root is outside this repository at
`/Volumes/A/code/project/axterm-controlled-reference-archive`, with directory
permissions `0700`; compressed artifacts have permissions `0600`. It must not
be copied into the new public repository or any application package.

| Artifact                                        | SHA-256                                                            | Verification                                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `axterm-pre-clean-history.bundle`               | `6ea1eb89c6198b12d20f2b1a264b8dd2c7490fa3be1de5eaf8277b2577327843` | `git bundle verify` reported complete main-repository history.                                                                                                                             |
| `legacy-prototype-799bedef-history.bundle`      | `a4d749396f375082ea170e261f527ad8870aa9f44857b093f156c9e70c8c0ddc` | `git -C <restored-source> bundle verify` reported all 629 saved upstream refs.                                                                                                             |
| `historical-parity-reference-2026-09-20.tar.gz` | `e08c71debefc206ea62a6889764a7ac38aa2e641383d732656723cc3027632ee` | `tar -tzf` succeeds. It contains the pinned upstream working source without its reproducible `node_modules`, the old parity harness, manifests, screenshots, traces and unit/config files. |

For direct recovery, the same archive root also contains the exact moved
worktree paths in `moved-from-worktree-2026-09-20/`: `.gitmodules`,
`vendor/legacy-prototype`, `scripts/parity` and `tests/parity`. That recoverable copy
retains the original upstream `node_modules` as it existed locally, while the
compressed archive omits it to avoid treating installed dependencies as source
evidence.

The worktree no longer contains those paths, the root package exposes no parity
or reference-capture command, and current product validation uses only Axterm
visual/accessibility tests. A later clean new Git checkout, source-rights
review, platform evidence, release approvals and the migration window remain
separate requirements; this record does not accept IR-10, IR-12, IR-13 or
IR-14.
