# IR-03 external terminal-transfer peer availability — 2026-09-21 (updated 2026-09-23)

## Scope

IR-03 requires interoperability evidence beyond Axterm-controlled Node peers,
loopback SSH and packaged macOS journeys. This record preserves the original
host-availability finding and the subsequent, reproducible external `lrzsz`
and `trzsz-go` Docker-PTY runs. It is not a source-rights review, an external
SSH-host test or a release acceptance claim.

## Observed local condition

On the macOS arm64 verification host, `command -v` found none of the ordinary
external terminal-transfer client/server commands:

```text
rz, sz, rx, sx, rb, sb, lrz, lsz, trz, tsz: absent
```

This means a test which directly invokes host commands cannot honestly claim to
exercise an independently distributed `lrzsz`/`rzsz` or `trzsz` peer. The
current protocol tests remain valuable Axterm/Node-peer and controlled-local-
OpenSSH evidence, but they do not become external-tool interoperability merely
by renaming the peer or copying a test fixture. The fixed-digest container
evidence below is separate: it invokes Debian's independently packaged command
inside a PTY rather than relabeling an Axterm fixture.

## Container peer discovery result

The already-local Alpine 3.24 OpenSSH fixture was also inspected: it contains
neither `lrzsz` nor `trzsz`. Its configured Alpine main/community package-index
query produced no matching package record. A separate temporary
`debian:bookworm-slim` probe successfully fetched the image but its `apt-get`
metadata request remained silent for more than 60 seconds, so it was stopped
and automatically removed without installing a package. That attempt did not
prove that either distribution never ships a suitable tool. The later
fixed-digest probe below corrected its temporary-directory configuration and
obtained exact signed-package metadata; it supersedes only the Debian
availability conclusion, not the Alpine finding or the absent host commands.

No container image or peer package was added to Axterm's lockfile, production
dependencies or release payload. The later test downloads the package only to
a newly created OS-temporary directory, verifies its hash before use, installs
it only in an automatically removed test container, and removes the temporary
directory after the suite.

## Reproducible external `lrzsz` Docker peer — 2026-09-22

Docker Desktop's Linux arm64 engine had the following pre-existing exact
multi-architecture base-image index locally available:

```text
debian@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
```

The image's signed Debian source configuration uses `bookworm` / `main` from
`http://deb.debian.org/debian` with Debian's archive keyring. The
`linux/arm64` image manifest is
`sha256:0c8bbb6b8d7de3f296bb11b68318f6d4d3140d9b99609a8b73c5593a13b98940`
and the `linux/amd64` manifest is
`sha256:f3034a6ec3c1205360777c4aae76234998866ad18806ae62b63a3f84ccad782b`.
In a `--rm`, `--read-only` provisioning container with writable `tmpfs` only
for APT's runtime directories, a bounded-retry metadata query returned these
peers:

```text
platform: linux/arm64
package: lrzsz_0.12.21-10_arm64.deb
version: 0.12.21-10
repository: bookworm/main arm64
package SHA-256: e2935271e50ca6d53cd6b6daa2a7251aad136e8b2b193aedbf4570eaf3dc5c31

platform: linux/amd64
package: lrzsz_0.12.21-10+b1_amd64.deb
version: 0.12.21-10+b1
repository: bookworm/main amd64
package SHA-256: 60c15258a977b837671f99f60a7876b1dfa7cebd9ed1a7dcd16d922b6e1b9cfe
```

The `.deb` was downloaded, hashed and unpacked without installing it on the
host. It supplies `rb`, `rx` and `rz` with SHA-256
`d3985f9b96dc9d341db33b3fbf62748edbd264c013655ea80623dc5761b726e5`, and
`sb`, `sx` and `sz` with SHA-256
`ea2633598bf28a2dedca29818bac08c2f0fe93f904d504a74ef27ffe28f1edde`.
Its Debian copyright file names Chuck Forsberg, Matt Porter, Michael D. Black
and Uwe Ohse and grants redistribution under GNU GPL version 2; this evidence
therefore records the peer as **GPL-2.0-only**, not as an Axterm-distributed
component.

`packages/runtime/src/adapters/terminal-transfer/external-lrzsz-pty.test.ts`
is opt-in (`AXTERM_EXTERNAL_LRZSZ=1`) so the normal source gate does not gain a
Docker/network prerequisite. The successful commands were:

