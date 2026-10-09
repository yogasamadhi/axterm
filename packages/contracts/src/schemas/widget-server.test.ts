import { describe, expect, it } from 'vitest';
import { startLocalFtpServerSchema } from './resources';

describe('local FTP Widget contract', () => {
  const input = {
    grantId: 'grant_local_ftp',
    title: 'Local FTP Server',
    port: 0,
    anonymous: false,
    username: 'ftpuser',
    password: 'session-only-password',
    passivePortStart: 50_000,
    passivePortEnd: 50_031,
  };

  it('keeps unencrypted FTP on loopback while preserving IPv4 and IPv6 local use', () => {
    expect(startLocalFtpServerSchema.parse(input).host).toBe('127.0.0.1');
    expect(startLocalFtpServerSchema.parse({ ...input, host: 'localhost' }).host).toBe('localhost');
    expect(startLocalFtpServerSchema.parse({ ...input, host: '::1' }).host).toBe('::1');
    expect(() => startLocalFtpServerSchema.parse({ ...input, host: '0.0.0.0' })).toThrow(
      'Invalid option',
    );
    expect(() => startLocalFtpServerSchema.parse({ ...input, host: '::' })).toThrow(
      'Invalid option',
    );
  });
});
