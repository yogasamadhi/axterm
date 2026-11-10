import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type * as Ssh2 from 'ssh2';
import { expect, it } from 'vitest';
import {
  seedOwnedSshPasteFixtures,
  startReconnectSshFixture,
} from '../fixtures/level3-reconnect-ssh.ts';
import { remoteProfile } from '../fixtures/level3-remote-profile.ts';
import type {} from '../../packages/plugins/connections/src/index.ts';
it('prepares Windows SSH paste fixtures through a real no-server headless Profile and retains exact public keys across restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-owned-ssh-paste-seed-'));
  let f: Awaited<ReturnType<typeof remoteProfile>> | undefined;
  const peers: Awaited<ReturnType<typeof startReconnectSshFixture>>[] = [];
  try {
    const { utils } = createRequire(resolve('packages/plugins/connections/package.json'))(
      'ssh2',
    ) as typeof Ssh2;
    const hostKey = utils.generateKeyPairSync('ed25519').private;
    const parsed = utils.parseKey(hostKey);
    if (parsed instanceof Error || Array.isArray(parsed)) throw Error('Invalid fixture key');
    const publicKey = parsed.getPublicSSH(),
      fingerprint =
        'SHA256:' + createHash('sha256').update(publicKey).digest('base64').replace(/=+$/u, '');
    peers.push(
      await startReconnectSshFixture(hostKey),
      await startReconnectSshFixture(hostKey, 0, true),
    );
    await seedOwnedSshPasteFixtures(
      home,
      [
        ['SSH paste startup', peers[0]!.port],
        ['SSH paste fallback', peers[1]!.port],
      ],
      { algorithm: parsed.type, fingerprint, publicKey: publicKey.toString('base64') },
    );
    f = await remoteProfile(home, { application: true });
    const catalog = f.application.ctx.catalogController;
    expect(
      catalog
        .listHosts()
        .map(({ name }) => name)
        .sort(),
    ).toEqual(['SSH paste fallback', 'SSH paste startup']);
    expect(
      catalog
        .getBookmarkTree()
        .bookmarks.map(({ title }) => title)
        .sort(),
    ).toEqual(['SSH paste fallback', 'SSH paste startup']);
    const keys = f.application.ctx.connectionsController.listKnownHostKeys();
    expect(keys.map(({ port }) => port).sort()).toEqual(peers.map((peer) => peer.port).sort());
    for (const key of keys)
      expect(key).toMatchObject({
        host: '127.0.0.1',
        algorithm: parsed.type,
        fingerprint,
        publicKey: publicKey.toString('base64'),
      });
    expect(f.application.ctx.connectionsController.resourceSnapshot().connections).toBe(0);
  } finally {
    if (f) await f.close();
    for (const peer of peers.reverse()) await peer.stop();
    await rm(home, { recursive: true, force: true });
  }
}, 20000);
