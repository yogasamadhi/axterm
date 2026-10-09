import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileComparisonSchema } from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type { SftpService } from './sftp-service';
import { FileComparisonService } from './file-comparison-service';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('FileComparisonService', () => {
  it('compares an authorized local file with remote text and returns bounded contents', async () => {
    const { service } = await fixture('alpha\nlocal\n', {
      '/remote.txt': Buffer.from('alpha\nremote\n'),
    });
    const result = await service.compare({
      left: { scope: 'local', grantId: 'grant-1', path: 'local.txt' },
      right: { scope: 'remote', connectionId: CONNECTION_ID, path: '/remote.txt' },
    });
    expect(result).toMatchObject({
      status: 'different',
      left: { scope: 'local', name: 'local.txt', content: 'alpha\nlocal\n' },
      right: { scope: 'remote', name: 'remote.txt', content: 'alpha\nremote\n' },
    });
    expect(() => fileComparisonSchema.parse(result)).not.toThrow();
  });

  it('reports equal without duplicating file contents', async () => {
    const { service } = await fixture('same\r\n', { '/same.txt': Buffer.from('same\r\n') });
    const result = await service.compare({
      left: { scope: 'local', grantId: 'grant-1', path: 'same.txt' },
      right: { scope: 'remote', connectionId: CONNECTION_ID, path: '/same.txt' },
    });
    expect(result.status).toBe('equal');
    expect(result.left.content).toBeUndefined();
    expect(result.right.content).toBeUndefined();
  });

  it('classifies binary, byte-limit and line-limit inputs explicitly', async () => {
    const { service } = await fixture('text', {
      '/binary.dat': Buffer.from([0, 1, 2, 3]),
      '/lines.txt': Buffer.from('x\n'.repeat(10_000)),
      '/large.txt': undefined,
    });
    const left = { scope: 'local' as const, grantId: 'grant-1', path: 'local.txt' };
    await expect(
      service.compare({
        left,
        right: { scope: 'remote', connectionId: CONNECTION_ID, path: '/binary.dat' },
      }),
    ).resolves.toMatchObject({ status: 'unsupported', reason: 'binary' });
    await expect(
      service.compare({
        left,
        right: { scope: 'remote', connectionId: CONNECTION_ID, path: '/lines.txt' },
      }),
    ).resolves.toMatchObject({ status: 'too-large', reason: 'too-many-lines' });
    await expect(
      service.compare({
        left,
        right: { scope: 'remote', connectionId: CONNECTION_ID, path: '/large.txt' },
      }),
    ).resolves.toMatchObject({ status: 'too-large', reason: 'too-many-bytes' });
  });
});

async function fixture(localContent: string, remote: Record<string, Buffer | undefined>) {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-file-comparison-'));
  directories.push(directory);
  const localPath = join(directory, 'local.txt');
  await writeFile(localPath, localContent);
  const host = {
    resolveGrantTransferPath: async () => ({ path: localPath }),
  } as unknown as HostCapabilityClient;
  const sftp = {
    readForComparison: async (_connectionId: string, path: string) => {
      const bytes = remote[path];
      return {
        entry: {
          name: path.slice(1),
          path,
          type: 'file' as const,
          size: path === '/large.txt' ? 2 * 1024 * 1024 + 1 : (bytes?.length ?? 0),
          mode: 0o100644,
          revision: 'revision',
        },
        ...(bytes ? { bytes } : {}),
      };
    },
  } as unknown as SftpService;
  return { service: new FileComparisonService(sftp, host) };
}
