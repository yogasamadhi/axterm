# IR-11 isarray 1.0.0 publisher README license — 2026-09-25

Status: **exact publisher license text preserved for source, unsigned macOS
package and About; qualified rights review remains pending**.

## Source identity

The frozen production graph includes `isarray@1.0.0`. Its installed
`package.json` declares MIT and points to the publisher repository
[`juliangruber/isarray`](https://github.com/juliangruber/isarray). The
published tarball has no separate root LICENSE/COPYING/NOTICE file, so the
generated root-license archive correctly lists it in
`missingRootLicenseFiles`. Its installed `README.md`, however, includes the
complete MIT permission, conditions and disclaimer under `## License`, with
a 2013 Julian Gruber copyright line.

The publisher's annotated [`v1.0.0` tag](https://github.com/juliangruber/isarray/tree/v1.0.0)
is object `4d60ca897afbe49e99d3b3632b7808395290f0ba`, peeling to commit
`2a23a281f369e9ae06394c0fb4d2381355a6ba33`. In a temporary shallow
checkout of that exact tag, `README.md`, `index.js` and `package.json` each
compared byte-for-byte with the frozen installed package. The README's SHA-256
is `ff138e683771b187f3629c383db72ee7d632009010a36d08e18e8d2a34222ec7`;
the executable and manifest SHA-256 values are
`9b8c691372802da788c9c5f4e1ca2f1ed0b88ab8722176c2aea15e38ec86d249`
and `93165ce56e458216c18240cd961a522af5b18e51da06f55d88ac552234455d95`,
respectively.

## Distribution supplement

[`licenses/isarray-README.txt`](../../../licenses/isarray-README.txt) is a
byte-identical copy of the 1,890-byte installed publisher README, retaining
the entire license section rather than rewriting its legal terms. The
transition `THIRD_PARTY_NOTICES.txt` identifies that file and the package.
The existing packaging rule includes `licenses/*.txt`, and About/Legal
enumerates these documents. An offline source regression pins the installed
manifest, executable, README hash and exact supplement bytes; packaged
legal-file and About tests verify the current artifact.

The focused source file passed **32/32** tests. A fresh unsigned macOS arm64
directory app was built outside the checkout at
`/tmp/axterm-isarray-legal-package.Xp737O/mac-arm64/Axterm.app`. Its legal-file
and About-page journeys passed **2/2**, including the exact new README text.
The generated packaged SPDX sidecar matched the concrete Resources directory.

| Packaged artifact                    | SHA-256                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| `Contents/Resources/app.asar`        | `b95e9b1fe2f23adde31469fdfc528d8626b65afdf0bf4ebade1a2b9660320796` |
| Verified macOS packaged SPDX sidecar | `d1cc7a893478e2c4f0e0f498324829c0d7ab905892107fd45a55db8d999d4b4d` |

This supplemental document does **not** turn the published package's absent
root LICENSE into a present one. `isarray` remains in the mechanical
missing-root and attribution-review queues until qualified review considers
the README, complete package/source lineage and distribution obligations.
It also does not clear other packages, generated/inlined code or other
platforms. IR-02 and IR-11 remain **In progress**.
