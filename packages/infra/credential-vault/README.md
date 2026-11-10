# Application-local encrypted Vault

This private package owns physical Vault files without Electron, system credential
stores, environment discovery or a storage-choice setting. The Web/headless
`LocalVaultCredentials` provider implements the credentials seam. The new Desktop
shell must own `EncryptedVault`; its Host adapter will use the narrow native port.
The shipped application has not yet adopted either provider.

The directory is mandatory. Development and test composition must pass an isolated
home. Existing AES-256-GCM version-1 envelopes, 32-byte master keys, `cred_UUID`
references and reference AAD are preserved. Copy migration is separate M7 work;
this package never discovers or upgrades a real production home automatically.
Named references and owner records have explicit, distinct metadata addresses and
are hidden from the legacy credential listing. `CREF1_` is reserved for the
canonical reversible legacy identifier adapter. Empty api-key records remain
explicit records and cannot trigger ambient authentication discovery.

All media access coordinates through a cross-process writer lock, independent of
Profile exclusion. Record read/modify/write additionally holds an address lease;
its callback can resolve another reference without holding the global writer lock.
A durable, encrypted commit journal is replayed under that lock before every
operation. The envelope authenticates before recovery changes existing files.
Metadata and ciphertext use owner-only atomic replacements. Unix files and the
parent directory are fsynced. Windows retains atomic replacements and the journal;
its native durability and permission behavior require platform validation.

Limits: a secret is nonempty UTF-8 text up to 4 MiB; metadata, envelopes and journals
are read with a 32 MiB bound. Unknown metadata, missing keys, damaged ciphertext and
incomplete copies fail explicitly. No crypto, parser, mutation or filesystem cause
is retained in public diagnostics. Provider disposal stops admission, drains
accepted mutations and then zeros the in-memory master key. Cached instances stay
closed. Same-process external code has the permissions documented by Level 3.
