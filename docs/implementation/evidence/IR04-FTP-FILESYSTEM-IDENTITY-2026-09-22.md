# IR-04 FTP filesystem-identity hardening — 2026-09-22

Status: source-level evidence; IR-04 remains **In progress**.

## Boundary corrected

The independent `NodeLocalFtpServer` previously created a `STOR` partial file
inside the destination directory and rechecked only that the requested target
still resolved inside the granted root. If an external filesystem actor moved
that directory while the data socket remained open, the partial file moved
with it and its saved pathname no longer identified the file. The transfer was
rejected, but cleanup could leave received bytes under the moved directory.

`RNFR` also retained only a canonical pathname. Replacing that pathname before
`RNTO` could make the server rename the replacement instead of the entry that
the authenticated client selected.

## Implemented behavior

- `STOR` creates its mode-`0600`, exclusive UUID staging file directly below
  the canonical File Grant root. The temporary pathname therefore remains
  stable when a nested destination directory is moved or exchanged.
- The internal `.axterm-ftp-<UUID>.part` namespace is omitted from FTP
  directory listings and rejected by every FTP path command, including a
  direct `SIZE` request from another authenticated session.
- Before publication, the server resolves the target again and requires both
  the canonical target pathname and the destination parent's filesystem
  identity (`dev` and `ino`) to match their pre-transfer values. A changed
  destination receives `426`; the root-anchored partial is removed and the
  authenticated control connection remains usable.
- `RNFR` records the selected entry's canonical pathname and filesystem
  identity. `RNTO` resolves that pathname again, requires it to remain inside
  the grant at the same canonical location, and compares its identity before
  renaming. A replacement receives `550`, while both the original moved entry
  and the replacement remain untouched.

## Verification

The focused command:

```text
bunx vitest run packages/runtime/src/adapters/widget/widget-server-adapters.test.ts
```

passed one file and 15 tests on macOS arm64. The added POSIX `STOR` regression
holds a real `basic-ftp` upload open after nonzero bytes reach staging, exchanges
the destination directory for an in-root symlink, and then resumes the data
stream. It requires a failed transfer, no final file, no partial file in the
grant root or moved/replacement directories, an invisible/inaccessible staging
name and a subsequent `200` response to `NOOP`. The raw-control `RNFR`/`RNTO`
regression replaces the selected source between the commands and requires
`550`, unchanged source bytes, no destination and a subsequent `200` `NOOP`.

## Deliberate limits and remaining gates

The directory-exchange regression is POSIX-only because Windows generally
does not permit the same open-directory rename sequence. The source identity
check itself is platform-neutral, but Windows and native-Linux installed-app
coverage remains required. Publication is still a path-based Node `rename`,
not an OS-specific `renameat` transaction; an independent security reviewer
must assess the residual interval between the last identity check and rename.
Because staging is anchored to the grant root, a destination on a different
mounted filesystem fails safely with `426` rather than falling back to a
non-atomic copy. This evidence does not provide independent review, source-
rights approval, remote CI, signed distribution or IR-04 acceptance.
