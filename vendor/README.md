# Vendored upstream sources

## electerm

- Upstream: https://github.com/electerm/electerm
- Location: `vendor/electerm` (Git submodule, not a Bun workspace)
- Initial revision: `799bedef98c1deae676ae03041719de98d3b57f1`
- License: MIT; copyright and license retained in `electerm/LICENSE`.
- No electerm product code is copied into Axterm in Phase 0.

Clone and restore the exact recorded revision:

```sh
git clone --recurse-submodules <axterm-repository-url>
# For an existing checkout:
git submodule update --init --recursive
```

The parent repository records the exact gitlink commit. Do not use an unreviewed
`git submodule update --remote` as part of installation or CI. Updating upstream
is a deliberate change to that gitlink, reviewed together with adaptations.

## Reuse workflow

Start feature work by looking for the corresponding electerm implementation and
tests. Reuse or adapt suitable code rather than unnecessarily reimplementing it.
Copy adapted code into the appropriate Axterm layer, retaining the upstream
copyright/license and recording source path, commit and local changes in
`docs/implementation/UPSTREAM.md`. Type it strictly and add Axterm contract and
lifecycle tests. Keep the submodule clean so upstream changes remain easy to review.

Examples of destinations:

| Upstream responsibility | Axterm destination |
| --- | --- |
| PTY / SSH / SFTP vendor integration | Runtime adapters behind Application interfaces |
| Host configuration validation | Runtime Domain + public Zod schemas |
| Terminal rendering / UI behavior | Renderer components using the generated Client |
| Native dialogs, credentials, app lifecycle | Desktop Host capabilities |

Reuse does not change MASTER_SPEC: no business Electron IPC, no backend vendor
objects in Renderer, no Main business workflows, no unbounded terminal buffers,
no saved plaintext credentials, and no accept-all SSH host keys. Vendor sources
are excluded from our formatter/test/build scans and are not shipped wholesale.