```text
AXTERM_EXTERNAL_LRZSZ=1 bunx vitest run packages/runtime/src/adapters/terminal-transfer/external-lrzsz-pty.test.ts
AXTERM_EXTERNAL_LRZSZ=1 AXTERM_EXTERNAL_PEER_PLATFORM=linux/amd64 bunx vitest run packages/runtime/src/adapters/terminal-transfer/external-lrzsz-pty.test.ts
```

On this macOS arm64 host, both selected Linux peer architectures passed all
four 16,389-byte binary transfer directions:

1. Debian `sz` → Axterm ZMODEM receiver;
2. Axterm ZMODEM sender → Debian `rz`;
3. Debian `sx --1k` → Axterm XMODEM-1K receiver; and
4. Axterm XMODEM-1K sender → Debian `rx`.

The same opt-in suite then passes an Axterm-issued cancel against the external
`sz` ZMODEM and `sx --1k` XMODEM-1K download peers on both architectures. Each
peer exits nonzero, the local session ends, and no final downloaded file is
published. Each platform-selected run has six passing tests.

The actual transfer containers run with `--network none`; only the disposable
provisioning step has network access to obtain the already hash-pinned Debian
package. Each transfer has a unique Docker label, and the test queries Docker
after `finally` cleanup to prove no container carrying that label remains.

This is genuine external-peer evidence for the four stated lrzsz directions,
but its scope is local Docker Linux arm64 and amd64 peers reached through a
local PTY. It is not an independently operated remote host, a
macOS/Windows/Linux installed-product test, or external-peer timeout and
failure-direction evidence. The two successful cancel paths are not evidence
for all cancellation directions or for timeout behavior. The separate TRZSZ
peer evidence follows below.

## Reproducible external `lrzsz` peer through an SSH PTY — 2026-09-22

`packages/runtime/src/adapters/terminal-transfer/external-lrzsz-ssh-pty.test.ts`
extends the same hash-pinned Debian `lrzsz` packages into a real encrypted SSH
shell channel. It connects the production `Ssh2Transport` to an ephemeral
loopback `ssh2` server, and that server bridges its SSH PTY byte-for-byte to a
separate `docker run` process executing the external Debian `sz`, `rz`, `sx` or
`rx` binary. The peer process selects the same fixed image index, package hashes and
`linux/arm64` / `linux/amd64` assets recorded above; its transfer container has
`--network none` and a unique label which is checked after cleanup.

The suite is separately opt-in so default source and candidate gates do not
gain a Docker or network prerequisite. The successful commands were:

```text
AXTERM_EXTERNAL_LRZSZ_SSH=1 bunx vitest run packages/runtime/src/adapters/terminal-transfer/external-lrzsz-ssh-pty.test.ts
AXTERM_EXTERNAL_LRZSZ_SSH=1 AXTERM_EXTERNAL_PEER_PLATFORM=linux/amd64 bunx vitest run packages/runtime/src/adapters/terminal-transfer/external-lrzsz-ssh-pty.test.ts
```

Each platform-selected run passed sixteen tests: Debian `sz` → Axterm ZMODEM
download, Axterm ZMODEM upload → Debian `rz`, both ZMODEM cancellation
directions, Debian `sx --1k` → Axterm XMODEM-1K download, Axterm XMODEM-1K
upload → Debian `rx`, and both XMODEM cancellation directions. Each
cancellation asserts no final file publication. The ninth test first receives
an actual external `sz` handshake through the production transport, then uses
the product session's controlled clock to advance its fixed 60-second
destination-selection deadline. It records `session-timeout` and `session-end`,
sends ZMODEM cancel to the external peer, observes its nonzero exit and proves
that the empty destination directory remains empty. The tenth test confirms an
external `sx` peer is running, advances Axterm XMODEM's fixed 110-second
no-destination retry window, then requires `session-error` and `session-end`, a
nonzero cancelled-peer exit and an empty destination directory. The test closes
the SSH channel, transport, spawned peer and server in `finally`; it then
proves that no labelled Docker container remains. This is source-level evidence
that the external published peer interoperates through Axterm's production SSH
transport and an actual PTY, not merely through a local direct-PTY test.

