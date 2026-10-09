# Final public snapshot exception record

This template is used only when a release owner has separately approved keeping
one historical migration document in the final public source candidate. It is
not an approval, a license conclusion, a trademark conclusion or a substitute
for source-rights review. It does not establish independent authorship.

Copy [PUBLIC_SNAPSHOT_EXCEPTION_TEMPLATE.json](PUBLIC_SNAPSHOT_EXCEPTION_TEMPLATE.json)
to an owner-controlled location outside the public candidate, then add one
object per retained document. Each object must have these fields:

| Field               | Required value                                                                          |
| ------------------- | --------------------------------------------------------------------------------------- |
| `path`              | Snapshot-relative existing path below `docs/` only.                                     |
| `scope`             | `content`, `path` or `all`; use the narrowest scope that covers the retained reference. |
| `reason`            | Why that exact historical document must remain publicly available.                      |
| `approvedBy`        | Named accountable reviewer, not a placeholder role.                                     |
| `approvedAt`        | Approval date in `YYYY-MM-DD` format.                                                   |
| `approvalReference` | Durable link, ticket, signed record or archived decision reference.                     |

ADR-021 cancelled the public migration window and approved immediate removal of
the old compatibility paths. Use this exception procedure only when a later
release owner explicitly decides that a specific historical document belongs
in the public source snapshot:

```sh
bun run release:final-public:check
bun run release:final-public:check -- --exceptions /absolute/path/to/approved-record.json
```

This combined release gate first runs `migration:record:removal-check`, then
checks current dependency-attribution records, product-mark rights/brand
records, the four-language navigation/core review records and the public
privacy/security/support service record. Only then does it run the lower-level
`snapshot:final-public:check`. The latter fails on an unapproved legacy-name
occurrence in every retained file name or byte stream. It also rejects stale
exception entries, an invalid record, or an exception for any non-documentation
path. The ordinary `snapshot:check` is a source-hygiene check; neither command
can prove independent authorship, visual
similarity clearance, trademark clearance, signed artifact behavior or complete
source-rights review.
