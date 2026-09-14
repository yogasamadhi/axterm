import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  signedUpdateManifestSchema,
  type SignedUpdateManifest,
} from '../../packages/contracts/src/host-capabilities/desktop';
import {
  canonicalManifestRecord,
  createDesktopUpdaterFromEnvironment,
  SignedReleaseUpdater,
} from '../../apps/desktop/src/main/host-capabilities/signed-release-updater';

const directories: string[] = [];
const closeServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeServers.splice(0).map((close) => close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('signed Desktop update provider', () => {
  it('does no network work when no provider is configured and reports partial configuration', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const disabled = createDesktopUpdaterFromEnvironment({
      currentVersion: '1.0.0',
      downloadDirectory: '/unused',
      openInstaller: async () => '',
      environment: {},
      fetcher,
    });
    expect(disabled.status()).toEqual({ state: 'disabled' });
    expect(await disabled.perform('check')).toEqual({ state: 'disabled' });
    expect(fetcher).not.toHaveBeenCalled();

    const invalid = createDesktopUpdaterFromEnvironment({
      currentVersion: '1.0.0',
      downloadDirectory: '/unused',
      openInstaller: async () => '',
      environment: { AXTERM_UPDATE_MANIFEST_URL: 'https://updates.example/manifest.json' },
      fetcher,
    });
    expect(invalid.status()).toEqual({
      state: 'error',
      errorCode: 'UPDATE_CONFIGURATION_INVALID',
    });
  });

  it('checks a signed manifest, streams and verifies the artifact, then hands off its private path', async () => {
    const fixture = await createUpdateFixture(Buffer.alloc(512 * 1024, 0x41));
    const directory = await temporaryDirectory();
    const opened: string[] = [];
    const updater = new SignedReleaseUpdater({
      currentVersion: '1.0.0',
      manifestUrl: fixture.manifestUrl,
      publicKeyBase64: fixture.publicKeyBase64,
      downloadDirectory: directory,
      openInstaller: async (path) => {
        opened.push(path);
        return '';
      },
    });

    await expect(updater.perform('check')).resolves.toEqual({
      state: 'available',
      availableVersion: '1.1.0',
    });
    await expect(updater.perform('download')).resolves.toEqual({
      state: 'ready',
      availableVersion: '1.1.0',
      progress: 100,
    });
    expect(await readFile(join(directory, 'axterm-1.1.0.pkg'))).toEqual(fixture.artifact);
    await expect(updater.perform('install')).resolves.toMatchObject({ state: 'ready' });
    expect(opened).toEqual([join(directory, 'axterm-1.1.0.pkg')]);
    expect(JSON.stringify(updater.status())).not.toContain(directory);
  });

  it('rejects invalid signatures and artifact hashes with stable, non-sensitive errors', async () => {
    const invalidSignature = await createUpdateFixture(Buffer.from('signed artifact'), {
      corruptSignature: true,
    });
    const signatureUpdater = new SignedReleaseUpdater({
      currentVersion: '1.0.0',
      manifestUrl: invalidSignature.manifestUrl,
      publicKeyBase64: invalidSignature.publicKeyBase64,
      downloadDirectory: await temporaryDirectory(),
      openInstaller: async () => '',
    });
    await expect(signatureUpdater.perform('check')).resolves.toEqual({
      state: 'error',
      errorCode: 'UPDATE_SIGNATURE_INVALID',
    });

    const invalidHash = await createUpdateFixture(Buffer.from('different bytes'), {
      declaredHash: createHash('sha256').update('expected bytes').digest('hex'),
    });
    const hashDirectory = await temporaryDirectory();
    const hashUpdater = new SignedReleaseUpdater({
      currentVersion: '1.0.0',
      manifestUrl: invalidHash.manifestUrl,
      publicKeyBase64: invalidHash.publicKeyBase64,
      downloadDirectory: hashDirectory,
      openInstaller: async () => '',
    });
    await hashUpdater.perform('check');
    await expect(hashUpdater.perform('download')).resolves.toEqual({
      state: 'error',
      errorCode: 'UPDATE_ARTIFACT_HASH_MISMATCH',
      availableVersion: '1.1.0',
    });
    await expect(readFile(join(hashDirectory, 'axterm-1.1.0.pkg.part'))).rejects.toThrow();
  });

  it('revalidates the ready artifact immediately before installer handoff', async () => {
    const fixture = await createUpdateFixture(Buffer.from('verified installer bytes'));
    const directory = await temporaryDirectory();
    const openInstaller = vi.fn(async () => '');
    const updater = new SignedReleaseUpdater({
      currentVersion: '1.0.0',
      manifestUrl: fixture.manifestUrl,
      publicKeyBase64: fixture.publicKeyBase64,
      downloadDirectory: directory,
      openInstaller,
    });
    await updater.perform('check');
    await updater.perform('download');
    await writeFile(join(directory, 'axterm-1.1.0.pkg'), 'replaced after verification');
    await expect(updater.perform('install')).resolves.toEqual({
      state: 'error',
      errorCode: 'UPDATE_ARTIFACT_SIZE_MISMATCH',
      availableVersion: '1.1.0',
    });
    expect(openInstaller).not.toHaveBeenCalled();
  });

  it('cancels an active streamed download, removes the partial file and returns to available', async () => {
    const fixture = await createUpdateFixture(Buffer.alloc(2 * 1024 * 1024, 0x42), {
      slow: true,
    });
    const directory = await temporaryDirectory();
    const updater = new SignedReleaseUpdater({
      currentVersion: '1.0.0',
      manifestUrl: fixture.manifestUrl,
      publicKeyBase64: fixture.publicKeyBase64,
      downloadDirectory: directory,
      openInstaller: async () => '',
    });
    await updater.perform('check');
    const download = updater.perform('download');
    await waitUntil(() => (updater.status().progress ?? 0) > 0);
    await expect(updater.perform('cancel')).resolves.toEqual({
      state: 'available',
      availableVersion: '1.1.0',
    });
    await expect(download).resolves.toMatchObject({ state: 'available' });
    await expect(readFile(join(directory, 'axterm-1.1.0.pkg.part'))).rejects.toThrow();
    await updater.close();
  });
});

