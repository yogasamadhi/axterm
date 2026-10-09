# IR-13 signed updater stream-write boundary — 2026-09-24

Status: **local signed-feed implementation and unsigned macOS packaged journey
verified; IR-13 remains Open**.

## Gap and correction

The Desktop Host updater parsed an absent HTTP `Content-Length` with
`Number(null)`, yielding zero. A valid chunked artifact therefore failed before
download even though the signed manifest declared its exact size and SHA-256.
It now treats the header as optional; if present it must be a safe integer
matching the signed size. The streamed byte count and digest remain mandatory
whether or not the server sends that header.

The updater also assumed each `FileHandle.write` persisted an entire response
chunk. A short write could mark a truncated installer `ready` because the
digest and count were calculated from the network bytes, not the actual disk
write count. It now loops until the full chunk is written and fails closed on
a zero, invalid or oversized `bytesWritten` result. Directory creation and
stale partial-file removal were moved inside the download's error boundary so
a filesystem setup failure returns a stable, non-sensitive status and clears
the operation timeout.

## Reproduction and verification

The focused signed-feed suite first failed in both new cases: the chunked
response returned `error` rather than `ready`, and an injected five-byte
writer was called only once while the updater reported `ready`. After the
correction, all **11/11** updater tests pass. The new regressions verify a
chunked HTTP artifact without `Content-Length`, repeated short writes with
exact final bytes, zero-byte write failure with no `.part`/final artifact,
and an unwritable download-directory path with a stable error. The existing
signature, digest, origin, cancellation and installer rehash cases still pass.

`bun run build` passed. A fresh unsigned macOS arm64 directory package was
built outside the checkout at `/tmp/axterm-updater-bounds-wAcA1U`; its actual
Resources matched the generated packaged SPDX sidecar. The packaged updater
journey then passed **1/1** against this app after its local signed fixture
was changed to send the artifact using `Transfer-Encoding: chunked` without
`Content-Length`. The journey checks the ready state and ensures the local
installer path is not exposed to the Renderer. The packaged artifact was
built before that test-only fixture edit; its production bytes did not change.

| Item                        | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| Updater implementation      | `665e8a6bf9bd8acd57d56054011f36e5309b65bf8af69f0b8141435108cea64e` |
| Focused unit test           | `1286042d8071ca169b8e5637d14507d647f0be1958efa821cf3a1429cd00efdd` |
| Packaged updater journey    | `f3a1f9ba956b938608a29016168de0d3bdf1b64336f6ce9e5904778fdb9d480d` |
| macOS package `app.asar`    | `51f8a2419dd715c54a1cedf4e2d6547fba3f8b33d1ef6df80a95c352b069fb82` |
| macOS packaged SPDX sidecar | `24c48a1fd9f135d59bcadeab7bf1be5e832eef650356119fb0f9186c14fc9aae` |

## Limits

The fixture's Ed25519 key and loopback HTTP server are test-only. This run
does not establish a controlled production HTTPS feed, production signing
identity, signed/notarized installer, actual installer execution, or
binary-to-binary upgrade on macOS, Windows or Linux. The package is unsigned
and was not installed from a DMG. IR-13 remains **Open**.
