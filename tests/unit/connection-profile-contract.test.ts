import { describe, expect, it } from 'vitest';
import {
  connectionProfileInputSchema,
  connectionProfilePatchSchema,
} from '../../packages/contracts/src/schemas/connection-profiles';

describe('connection Profile Contract', () => {
  it('creates the six Electerm protocol sections with reference-only defaults', () => {
    expect(connectionProfileInputSchema.parse({ name: '日常账号' })).toEqual({
      name: '日常账号',
      isDefault: false,
      ssh: {
        username: null,
        passwordCredentialRef: null,
        privateKeyCredentialRef: null,
        passphraseCredentialRef: null,
        certificateCredentialRef: null,
      },
      telnet: { username: null, passwordCredentialRef: null },
      vnc: { username: null, passwordCredentialRef: null },
      rdp: { username: null, passwordCredentialRef: null },
      ftp: { username: null, passwordCredentialRef: null },
      spice: { username: null, passwordCredentialRef: null },
    });
  });

  it('accepts credential references and rejects plaintext or unknown fields', () => {
    expect(
      connectionProfileInputSchema.parse({
        name: 'Production',
        isDefault: true,
        ssh: {
          username: 'deploy',
          passwordCredentialRef: 'cred_password',
          privateKeyCredentialRef: 'cred_key',
          passphraseCredentialRef: 'cred_passphrase',
          certificateCredentialRef: 'cred_certificate',
        },
      }).ssh,
    ).toMatchObject({
      username: 'deploy',
      passwordCredentialRef: 'cred_password',
      privateKeyCredentialRef: 'cred_key',
    });

    expect(() =>
      connectionProfileInputSchema.parse({
        name: 'Leaky',
        ssh: { username: 'root', password: 'plaintext' },
      }),
    ).toThrow();
  });

  it('requires a meaningful PATCH and normalizes a changed protocol section', () => {
    expect(() => connectionProfilePatchSchema.parse({})).toThrow();
    expect(() => connectionProfilePatchSchema.parse({ ssh: {} })).toThrow();
    expect(connectionProfilePatchSchema.parse({ ssh: { username: 'root' } }).ssh).toEqual({
      username: 'root',
    });
    expect(connectionProfilePatchSchema.parse({ name: 'Renamed' })).toEqual({
      name: 'Renamed',
    });
  });
});
