# Runtime monitor source-lineage replacement — 2026-09-26

Status: **engineering replacement verified; final source-rights decision pending**.
This record concerns the current `terminal-information-model.ts` bytes only.
It does not clear other first-party code, translations, assets or package notices.

## Fixed inputs and finding

- Controlled reference: commit `799bedef98c1deae676ae03041719de98d3b57f1`,
  `src/client/components/remote-monitor/monitor-model.js`, SHA-256
  `d11450c3220f048b68a0eda5be69a99ba500d96862b385c47de1563eababf22a`.
  The unredacted original remains outside the new source root in the controlled
  archive; redacted historical documents are not provenance originals.
- Previous Axterm file at new-root commit `2f8fc44025d5673962f2707a5d1fc442d461e8b8`
  had SHA-256 `da1dc338b25e766202cde524f473efcef68b709d18995d618e4682923ecfe63f`.
  Its long shell network collector used the same interface loop, selected
  fields and line protocol as the fixed reference. CPU and memory parsing also
  retained similar expression. This was a concrete adaptation candidate, not
  just a shared standard command name.

## Current implementation

The Runtime now reads Linux `/proc/net/dev` counters and separately queries
`ip` for route, IPv4 address and link state. Axterm-specific section markers
bound the output format; the parser limits lines and interfaces, validates
counters, and continues to show counters when optional `ip` metadata is absent.
CPU usage is computed from two aggregate tick totals and their idle deltas;
memory reads only the required `/proc/meminfo` fields. The data sources and
field meanings are described by the [Linux kernel `/proc` documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html).
The public Terminal Information Contract and service boundary are unchanged.

Current source SHA-256: `31e1f105ef927fdd8576910c66dac11c5f6dd070c7e1e2583b5a3439cc2e91a9`.
A bounded TypeScript token screen normalized string and numeric literals,
compared unique 10-token shingles with that one fixed reference file, and
found 74 shared shingles before this change versus 44 after. Containment of
the smaller file fell from 0.032 to 0.016. Generic syntax and functional
parsing operations remain in the score. This metric is not a copied-code
percentage, clean-room proof or legal conclusion.

The focused Runtime model suite passed 6/6, including counter monotonicity,
missing `ip` metadata, invalid values and memory fallback. Typecheck passed.
The actual collection command was executed in a Linux Docker fixture and
parsed a default interface, IPv4 address, link state and receive/transmit
counters. The complete repository gate also passed after this change: 1,216
unit/integration tests, 21 visual/accessibility tests, architecture,
Contract, license, snapshot and production build checks. A rebuilt Mac
package and installed-app journey are separate checks, not claimed here.

## Remaining decision

A qualified reviewer must assess the exact retained source and whether any
historical source attribution remains applicable. Other bounded-screen
candidates—including quick-connect defaults, bookmark schemas, protocol
wrappers, themes, RDP mapping and UI presentation—remain in the source-rights
queue. Do not alter useful behavior merely to lower a similarity score.
