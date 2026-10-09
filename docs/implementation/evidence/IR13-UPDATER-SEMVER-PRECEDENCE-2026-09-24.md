# IR-13 signed updater SemVer precedence — 2026-09-24

Status: **local signed-feed and unsigned macOS packaged regression verified;
IR-13 remains Open**.

## Gap and correction

The signed manifest Contract accepted a loose version pattern, and the Desktop
Host compared only the numeric major/minor/patch fields plus whether a
prerelease suffix existed. It therefore treated distinct prereleases with the
same base version as equal: `1.1.0-beta.2` could not discover
`1.1.0-beta.11`. It also admitted malformed identifiers such as `1.0.0-01`
and rejected otherwise valid build metadata.

The manifest version field and the installed app version now use a bounded
SemVer 2.0.0 validator. The updater compares numeric base fields, prerelease
identifiers (numeric versus lexical, then identifier count) and stable versus
prerelease precedence; build metadata is accepted and ignored for precedence.
The version string remains part of the exact signed manifest record, so a
different build metadata value cannot be inserted without invalidating the
signature even though it does not create a newer version. The rules follow
the [SemVer 2.0.0 specification](https://semver.org/).

## Verification

The new signed-loopback-feed regression first failed for `alpha` → `alpha.1`,
`beta.2` → `beta.11` and numeric → alphanumeric prerelease transitions. The
loose Contract also admitted malformed versions and rejected build metadata.
After correction, the focused updater suite passes **19/19**, including
reverse-order/downgrade, stable/prerelease and equal-precedence build-metadata
cases. Typecheck and the 267-operation Contract drift check pass.

`bun run build` passed. A fresh unsigned macOS arm64 directory package was
built outside the checkout at `/tmp/axterm-updater-semver-hU77hf`. Its actual
Resources matched the packaged SPDX sidecar, and the packaged signed-updater
journey passed **1/1** against a local Ed25519-signed chunked HTTP fixture.
The packaged journey verifies the production update pipeline, but the
prerelease precedence branches are exercised by the focused signed-feed tests,
not by a separately versioned packaged binary.

| Item                        | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| Desktop manifest Contract   | `0853d9f758fa8324cc20bfaa5742f4d9874988f7179587b0c689d8b36f99c232` |
| Updater implementation      | `2b0309bdbc990df528b55e09a10705ebfe654034de7a51baefd376aa6aa79bbe` |
| Focused updater test        | `1afb15331f13bad7d3539e21a630b7a9ce1aae59dadf41841869a6db76199384` |
| macOS package `app.asar`    | `23d3f81abc7e72b4cc6f7ff9d6055da64890138611e7dc62df3aaf4ceb827c86` |
| macOS packaged SPDX sidecar | `01057432e64dcde2abc5785f9ddb38a6a7ca9279b9cb4093c783f6da45d429e1` |

## Limits

The fixture key and loopback HTTP source are test-only. This is not a
controlled production HTTPS feed, signed/notarized installer or installed
binary-to-binary upgrade on any target platform. A real prerelease-package
upgrade has not been run. IR-13 remains **Open**.