The eleventh test retains the same external `sz` handshake and then selects a
real writable destination. It intentionally withholds subsequent peer frames
from the Axterm protocol engine while continuing to drain the SSH channel, then
advances the product's fixed 60-second peer deadline. It requires
`session-timeout`, `session-end`, an inactive session and an empty destination
directory. Fixture shutdown owns the unreachable peer; the cleanup assertion
waits up to two seconds for the uniquely labelled Docker container to disappear.
The twelfth test selects a real destination, waits until Axterm's hidden
`.part` staging file contains bytes received from the external peer, then
terminates the SSH fixture and its external `sz` peer. The channel exit destroys
the product session; its partially received staged file is removed and the
destination directory remains empty. This is real controlled peer-exit cleanup
coverage for partial staged output, not malformed-frame coverage or a
protocol-level partial-file error with a still-open channel.

The thirteenth test performs the corresponding XMODEM-1K receive case: a
selected external `sx` peer must first write nonzero bytes into Axterm's hidden
`.part` staging file. The test then terminates only that uniquely labelled peer
container, requires the real SSH terminal channel to exit nonzero, and verifies
that the product session removes the staged file without publishing a
destination. The container is observed absent after `finally`; this is
controlled peer-exit cleanup evidence, not malformed-frame or still-open-
channel failure coverage.

The fourteenth test starts the external `sx` peer, selects a real writable
destination and confirms the peer receives Axterm's CRC request. It continues
to drain the SSH channel but intentionally withholds later peer frames from the
product protocol engine, then advances the product's 110-second bounded retry
clock. The session must emit `session-error` and `session-end`, send cancellation
to the external peer, observe its nonzero exit, remove any staging state and
publish no destination. This is controlled external XMODEM selected-transfer
silence coverage, not a malformed-frame or still-open-channel partial-file
failure.

The fifteenth test starts that same actual external `sx` peer, confirms that a
selected destination contains nonzero Axterm `.part` staging bytes, then flips a
later peer payload byte **in transit** while the SSH channel and peer remain
open. Every retransmission of that corrupted external frame receives Axterm's
NAK until the bounded retry limit emits `session-error` and `session-end`; the
peer then receives `CAN CAN`, exits nonzero, the staging file is removed and no
destination is published. This is controlled external XMODEM malformed-frame
coverage through a real Debian peer and production SSH/PTY transport. It does
not claim that the upstream `sx` binary naturally emitted a bad frame, nor does
it cover an arbitrary still-open-channel partial-file failure unrelated to the
controlled XMODEM/ZMODEM/TRZSZ byte faults below.

The sixteenth test starts an actual external `sz` peer, confirms that a
selected destination contains nonzero Axterm `.part` staging bytes, then
changes later ZMODEM bytes **in transit** while the SSH channel and external
peer remain open. Axterm emits `transfer-error` and `session-end`, sends its
ZMODEM cancellation sequence, removes staging, publishes no destination and
the external peer exits nonzero. This is controlled external ZMODEM
malformed-frame coverage through a real Debian peer and the production
SSH/PTY transport. It does not claim that upstream `sz` naturally emitted an
invalid frame.

The default provisioner still downloads the package into a disposable fixture
through Debian APT. On runners where the full APT index cannot arrive within the
bounded 40-second hook, an operator may set `AXTERM_EXTERNAL_LRZSZ_DEB` to a
separately acquired **temporary** Debian package. The test copies it only into
its own temporary root and verifies the same platform-specific SHA-256 above
before `dpkg --install` in the network-isolated peer container. On this host,
directly acquired arm64 and amd64 packages matched those hashes; the direct PTY
suite passed 6/6 and this SSH-PTY suite passed 16/16 for each architecture.
Neither input becomes a repository file, lockfile entry, production dependency
or release artifact. This removes an APT-index environmental flake without
relaxing peer-binary provenance or hash verification.

The SSH server is deliberately an in-process, controlled loopback fixture with
an ephemeral key and no user credentials. It is therefore **not** an
independently operated SSH target, a host-key approval test or a packaged
application test. The selected ZMODEM incoming-data-loss and ZMODEM/XMODEM
peer-exit cases plus the controlled in-transit XMODEM/ZMODEM malformed-frame
cases do not cover arbitrary partial-file protocol failures that keep the
channel open. Independently operated-host and packaged-platform evidence also
remain open.

## Reproducible external `trzsz-go` Docker peer — 2026-09-22

