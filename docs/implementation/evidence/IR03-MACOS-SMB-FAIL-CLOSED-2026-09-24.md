# IR-03 macOS SMB mounted-volume publication — 2026-09-24

Status: **fail-closed engineering evidence on macOS mounts backed by two independent loopback SMB2 servers; IR-03 remains In progress**.

## Impacket fixture and scope

- Host: macOS 27.0 arm64, Bun 1.4.0, Node 24.18.0.
- A temporary directory was exported by the separately installed, test-only
  [Impacket `smbserver.py`](https://github.com/fortra/impacket/blob/master/examples/smbserver.py)
  at version `0.12.0`, with Python 3.12 and `setuptools==80.9.0`. It listened
  only on host `127.0.0.1:1445`, used SMB2 support and an empty guest account.
- A disposable `node:24.18.0-alpine` container forwarded host-loopback
  `127.0.0.1:445` to that test server. The local image's repository digest was
  `sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd`.
  No Impacket source, credential, or release dependency was added to Axterm.
- macOS mounted `//guest:@127.0.0.1/AXTERMTEST` with `nobrowse,nopassprompt`.
  The mount table identified the selected destination as **`smbfs`** with
  `nodev,nosuid,noowners,nobrowse`; this was not an APFS directory merely named
  after SMB.

The experiment only operated on fresh temporary directories inside this share.
A same-directory `node:fs` hard-link probe returned `ENOTSUP`. The existing
native `@openclaw/fs-safe@0.13.1` `rename-noreplace` publication then returned
`Operation not supported (os error 45)` on the mounted share. A deliberately
run _success-path_ test with `AXTERM_REAL_NOHARDLINK_DIRECTORY` failed at that
native rename; that failed diagnostic is not counted as a passing test. It
established that the successful FAT16 result cannot be generalized to SMB.

## Verified fail-closed path

With `AXTERM_REAL_NO_REPLACE_DIRECTORY` set to the real `smbfs` mount:

- `bunx vitest run packages/runtime/src/adapters/terminal-transfer/staged-file-publication.test.ts`
  passed **8 tests, 1 conditional skip**. Its real-volume case verified that
  no final file was created after publication failed; an existing destination
  retained its bytes and the complete private source remained available for
  error handling.
- The same environment across the staged-publication, XMODEM, ZMODEM and TRZSZ
  protocol files passed **60 tests, 1 conditional skip**. Each real-volume
  receive reported the path-free `TRANSFER_DESTINATION_UNSUPPORTED` failure,
  did not signal file completion, and removed the transfer staging name.
- `bun run build` succeeded, then an isolated, **unsigned** macOS arm64
  `package:dir` was built outside the checkout. Its `app.asar` SHA-256 was
  `e49282e7b283deab3bd05633e4008f114058e6115eb5eeefd49d63271f544c3d`;
  its unpacked macOS native binding SHA-256 was
  `78ca69b52d05da239bf50a6768867134265aace0195c8494f64f65b6d1ba6db0`.
- The three packaged Electron local-PTY journeys passed **3/3** against that
  same SMB mount: TRZSZ, ZMODEM and XMODEM each displayed the localized
  unsupported-destination guidance, entered `failed`, and left neither a
  completed payload nor an application `.part` file in its selected directory.
  The environment-gated packaged test was renamed from ExFAT-specific wording
  to the actual generic unsafe-real-volume condition; it remains usable for
  both filesystem classes without claiming they share implementation details.
- After the test-label and evidence changes, `bun run check` passed: 1,178
  unit/integration tests (38 skipped), 360 architecture modules / 1,310
  dependencies, 267 Contract operations and 11 visual/accessibility journeys.

After the tests, both the mounted and backing shares were empty. The SMB mount
was detached, the loopback proxy and server were stopped, and the three exact
temporary mount/share/package directories were removed. No test service or
mount remained active. The deleted directory app was a reproducible local test
artifact, not a retained or signed release candidate.

## Samba 4.21.9 cross-check

To avoid treating the test-only Impacket server as representative of SMB, a
second, independently implemented server was built from
[`tests/fixtures/samba/Dockerfile`](../../../tests/fixtures/samba/Dockerfile)
and [`smb.conf`](../../../tests/fixtures/samba/smb.conf). The fixture pins
Alpine 3.22 base digest
`sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce`
and Alpine `samba-server=4.21.9-r1`; the built local image ID was
`sha256:7af86c5ac71a6dc37ea614c4ced9a91c794ad263b96db04e6d1ee3c1745bb500`.
The Dockerfile and config SHA-256 values were, respectively,
`b8e545ed49c76d3a7174b5e351b477b6488c8855cf1f0e2c0ced6fabbf17496d`
and `01d654b3e214b3d861ad55dc849df815ec7bda208e753b2a2cd41c9fa10a2cde`.
Only host `127.0.0.1:445` was published, and the share lived on a disposable
container tmpfs. The test host's container network needed its existing local
HTTP proxy passed as a Docker build argument to obtain Alpine packages; no
proxy endpoint or credential is committed to the fixture.

The first Samba configuration mounted but returned `EACCES` when writing into
a newly created child directory. Inspection showed the server-side child mode
was `0755`, so this was not evidence of atomic-publication behavior. The
test-only guest share now forces writable directory mode; a fresh build and
mount could create an ordinary file inside the child directory. This fixture
setting is not an application permission policy and must never be copied to a
production file share.

On the corrected Samba mount, macOS again reported `smbfs`. Same-directory
`node:fs` hard linking returned `ENOTSUP`; the real-volume no-replace path
passed all four targeted Runtime/protocol tests, confirming native publication
also failed closed rather than writing a partial final file. The combined four
files passed **60 tests, 1 conditional skip**. A newly built, unsigned macOS
arm64 directory app then passed the three local-PTY TRZSZ/ZMODEM/XMODEM
unsupported-destination journeys **3/3** against this Samba mount. Both the
mounted and container backing share were empty afterward. This package's
`app.asar` SHA-256 was
`223be40b82e42b751b17de12e62cc664323d0efd72a8865f2ebc704202d42505`;
the unpacked native binding was the same
`78ca69b52d05da239bf50a6768867134265aace0195c8494f64f65b6d1ba6db0`.
The mount was detached; the container, local image tag and exact temporary
mount/package directories were removed.
The complete `bun run check` passed with the two fixture source files present:
1,178 tests passed (38 skipped), 360 architecture modules / 1,310
dependencies, 267 Contract operations, the independent source snapshot and all
11 visual/accessibility journeys.

This proves failure containment only for the tested Impacket and Samba SMB2
servers with this macOS client. It does **not** prove successful transfer to SMB, all SMB
server dialects or permissions, NFS, crash durability, an independently
operated remote filesystem, signed/notarized distribution, source rights, or
Windows/native-Linux behavior. The fail-closed behavior is intentional: a
copy-to-final-name fallback would expose partial destination bytes. IR-03 and
IR-13 remain unaccepted.
