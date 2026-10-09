# Axterm support policy — pre-release status

Status: **no public commercial support commitment has been approved**

Axterm has not yet published a stable commercial distribution. Consequently,
this repository does not promise an email address, support portal, service
hours, response target, migration assistance level or supported-version window
that an owner has not actually staffed.

Before public release, the release owner must publish and approve a support
policy covering at least:

- installation and platform scope;
- supported versions and upgrade policy;
- the unpublished prototype's manual data-exit path, backup/recovery guidance
  and the removed compatibility paths; and
- public contact routes, service hours and response expectations.

For the later Mac/manual-update release, verify the public support route and
record its URL, scope and owner approval in the external MCR-03/MCR-04 evidence.
The fuller three-platform route also records non-sensitive facts in
[`RELEASE_SERVICE_RECORD.json`](compliance/RELEASE_SERVICE_RECORD.json) and passes
`bun run release:services:active-check`. Its current `pending` state is not a
support offer. That later check does not replace rights, signing, installed-app
or platform evidence; an automatic-update feed is a separate future gate.
