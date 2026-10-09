# W-14-01 provisional local history and artifact backup

Date: 2026-09-25  
Status: **private local rehearsal only; W-14-01 remains open**

## Scope and containment

A private sibling directory, `../axterm-legacy-backup.8wBWvM` relative to
this repository, was created with mode `0700`; its ten backup files have mode
`0600`. Nothing was pushed to GitHub or added to the future public source
snapshot. This local copy is on the **same volume** as the checkout and is not
an owner-designated long-term or disaster-recovery location. It may contain
historical material requiring restricted access; do not attach it to a public
issue, release or new Git repository.

`axterm-main.bundle` contains **only `refs/heads/main`**. At capture,
`main` and `origin/main` both resolved to
`290895c930be379d367bf41cc77a467e3258b025`; its reachable history had
10 commits. The bundle deliberately excludes local `refs/codex/...`
checkpoint refs, which are not part of the old public repository. The first
commit's `vendor/legacy-prototype` gitlink points to
`799bedef98c1deae676ae03041719de98d3b57f1`, but a Git bundle of the
parent repository does **not** contain that submodule's objects. The separate
source-tree tar preserves the **926 files at that exact Legacy Prototype commit**.
An additional private bundle preserves `refs/heads/master` at the exact
gitlink commit and its **3,730 reachable commits**. A second, broader bundle
now preserves **all 628 refs present in this machine's submodule object store**
(one local branch, 31 remote-tracking refs and 596 tags), including that
`master` tip. `git fsck --full --no-reflogs --unreachable` found no unreachable
objects in the local store at capture. This does **not** prove that the local
store includes every upstream ref, object or historical release ever published;
the archive owner must decide the required long-term retention scope.

The evidence archive contains the point-in-time `docs/`, `licenses/`, current
source/asset/dependency-review ledgers, `THIRD_PARTY_COMPONENTS.json`,
`THIRD_PARTY_LICENSE_TEXTS.json`, root `package.json` and `bun.lock` (220 tar
entries). It is **not** a backup of all 1,251 uncommitted/changed paths or a
final clean source snapshot. The four installer/archive files are local
`release/` artifacts; their presence and filenames do not prove public
distribution, signing or user installation.

| Private backup file                                 | SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `axterm-main.bundle`                                | `c79a7530cdb41d7b98919e706cbc2b9b519bdfebf385691a060c66f02c338b2c` |
| `axterm-rights-migration-evidence.tgz`              | `d9691c1e66ce781df9f661ca5802999a780935f01ef42cd8abc5d86d229eaefb` |
| `legacy-prototype-799bedef-source-tree.tar`         | `cc210a2510edae52e36ea099793e747651d4b98a3dd59cd40ab25314d188e138` |
| `legacy-prototype-799bedef-history.bundle`          | `8219ccddd86d91fc089f49b341f189b1a573308e5ff09aad3d2d33bd1f52cb2d` |
| `legacy-prototype-all-local-refs-2026-09-25.bundle` | `a4d749396f375082ea170e261f527ad8870aa9f44857b093f156c9e70c8c0ddc` |
| `axterm-source-snapshot-2026-09-25.tar`             | `474922c9e34183ba3ed0b56a15f791d19e868bf367e70d752efabe87f5be2dda` |
| `Axoterm-0.10.0-arm64.dmg`                          | `496bf7e712639d1dc265db28ac0065a57535318410e335b3b2c290311813aa99` |
| `Axoterm-0.10.0-arm64-mac.zip`                      | `fca121500f70b18eda5cd88d8f9fef0d0d685e88237b417e516d151bd5e74d25` |
| `Axterm-0.10.0-arm64.dmg`                           | `a452ae54e27f887f81e097920824df2087ff6a46cd02d48ddf55189031da260e` |
| `Axterm-0.10.0-arm64-mac.zip`                       | `215d1e4ea5a482951b47f0914675ef8fa43d15a0276a26972d4f02b6ee599b4d` |

## Read rehearsal

`git bundle verify` reported a complete history and `main` at the exact
SHA above. A fresh bare clone made **from that bundle** resolved `main` to
the same SHA and counted 10 reachable commits. All four copied binary files
passed `cmp -s` against their original local `release/` files. The tar archive
was read without extraction; its `docs/implementation/COMMERCIALIZATION_CLEANUP_PLAN.md`
entry had SHA-256
`6a30e9023ac1bc16d1c508972031064347250811f2d68cee627015056f80570d`,
equal to the captured source file. These checks prove this local copy is
readable and byte-identical in the stated scope; they do not prove remote
durability or source rights.

A separate point-in-time prepared Axterm source snapshot now covers **949
files / 24,737,397 source bytes** with `sourceTreeSha256`
`b9e5b2ff1e2ee679ded6ff67ac5ac3298e72d1367c6bf8396e8a4b3915bc6069`.
It passed the repository's independent-snapshot hygiene audit before archiving
and again after extraction from the tar. This copy includes the in-progress
source snapshot but is **not** a complete backup of all changed worktree paths:
the snapshot deliberately excludes build output, local state and other
non-source paths. It is also not the final approved/frozen public snapshot.

The Legacy Prototype source-tree tar was read back and its non-directory path list
matched the fixed commit's `git ls-tree` exactly (926/926). The archived
`src/client/components/rdp/code-scan.js` SHA-256
`5b5fb2136032709e0f11cd6c5b627eede30091a419ca1579ca98a833f18d3b61`
also matched `git show` from that commit. This preserves evidence, not
permission to retain or relicense that code in Axterm.

The submodule history bundle passed `git bundle verify` as a complete SHA-1
history with only `refs/heads/master` at
`799bedef98c1deae676ae03041719de98d3b57f1`. A fresh **bare clone from
that bundle** resolved `master` to the same gitlink SHA, counted **3,730**
reachable commits and **926** tracked files at its tip, and passed
`git fsck --full --no-reflogs`. The bundle is **15,367,684 bytes**, mode
`0600`, in the existing mode-`0700` private directory. This is a local
readability rehearsal, not independent off-volume or long-term retention.

The broader local-ref bundle is **34,001,745 bytes**, mode `0600`, in the same
private directory. `git bundle verify` reported **629 advertised entries**
(628 refs plus `HEAD`) and complete SHA-1 history. An independent `git clone
--mirror` from it reproduced all **628 ref names and object IDs** exactly
(`diff` returned no changes); `git fsck --full --no-reflogs` passed in the clone.
The clone has **4,343 commits reachable from all refs**, resolves `master` to
the exact gitlink SHA above and has **926 files** at that tip. These results
close the _local-ref coverage_ gap in this temporary backup, not the
off-volume custody, final frozen snapshot, or rights/retention decisions.

## Remaining W-14-01 conditions

The repository owner must name an access-controlled long-term retention
location and custodian, copy the backup there, verify hashes and perform a
read rehearsal **from that location**. The owner must also decide whether
the local store's 628 refs and all objects reachable from them meet the
required upstream scope, whether any nonlocal upstream objects or externally
distributed old installers need separate retention, and
preserve the final approved license/migration evidence and source snapshot
after the worktree is frozen. Only then can W-14-01 be considered for closure.
Do not delete the old GitHub repository based on this provisional local backup.