The official `trzsz/trzsz-go` GitHub v1.2.0 release provides the Linux arm64
archive `trzsz_1.2.0_linux_aarch64.tar.gz` (SHA-256
`9a73c237b6b12af267e878591ff22a01c97ca9d1cd8125f9ff4ffd6df4fea97c`) and
the Linux amd64 archive `trzsz_1.2.0_linux_x86_64.tar.gz` (SHA-256
`70e3e0847177d4c7b681a8ec19fa00092e422a6c628ef9d8a5db6dfbf4612add`). Each
asset is obtained only in a new OS-temporary directory and must match its
recorded SHA-256 before the test extracts and executes its `trz`/`tsz` binaries.
The assets do not contain their own `LICENSE` file, so the separately retrieved
official v1.2.0 tag's `LICENSE` is also recorded: it states MIT License, names
`Copyright (c) 2022-2026 The Trzsz Authors`, and has SHA-256
`30fbfa725e8534e0f14891463caa18acf797242ed834801b74d2fdb8476b7eda`.
This records the external test peer as **MIT**, not as an Axterm-distributed
component.

`packages/runtime/src/adapters/terminal-transfer/external-trzsz-pty.test.ts`
is independently opt-in (`AXTERM_EXTERNAL_TRZSZ=1`) and uses the same
fixed-digest Debian image index as the lrzsz test, selecting Linux arm64 by
default and Linux amd64 when explicitly requested. Its successful commands
were:

```text
AXTERM_EXTERNAL_TRZSZ=1 bunx vitest run packages/runtime/src/adapters/terminal-transfer/external-trzsz-pty.test.ts
AXTERM_EXTERNAL_TRZSZ=1 AXTERM_EXTERNAL_PEER_PLATFORM=linux/amd64 bunx vitest run packages/runtime/src/adapters/terminal-transfer/external-trzsz-pty.test.ts
```

Each platform-selected suite covers a 16,388-byte binary download from the
external `tsz` peer and a byte-exact upload to external `trz`. It also cancels
an external `tsz` download before choosing a destination: no file is published,
the Axterm session ends and upstream `tsz` exits with status 0, which is its
observed graceful-cancel behavior rather than an error result. Actual transfer
containers have `--network none`, each has a unique Docker label, and the suite
verifies no container with its label remains after `finally` cleanup. The
downloaded archive and all extracted binaries are removed with the temporary
directory after the suite.

This extends external-peer directions and receive-side cancellation to TRZSZ,
but remains local Docker Linux arm64 and amd64 PTY evidence. It does not add
remaining TRZSZ cancellation directions, timeout or failure coverage,
remote-host trust, installed-product validation or source-rights approval for
Axterm's separately shipped `trzsz2` dependency.

## Reproducible external `trzsz-go` peer through an SSH PTY — 2026-09-22

`packages/runtime/src/adapters/terminal-transfer/external-trzsz-ssh-pty.test.ts`
extends the same hash-pinned official v1.2.0 `trzsz-go` assets into a real
encrypted SSH shell channel. It connects production `Ssh2Transport` to an
ephemeral loopback `ssh2` server, and that server bridges its SSH PTY byte-for-
byte to a separate no-network `docker run` process executing the selected
external `tsz` or `trz` binary. The peer process selects the same fixed image
index, MIT-license source and `linux/arm64` / `linux/amd64` asset hashes recorded
above; each transfer has a unique Docker label checked after cleanup.

The suite is separately opt-in so default source and candidate gates do not
gain a Docker or network prerequisite. The successful commands were:

```text
AXTERM_EXTERNAL_TRZSZ_SSH=1 bunx vitest run packages/runtime/src/adapters/terminal-transfer/external-trzsz-ssh-pty.test.ts
AXTERM_EXTERNAL_TRZSZ_SSH=1 AXTERM_EXTERNAL_PEER_PLATFORM=linux/amd64 bunx vitest run packages/runtime/src/adapters/terminal-transfer/external-trzsz-ssh-pty.test.ts
```

Each platform-selected run passed seven tests: external `tsz` → Axterm TRZSZ
download, Axterm TRZSZ upload → external `trz`, an Axterm-issued cancellation
of external `tsz`, and an Axterm-issued cancellation of upload to external
`trz`. Both cancellation directions assert that no final file is published.
The fifth test first receives an external `tsz` handshake through the
production transport, advances the fixed 60-second destination-selection
deadline under a controlled clock, observes `session-timeout` and `session-end`,
and verifies that the empty destination directory remains empty. The external
`tsz` peer observes the sent interrupt and exits with status 0, its documented
graceful cancellation behavior. The sixth test selects a writable destination,
waits until the external `tsz` peer has written nonzero bytes to Axterm's hidden
`.part` staging file, then closes the SSH fixture and peer. Terminal-channel
exit destroys the product session, removes the staged bytes and leaves no
published destination. Each test closes the SSH channel, transport, spawned
peer and server in `finally`; it then proves that no labelled Docker container
remains. This is source-level evidence that the official external peer
interoperates through Axterm's production SSH transport and an actual PTY, not
merely through a local direct-PTY test.