async function createUpdateFixture(
  artifact: Buffer,
  options: { corruptSignature?: boolean; declaredHash?: string; slow?: boolean } = {},
) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const fixtureState: { manifest?: SignedUpdateManifest } = {};
  const server = createServer((request, response) => {
    if (request.url === '/manifest.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(fixtureState.manifest));
      return;
    }
    if (request.url === '/axterm-1.1.0.pkg') {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': artifact.byteLength,
      });
      if (options.slow) streamSlowly(response, artifact);
      else response.end(artifact);
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  closeServers.push(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  const unsigned = signedUpdateManifestSchema.parse({
    version: '1.1.0',
    publishedAt: '2026-09-14T00:00:00.000Z',
    notes: 'Signed local update fixture',
    artifact: {
      url: `${origin}/axterm-1.1.0.pkg`,
      fileName: 'axterm-1.1.0.pkg',
      size: artifact.byteLength,
      sha256: options.declaredHash ?? createHash('sha256').update(artifact).digest('hex'),
      signature: Buffer.alloc(64).toString('base64'),
    },
  });
  const signature = sign(null, Buffer.from(canonicalManifestRecord(unsigned)), privateKey).toString(
    'base64',
  );
  fixtureState.manifest = {
    ...unsigned,
    artifact: {
      ...unsigned.artifact,
      signature: options.corruptSignature
        ? Buffer.from(
            Buffer.from(signature, 'base64').map((value, index) => (index ? value : value ^ 0xff)),
          ).toString('base64')
        : signature,
    },
  };
  return {
    artifact,
    manifestUrl: `${origin}/manifest.json`,
    publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

function streamSlowly(response: ServerResponse, contents: Buffer) {
  let offset = 0;
  const timer = setInterval(() => {
    if (response.destroyed) {
      clearInterval(timer);
      return;
    }
    const end = Math.min(contents.byteLength, offset + 32 * 1024);
    response.write(contents.subarray(offset, end));
    offset = end;
    if (offset >= contents.byteLength) {
      clearInterval(timer);
      response.end();
    }
  }, 5);
  response.once('close', () => clearInterval(timer));
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-updater-'));
  directories.push(directory);
  return directory;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Condition did not become true');
}
