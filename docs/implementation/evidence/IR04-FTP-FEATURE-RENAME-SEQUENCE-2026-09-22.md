# IR-04 FTP feature and rename sequence conformance — 2026-09-22

Status: source-level protocol evidence; IR-04 remains **In progress**.

## Normative behavior

The implementation was checked against the RFC Editor copies of
[RFC 3659 section 3.3](https://www.rfc-editor.org/rfc/rfc3659.html#section-3.3),
[RFC 3659 section 4.3](https://www.rfc-editor.org/rfc/rfc3659.html#section-4.3)
and [RFC 959 section 4.1.3](https://www.rfc-editor.org/rfc/rfc959.html).
RFC 3659 requires a server that implements `MDTM` or `SIZE` to advertise the
corresponding single-word feature, with one-space indentation, in its `FEAT`
response. RFC 959 requires `RNFR` to be immediately followed by `RNTO`; `RNTO`
may act only on the source selected by the immediately preceding `RNFR`.

## Implemented behavior

- `FEAT` includes exactly one one-space-indented `MDTM` line and one
  one-space-indented `SIZE` line alongside the existing `REST STREAM` and
  `MLST` declarations.
- Every command other than `RNTO` clears an earlier rename selection before
  it is processed. A `NOOP`, metadata request, authentication command,
  unsupported command or new `RNFR` therefore cannot leave an older source
  available to a later `RNTO`.
- A new `RNFR` still records the canonical source path and filesystem identity
  only after the command succeeds. `RNTO` consumes that state before target
  validation, so a failed destination attempt cannot replay it.
- The existing source-identity check remains in force: even an immediately
  adjacent `RNTO` rejects a source pathname that was replaced after `RNFR`.

## Verification

The focused command:

```text
bunx vitest run packages/runtime/src/adapters/widget/widget-server-adapters.test.ts
```

passes one file and 18 tests on macOS arm64. A raw authenticated control
connection sends the sequence `RNFR` → `NOOP` → `RNTO`; the server returns
`503`, leaves the source unchanged and creates no destination. The same
connection then sends adjacent `RNFR`/`RNTO`, receives `250`, verifies the
byte-exact rename and remains usable for `NOOP`. The existing raw `FEAT`
fixture requires exactly one ` MDTM` and ` SIZE` response line, preserving the
mandatory leading space. Root `bun run typecheck` also passes.

A fresh `bun run candidate:check` then audited a 752-file / 15,739,512-byte
source snapshot with tree SHA-256
`60792bf2057c2e76a7be3ad12f03822b4086a0b4a6e2a6bd7f0fd6e68e56276e`.
Temporary root commit `36c7bb3cd10286c1d7b861db89e3c4b255af91e2` and its
separate `git clone --no-local` each tracked 752 files. The clean clone passed
217 test files with five skipped files (960 tests passed and 33 skipped), the
368-module / 1,313-dependency Level 1 architecture gate, 267 Contract
operations, all source/release hygiene checks, production build/layout, five
visual journeys and two accessibility journeys. The candidate command removed
its temporary directories.

## Deliberate limits and remaining gates

This is a local raw-control-socket regression on the current macOS host. It
does not substitute for an independently operated FTP client/server review,
Windows or native-Linux installed-app evidence, protocol/security review,
source-rights approval, signed distribution or remote CI. The filesystem
identity and residual path-based final-operation limits recorded in the other
IR-04 evidence remain unchanged. IR-04 is not accepted by this record.