The seventh test selects a writable destination, waits until the external
`tsz` peer has written nonzero bytes into Axterm's hidden `.part` staging file,
then changes a later encoded `#DATA:` payload character **in transit** while
leaving the peer and SSH channel open. The product stops accepting transfer
bytes, sends the same terminal cancellation byte used by explicit TRZSZ
cancellation, emits `session-error` and `session-end`, removes staging and
publishes no destination; the external peer observes that cancellation and
exits status 0. This is controlled external TRZSZ malformed-frame coverage,
not a claim that the upstream `tsz` binary naturally emitted invalid data.

The SSH server is deliberately an in-process, controlled loopback fixture with
an ephemeral key and no user credentials. It is therefore **not** an
independently operated SSH target, a host-key approval test or a packaged
application test. The TRZSZ destination-selection timeout, staged-byte peer
exit and controlled in-transit malformed-frame cases do not cover an arbitrary
non-channel-close partial-file failure after a selection. They also do not
establish an independently operated host or packaged-platform evidence; those
distinct gaps remain open.

## Runtime-destruction cleanup symmetry — 2026-09-22

The default source protocol suite now covers direct Runtime destruction after
nonzero selected-receive staging for XMODEM, ZMODEM and TRZSZ. XMODEM accepts a
valid CRC frame, ZMODEM receives from a real `zmodem2` sender, and TRZSZ receives
from a real `trzsz2` transfer peer. Each fixture invokes the active session's
`destroy()` while the corresponding peer or terminal channel is still open,
rather than substituting a malformed frame, explicit user cancellation or
channel exit. Every session becomes inactive, removes its hidden `.part` file,
publishes no destination and emits no file/session-completion event. The three
focused protocol files pass 31 tests together.

This proves source-level host/runtime-supervision cleanup symmetry. It does not
turn the in-process XMODEM frame into an independently distributed peer, and it
does not add installed-platform, independently operated SSH or source-rights
evidence. Those requirements remain part of the unblocking record below.

## Still-open-channel staging-path loss — 2026-09-22

The default source protocol suite now also covers one deterministic local
filesystem failure after a destination is selected and nonzero bytes are
staged, without closing the terminal channel or protocol peer. On POSIX, each
test removes the hidden `.part` pathname while its already-open file handle
remains valid, then lets the transfer continue:

- XMODEM accepts a second valid CRC block and reaches EOT;
- the real in-process `zmodem2` sender resumes its remaining file bytes; and
- the real in-process `trzsz2` sender resumes after its held acknowledgement.

In all three cases publication fails because the staging pathname no longer
exists. The adapter emits its error and session-end events, sends the protocol
cancellation sequence to the still-live peer, becomes inactive, publishes no
destination and leaves no staging pathname. The three focused files pass 34
tests together. This is source-level staging-namespace-loss/finalization
coverage. It does not prove disk-full or permission failure, Windows open-file
unlink semantics, behavior against an independently distributed peer, an
installed package or source-rights approval.

## Deterministic partial-write failure cleanup — 2026-09-23

The default source protocol suite now covers `ENOSPC`, `EACCES` and `EIO`
destination-write failures for XMODEM, ZMODEM and TRZSZ while the protocol peer
or terminal channel remains open. Each production receive writer has a narrow
injectable filesystem-write boundary whose default still calls the real Node
file descriptor or `FileHandle`. For each of the nine protocol/error pairs, the
regression uses that same boundary to write the first 64 bytes into the real
hidden same-directory `.part` file and then throws the selected error code on
the immediately following write. This proves every failure occurs after bytes
have reached the filesystem, rather than before the destination is opened.

All three adapters emit their protocol error and session-end events, signal
cancellation to the still-live peer, become inactive, publish no final file and
remove the partially written staging file. The focused XMODEM, ZMODEM and TRZSZ
protocol files pass 43 tests together; the full terminal-transfer directory
passes 78 tests with 32 opt-in/platform tests skipped. Type checking and the
368-module / 1,313-dependency Level 1 architecture gate also pass.

This is deterministic source-level partial-write cleanup evidence. It does not
claim that a physical volume was filled, exercise a real filesystem ACL, quota
or mount failure, use an independently distributed peer for this exact fault,
or validate installed macOS/Windows/Linux packages. Those release-evidence
requirements remain open.

