import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('pins an active packaged feed ahead of runtime environment overrides', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const directory = await temporaryDirectory();
    const packagedRecordPath = join(directory, 'AXTERM_UPDATE_FEED.json');
    const embeddedUrl = 'https://updates.axterm.dev/stable/manifest.json';
    await writeFile(
      packagedRecordPath,
      JSON.stringify({
        schemaVersion: 1,
        status: 'active',
        manifestUrl: embeddedUrl,
        publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        approval: {
          reviewer: 'test fixture',
          reviewedAt: '2026-09-24',
          evidence: ['test-only'],
          conclusion: 'test-only',
        },
        limitations: ['test-only'],
      }),
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    const updater = createDesktopUpdaterFromEnvironment({
      currentVersion: '1.0.0',
      downloadDirectory: directory,
      openInstaller: async () => '',
      packagedRecordPath,
      environment: {
        AXTERM_UPDATE_MANIFEST_URL: 'https://untrusted.invalid/manifest.json',
        AXTERM_UPDATE_PUBLIC_KEY_BASE64: 'invalid-key',
      },
      fetcher,
    });

    expect(updater.status()).toEqual({ state: 'idle' });
    await expect(updater.perform('check')).resolves.toMatchObject({ state: 'error' });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(embeddedUrl);
  });

  it('uses explicit local fixture environment only while the packaged record is pending', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const directory = await temporaryDirectory();
    const packagedRecordPath = join(directory, 'AXTERM_UPDATE_FEED.json');
    await writeFile(packagedRecordPath, await readFile('compliance/UPDATE_FEED_RECORD.json'));
    const updater = createDesktopUpdaterFromEnvironment({
      currentVersion: '1.0.0',
      downloadDirectory: directory,
      openInstaller: async () => '',
      packagedRecordPath,
      environment: {
        AXTERM_UPDATE_MANIFEST_URL: 'http://127.0.0.1:49152/manifest.json',
        AXTERM_UPDATE_PUBLIC_KEY_BASE64: publicKey
          .export({ format: 'der', type: 'spki' })
          .toString('base64'),
      },
    });
    expect(updater.status()).toEqual({ state: 'idle' });

    const missing = createDesktopUpdaterFromEnvironment({
      currentVersion: '1.0.0',
      downloadDirectory: directory,
      openInstaller: async () => '',
      packagedRecordPath: join(directory, 'missing.json'),
      environment: {},
    });
    expect(missing.status()).toEqual({
      state: 'error',
      errorCode: 'UPDATE_CONFIGURATION_INVALID',
    });
  });

  it('rejects a non-loopback HTTP manifest URL before it can make a request', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    expect(
      () =>
        new SignedReleaseUpdater({
          currentVersion: '1.0.0',
          manifestUrl: 'http://updates.example/stable/manifest.json',
          publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
          downloadDirectory: '/unused',
          openInstaller: async () => '',
        }),
    ).toThrow('UPDATE_URL_UNSAFE');
  });

  it.each([
    ['1.1.0-alpha', '1.1.0-alpha.1', 'available'],
    ['1.1.0-beta.2', '1.1.0-beta.11', 'available'],
    ['1.1.0-beta.11', '1.1.0-beta.2', 'idle'],
    ['1.1.0-1', '1.1.0-alpha', 'available'],
    ['1.1.0-rc.1', '1.1.0', 'available'],
    ['1.1.0', '1.1.0-rc.1', 'idle'],
    ['1.1.0+build.1', '1.1.0+build.2', 'idle'],
  ] as const)(
    'orders installed %s and signed release %s as %s',
    async (currentVersion, releaseVersion, expectedState) => {
      const fixture = await createUpdateFixture(Buffer.from('version-precedence'), {
        version: releaseVersion,
      });
      const updater = new SignedReleaseUpdater({
        currentVersion,
        manifestUrl: fixture.manifestUrl,
        publicKeyBase64: fixture.publicKeyBase64,
        downloadDirectory: await temporaryDirectory(),
        openInstaller: async () => '',
      });

      await expect(updater.perform('check')).resolves.toMatchObject({ state: expectedState });
    },
  );

  it('rejects malformed SemVer identifiers before they can be signed as update manifests', () => {
    for (const version of ['01.0.0', '1.0.0-01', '1.0.0-alpha..1', '1.0.0-']) {
      expect(signedUpdateManifestSchema.shape.version.safeParse(version).success).toBe(false);
    }
    expect(signedUpdateManifestSchema.shape.version.safeParse('1.0.0-rc.1+build.9').success).toBe(
      true,
    );
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

  it('accepts a signed chunked artifact response without Content-Length', async () => {
    const fixture = await createUpdateFixture(Buffer.from('signed chunked installer bytes'), {
      omitContentLength: true,
    });
    const directory = await temporaryDirectory();
    const updater = new SignedReleaseUpdater({
      currentVersion: '1.0.0',
      manifestUrl: fixture.manifestUrl,
      publicKeyBase64: fixture.publicKeyBase64,
      downloadDirectory: directory,
      openInstaller: async () => '',
    });

    await expect(updater.perform('check')).resolves.toMatchObject({ state: 'available' });
    await expect(updater.perform('download')).resolves.toMatchObject({ state: 'ready' });
    expect(await readFile(join(directory, 'axterm-1.1.0.pkg'))).toEqual(fixture.artifact);
  });

  it('retries short file writes before reporting the signed installer ready', async () => {
    const fixture = await createUpdateFixture(
      Buffer.from('partial writes must not truncate signed artifacts'),
    );
    const directory = await temporaryDirectory();
    let writes = 0;
    const updater = new SignedReleaseUpdater({
      currentVersion: '1.0.0',
      manifestUrl: fixture.manifestUrl,
      publicKeyBase64: fixture.publicKeyBase64,
      downloadDirectory: directory,
      openInstaller: async () => '',
      openDownloadFile: async (path, flags, mode) => {
        const file = await open(path, flags, mode);
        return {
          write: async (bytes, offset = 0, length = bytes.byteLength - offset) => {
            writes += 1;
            return file.write(bytes, offset, Math.min(length, 5));
          },
          sync: () => file.sync(),
          close: () => file.close(),
        };
      },
    });

    await updater.perform('check');
    await expect(updater.perform('download')).resolves.toMatchObject({ state: 'ready' });
    expect(writes).toBeGreaterThan(1);
    expect(await readFile(join(directory, 'axterm-1.1.0.pkg'))).toEqual(fixture.artifact);
  });

  it('fails and removes the partial artifact when the filesystem makes no write progress', async () => {
    const fixture = await createUpdateFixture(Buffer.from('zero-byte write fixture'));
    const directory = await temporaryDirectory();
    const updater = new SignedReleaseUpdater({
      currentVersion: '1.0.0',
      manifestUrl: fixture.manifestUrl,
      publicKeyBase64: fixture.publicKeyBase64,
      downloadDirectory: directory,
      openInstaller: async () => '',
      openDownloadFile: async (path, flags, mode) => {
        const file = await open(path, flags, mode);
        return {
          write: async () => ({ bytesWritten: 0 }),
          sync: () => file.sync(),
          close: () => file.close(),
        };
      },
    });

    await updater.perform('check');
    await expect(updater.perform('download')).resolves.toEqual({
      state: 'error',
      errorCode: 'UPDATE_DOWNLOAD_FAILED',
      availableVersion: '1.1.0',
    });
    await expect(readFile(join(directory, 'axterm-1.1.0.pkg.part'))).rejects.toThrow();
    await expect(readFile(join(directory, 'axterm-1.1.0.pkg'))).rejects.toThrow();
  });

  it('reports a stable error if the download directory cannot be created', async () => {
    const fixture = await createUpdateFixture(Buffer.from('directory failure fixture'));
    const parent = await temporaryDirectory();
    const blockedDirectory = join(parent, 'not-a-directory');
    await writeFile(blockedDirectory, 'already a file');
    const updater = new SignedReleaseUpdater({
      currentVersion: '1.0.0',
      manifestUrl: fixture.manifestUrl,
      publicKeyBase64: fixture.publicKeyBase64,
      downloadDirectory: blockedDirectory,
      openInstaller: async () => '',
    });

    await updater.perform('check');
    await expect(updater.perform('download')).resolves.toEqual({
      state: 'error',
      errorCode: 'UPDATE_DOWNLOAD_FAILED',
      availableVersion: '1.1.0',
    });
    expect(await readFile(blockedDirectory, 'utf8')).toBe('already a file');
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

  it('authenticates release notes and escapes multiline text in the signed record', async () => {
    const fixture = await createUpdateFixture(Buffer.from('signed artifact'), {
      notes: 'Fixes transfer cleanup\nImproves installation checks',
      tamperNotes: true,
    });
    const updater = new SignedReleaseUpdater({
      currentVersion: '1.0.0',
      manifestUrl: fixture.manifestUrl,
      publicKeyBase64: fixture.publicKeyBase64,
      downloadDirectory: await temporaryDirectory(),
      openInstaller: async () => '',
    });

    expect(canonicalManifestRecord(fixture.signedManifest)).toContain(
      '"Fixes transfer cleanup\\nImproves installation checks"',
    );
    await expect(updater.perform('check')).resolves.toEqual({
      state: 'error',
      errorCode: 'UPDATE_SIGNATURE_INVALID',
    });
  });

  it('rejects a correctly signed artifact URL when it is not on the manifest origin', async () => {
    const fixture = await createUpdateFixture(Buffer.from('cross-origin artifact'), {
      artifactUrl: 'https://downloads.example/axterm-1.1.0.pkg',
    });
    const updater = new SignedReleaseUpdater({
      currentVersion: '1.0.0',
      manifestUrl: fixture.manifestUrl,
      publicKeyBase64: fixture.publicKeyBase64,
      downloadDirectory: await temporaryDirectory(),
      openInstaller: async () => '',
    });

    await expect(updater.perform('check')).resolves.toEqual({
      state: 'error',
      errorCode: 'UPDATE_ARTIFACT_ORIGIN_MISMATCH',
    });
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
  options: {
    corruptSignature?: boolean;
    declaredHash?: string;
    slow?: boolean;
    artifactUrl?: string;
    omitContentLength?: boolean;
    version?: string;
    notes?: string;
    tamperNotes?: boolean;
  } = {},
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
        ...(options.omitContentLength
          ? { 'Transfer-Encoding': 'chunked' }
          : { 'Content-Length': artifact.byteLength }),
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
    version: options.version ?? '1.1.0',
    publishedAt: '2026-09-14T00:00:00.000Z',
    notes: options.notes ?? 'Signed local update fixture',
    artifact: {
      url: options.artifactUrl ?? `${origin}/axterm-1.1.0.pkg`,
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
    notes: options.tamperNotes ? 'Tampered release notes' : unsigned.notes,
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
    signedManifest: unsigned,
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
