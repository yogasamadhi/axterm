import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialVault } from '../../apps/desktop/src/main/host-capabilities/credential-vault';
import { hostCredentialMetadataSchema } from '../../packages/contracts/src/host-capabilities/desktop';
import { credentialMetadataSchema } from '../../packages/contracts/src/schemas/resources';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createVault() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-local-vault-'));
  directories.push(directory);
  const vault = new CredentialVault(directory);
  await vault.open();
  return { directory, vault };
}

describe('application-local credential vault', () => {
  it('exposes only app-local storage in both credential contracts', () => {
    const metadata = {
      ref: 'cred_fixture',
      kind: 'sshPassword',
      label: 'fixture',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(hostCredentialMetadataSchema.parse({ ...metadata, storage: 'local' }).storage).toBe(
      'local',
    );
    expect(credentialMetadataSchema.parse({ ...metadata, storage: 'local' }).storage).toBe('local');
    for (const storage of ['secure', 'basic', 'session']) {
      expect(hostCredentialMetadataSchema.safeParse({ ...metadata, storage }).success).toBe(false);
      expect(credentialMetadataSchema.safeParse({ ...metadata, storage }).success).toBe(false);
    }
  });

  it('ignores legacy system-storage metadata without resolving its blob', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-local-vault-'));
    directories.push(directory);
    await writeFile(
      join(directory, 'metadata.json'),
      JSON.stringify([
        {
          ref: 'cred_00000000-0000-0000-0000-000000000000',
          kind: 'sshPassword',
          label: 'legacy',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          storage: 'secure',
        },
      ]),
      { mode: 0o600 },
    );
    const vault = new CredentialVault(directory);
    await vault.open();
    expect(vault.list()).toEqual([]);
    await expect(vault.get('cred_00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      'Credential not found',
    );
    vault.close();
  });

  it('encrypts saved secrets and resolves them after restart', async () => {
    const { directory, vault } = await createVault();
    const secret = 'never-write-this-plaintext';
    const metadata = await vault.put({ kind: 'sshPassword', label: 'fixture', secret });

    expect(metadata.storage).toBe('local');
    expect(await vault.get(metadata.ref)).toBe(secret);
    const files = await readdir(directory);
    const secretFile = files.find((file) => file.startsWith(metadata.ref));
    expect(secretFile).toBe(`${metadata.ref}.bin`);
    expect(await readFile(join(directory, secretFile!), 'utf8')).not.toContain(secret);
    expect(await readFile(join(directory, 'metadata.json'), 'utf8')).not.toContain(secret);
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, 'master.key'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, secretFile!))).mode & 0o777).toBe(0o600);
    }

    vault.close();
    const reopened = new CredentialVault(directory);
    await reopened.open();
    expect(await reopened.get(metadata.ref)).toBe(secret);
    reopened.close();
  });

  it('re-encrypts replacements, detects tampering and deletes the blob', async () => {
    const { directory, vault } = await createVault();
    const metadata = await vault.put({ kind: 'aiApiKey', label: 'fixture', secret: 'first' });
    await vault.replace(metadata.ref, 'second');
    expect(await vault.get(metadata.ref)).toBe('second');

    const path = join(directory, `${metadata.ref}.bin`);
    const payload = JSON.parse(await readFile(path, 'utf8')) as { tag: string };
    payload.tag = Buffer.alloc(16).toString('base64');
    await writeFile(path, JSON.stringify(payload), { mode: 0o600 });
    await expect(vault.get(metadata.ref)).rejects.toThrow();

    await vault.delete(metadata.ref);
    expect(vault.list()).toEqual([]);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    vault.close();
  });
});
