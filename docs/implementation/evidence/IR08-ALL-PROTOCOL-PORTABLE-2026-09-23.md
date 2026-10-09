# IR-08 Axterm portable-file nine-protocol round trip

Date: 2026-09-23  
Scope: independent `axterm-configuration` version-1 file  
Result: source-level migration regression added; IR-08 remains **In progress**

The portable configuration Contract permits nine saved Bookmark protocols:
SSH, local terminal, Telnet, Serial, RDP, VNC, FTP, SPICE and Web. Before this
regression, the export test exercised SSH, Web and Telnet, while the main
cross-database import test was SSH-centered. A schema declaration alone did
not prove all nine records could pass through export, preview and commit.

The new `AxtermConfigurationService` test uses real source and target SQLite
databases. It creates a group with one Bookmark for every protocol and one SSH
Host used by the SSH Bookmark and by RDP/VNC/SPICE jump-host settings. It then:

1. Exports the independent file through a Host save-grant fixture and validates
   its strict Contract and all nine protocol IDs.
2. Verifies that six distinct source credential references are absent from
   the file, while non-secret protocol-specific settings are retained.
3. Previews and explicitly commits eleven entities into a fresh database;
   checks that all nine Bookmarks retain their group and settings, the SSH
   Host receives a new ID, and the three remote-desktop jump-host references
   point to that new ID.
4. Checks imported credential references are null and a repeated preview is
   unchanged instead of creating duplicate records.

`bunx vitest run packages/runtime/src/application/axterm-configuration-service.test.ts`
passed 12/12 tests on 2026-09-23. The complete `bun run check` then passed
219 test files with five skipped files (1,015 tests passed, 33 skipped), the
358-module / 1,304-dependency Level 1 gate, 267 Contract operations,
production build/layout and nine visual/accessibility journeys. The source
snapshot hygiene check found no prohibited entries.

This test protects the current Axterm-owned
portable format. It does not claim that the legacy Legacy Prototype-compatible importer
converts non-SSH Bookmarks, that the file backs up the application-local Vault,
or that a preserved old public installer or native Windows/Linux installed app
has passed this nine-protocol journey. The public migration release and later
compatibility-removal gates remain open.
