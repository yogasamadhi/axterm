# Profile package owner

`ctx.pluginManager` owns Profile package changes. It uses the shipped pnpm
11.28.5 and application Node/RunAsNode executable through `ctx.subprocess`.
Installation disables lifecycle scripts and pnpmfile hooks. Registry inspection
does not load package code. The default source is `https://registry.npmjs.org/`;
there are no default fallback sources.

An online change serializes with HMR and the Profile manifest lock. It awaits
actual plugin disposal before deleting package files. A higher home/launch layer
can override an entry switch; the result reports `overridden`. A Host without HMR
reports `restart-required` and retains loaded implementation files. Replacing an
existing package in that running Host returns `changed: false` with
`offline-upgrade-required`; quit it and upgrade with the CLI. Cleanup errors
reported by the fixed Cordis lifecycle leave the manager unavailable and Desktop
task inspection active. Restart into recovery before repairing that Profile.

Transactions back up package.json, pnpm-lock.yaml, cordis.patch.yml and
pnpm-workspace.yaml. Interrupted transactions remain visible and block later
mutations. Offline repair restores only these validated files and installs from
the existing cache with hooks and scripts disabled. It never restores user data
or replays plugin work. Removal preserves application/plugin data.

Builds require a separate explicit action for the exact installed source and
version. `pendingBuilds()` returns opaque identities, names and versions;
`approveBuilds(ids, true)` rebuilds only those identities using the application
Node wrapper. A different version or source has a new identity. pnpm's pinned
layout-5 pending-build cache is updated only after a successful, fully joined
rebuild. A failed build retains its transaction for offline repair.

After Desktop exits, the distributed CLI shares its Profile runtime lock:

```sh
axterm plugin --profile desktop list
axterm plugin --profile desktop inspect ./plugin.tgz
axterm plugin --profile desktop add ./plugin.tgz --disabled
axterm plugin --profile desktop enable @example/plugin
axterm plugin --profile desktop disable entry-id --entry
axterm plugin --profile desktop upgrade ./plugin-next.tgz
axterm plugin --profile desktop builds
axterm plugin --profile desktop approve-builds exact-build-id --confirm
axterm plugin --profile desktop remove @example/plugin
axterm plugin --profile desktop transactions
axterm plugin --profile desktop repair transaction-uuid
```

CLI management does not start a server, activate Profile code, open the product
database or initialize the Vault. External plugins run with application permissions.
This foundation does not certify the remaining Remote/UI, market, model approval
entry, external UI/Engine journeys or native recovery acceptance.