## Same-clone external-peer candidate — 2026-09-23

The 2026-09-23 `bun run candidate:protocol:check` run additionally placed the
already documented independent Debian `lrzsz` and official `trzsz-go` SSH/PTY
suites **inside the same audited, frozen-installed clean clone** as the full
source gate and controlled OpenSSH fixture. On the macOS arm64 host with Linux
arm64 peers, `lrzsz` passed 16/16 and `trzsz-go` passed 7/7. The ordinary
`candidate:check` still skips both opt-in suites. The first protocol-candidate
attempt timed out while fetching Debian's APT index; the successful gate used
the official direct `.deb` URL plus the unchanged pinned SHA-256 check and
removed that package with its disposable candidate root. This removes an
evidence-location and APT-index flake, not the platform or independently
operated-host limits listed below. The exact tree and temporary commit are
recorded in the [IR-12 clean-clone record](IR12-EPHEMERAL-GIT-CANDIDATE-2026-09-21.md).

## Linux CI peer-gate preparation — 2026-09-23

The 2026-09-23 Linux CI workflow now has explicit post-OpenSSH steps for both
independent SSH/PTY peers. It pulls the fixed Debian image digest and downloads
the fixed amd64 `lrzsz` package into the runner's temporary directory; the
existing test verifies that package's pinned SHA-256 before any peer starts.
The official `trzsz-go` release archive retains its own pinned SHA-256 check.
These are configured CI steps, **not yet a remote CI result**.

Local macOS-hosted `linux/amd64` replay exposed a narrow fixture race in the
selected `sz` peer-exit case: closing the SSH/PTY wrapper could kill the local
`docker run` client before its uniquely labelled `--rm` container had exited.
The product session had already become inactive and removed its nonzero `.part`
stage. The test now explicitly reclaims only that unique peer container in
`finally`, then retains the no-container assertion. Three consecutive
independent amd64 `lrzsz` runs passed 16/16 and left no labelled containers;
one amd64 `trzsz-go` run passed 7/7. This is local Docker evidence and fixture
cleanup hardening, not a native Linux installation, remote CI receipt or
independently operated SSH-host result.

## Required unblocking evidence

Before closing this gap, a release owner or test operator must supplement the
recorded lrzsz/trzsz-go directions with an independently distributed peer on
each supported platform, or an independently operated SSH target that exposes
one. The resulting evidence must record:

1. The exact command(s), version, distribution source, license and binary or
   package hash (recorded above only for Debian arm64/amd64 lrzsz and
   trzsz-go);
2. The controlled remote identity, host-key trust decision and cleanup method
   without recording credentials or private paths;
3. Binary upload/download, cancellation, timeout and failure behavior for each
   applicable XMODEM, ZMODEM and trzsz direction. The record currently has
   lrzsz and trzsz-go binary directions plus receive-side ZMODEM/XMODEM/TRZSZ
   cancellation; it also has ZMODEM, XMODEM-1K and TRZSZ external-peer
   directions plus both cancellation directions through controlled SSH PTYs.
   It now also has XMODEM, ZMODEM and TRZSZ external destination-selection
   timeouts through those SSH PTYs, plus XMODEM, ZMODEM and TRZSZ selected-
   transfer peer-exit cleanup after staged bytes and ZMODEM incoming-data-loss
   cleanup. The source suite additionally covers a real 64-byte partial stage
   followed by deterministic `ENOSPC`, `EACCES` and `EIO` write failures for
   all three protocols while the peer/channel remains open.
   External-peer malformed-frame coverage now includes selected XMODEM,
   ZMODEM and TRZSZ external-peer bytes deliberately corrupted in transit
   after staging bytes exist. The source suite additionally covers staging-path
   loss while all three in-process protocol peers remain open. Native upstream
   bad-frame behavior, actual exhausted-volume/quota and write-permission
   failures, and other arbitrary non-channel-close partial-file failures after
   a selection remain;
   and
4. Platform scope separately for macOS, Windows and Linux installed packages.

The Docker fixtures satisfy the base-image digest, package repository or
official release source, version, license-source and binary/package-hash
recording rule for their narrow Debian arm64/amd64 lrzsz/trzsz-go scopes. A network
retry alone remains insufficient evidence.

The peer must not be introduced as an Axterm production dependency solely to
make this test pass. Until that evidence and the separate `zmodem2`/`trzsz2`
source-rights review exist, IR-03 remains **In progress**.
