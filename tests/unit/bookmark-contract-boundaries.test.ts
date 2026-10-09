import { describe, expect, it } from 'vitest';
import {
  aiBookmarkDraftSchema,
  createBookmarkSchema,
  ftpBookmarkSettingsSchema,
  serialBookmarkSettingsSchema,
} from '../../packages/contracts/src';

describe('Axterm bookmark Contract boundaries', () => {
  it('stores FTP credential references and rejects inline passwords', () => {
    const settings = ftpBookmarkSettingsSchema.parse({ hostname: 'ftp.example.test' });
    expect(settings).toMatchObject({
      port: 21,
      username: 'anonymous',
      credentialRef: null,
      security: 'plain',
    });
    expect(
      ftpBookmarkSettingsSchema.safeParse({ hostname: 'ftp.example.test', password: 'test-secret' })
        .success,
    ).toBe(false);
    expect(
      createBookmarkSchema.safeParse({
        protocol: 'ftp',
        hostId: null,
        title: 'FTP example',
        ftp: { hostname: 'ftp.example.test', password: 'test-secret' },
      }).success,
    ).toBe(false);
  });

  it('rejects secrets in AI drafts and keeps legacy serial defaults explicit', () => {
    const publicDraft = {
      name: 'Example',
      title: 'Example',
      hostname: 'host.example.test',
      port: 22,
      username: 'operator',
      authType: 'password',
      description: '',
      favorite: false,
    };
    expect(aiBookmarkDraftSchema.safeParse(publicDraft).success).toBe(true);
    expect(
      aiBookmarkDraftSchema.safeParse({ ...publicDraft, password: 'test-secret' }).success,
    ).toBe(false);
    expect(serialBookmarkSettingsSchema.parse({ path: '/dev/tty.usbserial' })).toMatchObject({
      baudRate: 9_600,
      txLineEnding: '\r',
      closeSequence: '\\x01ky',
      closeSequenceDelayMs: 500,
    });
  });
});
