# Axterm security reporting — pre-release status

Status: **no public commercial release and no approved public security-reporting
channel yet**

Do not put vulnerability details, credentials, private keys, user data, support
logs or reproduction artifacts containing sensitive data in public issues,
pull requests, release notes or this repository's evidence records.

The current source tree deliberately does not invent an email address, ticket
portal or response-time promise. A public distribution is blocked until the
release owner publishes all of the following as externally reachable,
owner-approved facts:

1. at least one private security-reporting route;
2. a coordinated-disclosure policy;
3. supported-version and security-fix policy; and
4. scope, acknowledgement and response expectations that the responsible team
   can actually meet.

For the later Mac/manual-update release, publish and verify those facts through
the private reporting route and record the public policy URL and owner approval
in the external MCR-03/MCR-04 evidence. The fuller three-platform route also
records the non-sensitive facts in
[`RELEASE_SERVICE_RECORD.json`](compliance/RELEASE_SERVICE_RECORD.json) and passes
`bun run release:services:active-check`. Neither a template nor a check proves
that the reporting route is actually staffed.

This pre-release statement is not a substitute for product security testing,
source-rights review, a signed installer, a supported version, or a commitment
that a particular repository host has enabled private vulnerability reporting.
