# IR-11 packaged legal-text coverage — 2026-09-23

Status: **current macOS engineering evidence; not third-party rights clearance**

The About panel previously imported each `licenses/*.txt` document by hand,
and the packaged test held a second manually maintained filename list. Adding
a legal document could therefore ship its bytes without making it accessible
in About or without testing that access. The Renderer now uses a build-time,
eager Vite glob for every top-level `licenses/*.txt` file and renders one named
native `<details>` for each. It does not load arbitrary paths at runtime and
does not turn the legal panel into a local-file browser.

The packaged legal journeys independently enumerate the source `licenses/`
directory. They require its sorted `.txt` set to equal the **actual packaged**
text-file set and the set of About summaries, then compare each packaged file
and rendered text byte-for-byte with the source. One representative IronRDP
entry is also opened through its user-facing summary. The two non-text source
archives retain their separate byte-identity assertions. This closes a
missing-from-About or accidentally omitted-text regression for the **current
declared** legal directory; it does not discover unrecorded third-party works.

An isolated unsigned macOS arm64 directory app built from the current tree
has `app.asar` SHA-256
`f9b4e3dd82d6d1045e9767745984e1b0134230e452f523838ce22fa8c947a069`.
The packaged file and About journeys passed **2/2**, covering all 17 current
top-level `.txt` files. The regenerated and verified macOS-arm64 SPDX sidecar
has SHA-256
`a75c000b3c93cdf07f03556992c4fbb02cb2e660fead93313247df25d8a913eb`.
The About journey loads the large Electron/Chromium runtime notices as well;
its per-test limit is 90 seconds so occasional macOS app teardown above the
former 45-second limit does not falsely report a content failure. No license
comparison or UI assertion was removed.

This is local unsigned package evidence. It does not settle completeness of
the underlying third-party notice set, the pending attribution-review queue,
inlined/WASM/native file rights, signed installers or native Windows/Linux
installed-app behavior. IR-02 and IR-11 remain **In progress**.
