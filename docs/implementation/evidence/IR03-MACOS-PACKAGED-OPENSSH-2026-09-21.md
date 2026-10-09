# IR-03 macOS packaged OpenSSH fixture revalidation — 2026-09-21

State: **P-02 transport-layer evidence only; not IR-03 acceptance**

## Scope

This revalidation ran the committed Docker OpenSSH fixture against the current
source Electron journey and the existing unsigned macOS arm64 directory
artifact. The fixture creates a short-lived private Docker network and three
OpenSSH containers (jump host 1, jump host 2 and target); its cleanup trap
removes all of them at exit.

The packaged journey copied
`release/mac-arm64/Axterm.app` to a temporary directory outside the checkout
before launch. The tested `app.asar` SHA-256 was
`055aa095fac2eb44a39d2711b0733c3f920356c0d4f44186570542d029acc74b`.

## Result

| Command                     | Result                                                                                                                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run test:ssh`          | Passed the real OpenSSH Runtime integration (password authentication, Host Key approval, SSH PTY, SFTP, multi-hop, ProxyCommand, local/dynamic/remote tunnels and X11/startup-script paths) and the source Electron B-12 save-and-connect journey. |
| `bun run test:ssh:packaged` | Repeated the source checks and passed the copied packaged-app SSH journey: password authentication, Host Key approval, rendered SSH PTY output and search, SFTP `/tmp` browsing, then saved bookmark/history persistence across app restart.       |
| Fixture cleanup check       | Passed: zero containers with the fixture labels and zero `axterm-ssh-fixture-net-*` networks remained after the script exited.                                                                                                                     |

## 2026-09-22 current-artifact revalidation

Docker Desktop 29.6.2 (`linux/aarch64`) was started after confirming the daemon
was initially unavailable. `bun run test:ssh:packaged` then rebuilt the pinned
fixture image, created a process-unique private network and three labelled
OpenSSH containers, and allocated the host control port through Docker rather
than using a fixed port.

The Runtime integration passed password authentication, Host Key approval, SSH
PTY/SFTP, two-hop and ProxyCommand routes, local/dynamic/remote tunnels, X11 and
startup-script paths. The source Electron B-12 journey passed its saved
credential-reference and verified SSH terminal workflow. The current unsigned
macOS arm64 packaged application then passed password authentication, Host Key
approval, rendered PTY output/search, live SFTP `/tmp` browsing and persisted
bookmark/history restart checks. This application is the current builder output
used for the 2026-09-22 DMG/ZIP candidate and has `app.asar` SHA-256
`ecc1aa6ee4f949e4ace0bf3e852ffe5e2576706eef04c6c486f3c534d0dca8a1`.

After the wrapper exited, a label-filtered container query and the
`axterm-ssh-fixture-net` network query both returned zero entries. This proves
the current package can complete the controlled OpenSSH path and deterministically
release its fixture resources; it remains subject to the limits below.

## Limits

The Docker image is a controlled local OpenSSH fixture, not an independently
operated external SSH service. This run does not exercise remote
XMODEM/ZMODEM/trzsz protocol peers, filesystem portability, a signed/notarized
installer, Windows/Linux packages, source-rights review or final distribution.
It therefore strengthens P-02's real SSH transport and macOS packaged-app
baseline only; IR-03 remains **In progress**.

## 2026-09-23 current-source directory-app revalidation

The current working tree first passed `bun run test:ssh`: the controlled
three-container OpenSSH integration and the source Electron B-12
save-and-connect journey both exited zero. A fresh, unsigned macOS arm64
directory app was then built in isolated ignored output
`release/axterm-ssh-candidate-z4I3MG/` without overwriting older DMG/ZIP or
directory-app evidence. Its 101,556,613-byte `app.asar` SHA-256 is
`70da8c8f466c9e691cb0324f488d6b37acc6759f4bdb45279d2a9c0fd77862a1`.
The matching packaged SPDX sidecar SHA-256 is
`8826f1560e62699480c2bc6d8dfddb445b4e0b575e5deadebdac9f5499b034cf`
(87 packages, 233 files, 319 relationships); `sbom:packaged:check` regenerated
it from that app's actual Resources. Packaged third-party notices SHA-256 is
`2e54be6ed3f48e0ada8fc145a03b98c6fab8b2c173fbe1cd6744058ab8c382cb`.

With `AXTERM_PACKAGED_APP` pointed at this exact app, `bun run
test:ssh:packaged` repeated the real OpenSSH integration and source B-12
journey, then passed the packaged SSH authentication/Host Key/PTY/SFTP and
persisted-bookmark journey. The same app passed the full `test:packaged` suite:
**17 macOS-applicable journeys passed, 10 platform/optional-fixture journeys
skipped**. After both fixture wrappers exited, no labelled fixture container
or `axterm-ssh-fixture-net-*` network remained.

This is a current-source controlled SSH peer and unsigned directory-app
result, not an independently operated SSH provider, final signed DMG,
Windows/native-Linux transfer peer, or source-rights approval. IR-03 remains
**In progress** and IR-13 remains **Open**.
