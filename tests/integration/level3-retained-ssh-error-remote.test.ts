import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { remoteProfile, remoteValue } from '../fixtures/level3-remote-profile.ts';
it('derives duplicate-name and validation diagnostics from real Catalog Remote without values or invented identifiers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-ssh-diagnostics-'));
  const f = await remoteProfile(home);
  try {
    let baseline = await remoteValue(f.client.remote.catalog.getBookmarkTree());
    const input = {
      host: {
        name: 'Saved SSH',
        hostname: 'localhost',
        username: 'operator',
        authType: 'agent' as const,
      },
      bookmark: { title: 'Saved SSH' },
    };
    await remoteValue(
      f.client.remote.catalog.createSshBookmark(randomUUID(), input, baseline.etag),
    );
    baseline = await remoteValue(f.client.remote.catalog.getBookmarkTree());
    const duplicate = randomUUID();
    await expect(
      remoteValue(f.client.remote.catalog.createSshBookmark(duplicate, input, baseline.etag)),
    ).rejects.toMatchObject({
      code: 'catalog/failure',
      details: {
        reason: 'conflict',
        diagnostic: { code: 'HOST_NAME_CONFLICT', operationId: duplicate },
      },
    });
    const invalid = randomUUID();
    const error: unknown = await remoteValue(
      f.client.remote.catalog.createSshBookmark(
        invalid,
        {
          host: {
            ...input.host,
            name: 'Invalid SSH',
            port: 0,
            startup: { environment: { PASSWORD: 'SSH_ERROR_PRIVATE_CANARY' } },
          },
          bookmark: { title: 'Invalid SSH' },
        },
        baseline.etag,
      ),
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'catalog/failure',
      details: {
        reason: 'invalid-input',
        diagnostic: {
          code: 'VALIDATION_ERROR',
          operationId: invalid,
          fields: expect.arrayContaining(['host.port']),
        },
      },
    });
    expect(JSON.stringify(error)).not.toContain('SSH_ERROR_PRIVATE_CANARY');
    const unchanged = await remoteValue(f.client.remote.catalog.getBookmarkTree());
    expect(await remoteValue(f.client.remote.catalog.listHosts())).toHaveLength(1);
    expect(unchanged.etag).toBe(baseline.etag);
  } finally {
    await f.close();
    await rm(home, { recursive: true, force: true });
  }
});
