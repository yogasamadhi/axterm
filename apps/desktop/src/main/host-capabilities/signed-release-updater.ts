import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  signedUpdateManifestSchema,
  updaterStatusSchema,
  type SignedUpdateManifest,
  type UpdaterAction,
  type UpdaterStatus,
} from '@workspace/contracts/desktop';

const MAX_MANIFEST_BYTES = 128 * 1024;
const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

type UpdateFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface DesktopUpdaterPort {
  status(): UpdaterStatus;
  perform(action: UpdaterAction): Promise<UpdaterStatus>;
  close(): Promise<void>;
}

interface SignedReleaseUpdaterOptions {
  currentVersion: string;
  manifestUrl: string;
  publicKeyBase64: string;
  downloadDirectory: string;
  openInstaller: (path: string) => Promise<string>;
  fetcher?: UpdateFetcher;
  checkTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

interface UpdaterEnvironmentOptions {
  currentVersion: string;
  downloadDirectory: string;
  openInstaller: (path: string) => Promise<string>;
  environment?: NodeJS.ProcessEnv;
  fetcher?: UpdateFetcher;
}

class UpdaterFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class DisabledDesktopUpdater implements DesktopUpdaterPort {
  status(): UpdaterStatus {
    return { state: 'disabled' };
  }

  async perform(): Promise<UpdaterStatus> {
    return this.status();
  }

  async close(): Promise<void> {}
}

class MisconfiguredDesktopUpdater implements DesktopUpdaterPort {
  status(): UpdaterStatus {
    return { state: 'error', errorCode: 'UPDATE_CONFIGURATION_INVALID' };
  }

  async perform(): Promise<UpdaterStatus> {
    return this.status();
  }

  async close(): Promise<void> {}
}

export class SignedReleaseUpdater implements DesktopUpdaterPort {
  private readonly fetcher: UpdateFetcher;
  private readonly manifestUrl: URL;
  private readonly publicKey: ReturnType<typeof createPublicKey>;
  private readonly checkTimeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private currentStatus: UpdaterStatus = { state: 'idle' };
  private manifest: SignedUpdateManifest | undefined;
  private readyPath: string | undefined;
  private activeAbort: AbortController | undefined;
  private activeOperation: Promise<UpdaterStatus> | undefined;
  private cancelRequested = false;

  constructor(private readonly options: SignedReleaseUpdaterOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.manifestUrl = secureUpdateUrl(options.manifestUrl);
    this.publicKey = createPublicKey({
      key: Buffer.from(options.publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    if (this.publicKey.asymmetricKeyType !== 'ed25519')
      throw new Error('Updater public key must be Ed25519');
    this.checkTimeoutMs = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  }

  status(): UpdaterStatus {
    return updaterStatusSchema.parse({ ...this.currentStatus });
  }

  async perform(action: UpdaterAction): Promise<UpdaterStatus> {
    if (action === 'cancel') return this.cancel();
    if (this.activeOperation) return this.status();
    const operation =
      action === 'check' ? this.check() : action === 'download' ? this.download() : this.install();
    this.activeOperation = operation;
    try {
      return await operation;
    } finally {
      if (this.activeOperation === operation) this.activeOperation = undefined;
    }
  }

  async close(): Promise<void> {
    this.cancelRequested = true;
    this.activeAbort?.abort();
    await this.activeOperation?.catch(() => {});
    this.activeAbort = undefined;
  }

  private async check(): Promise<UpdaterStatus> {
    this.cancelRequested = false;
    this.setStatus({ state: 'checking' });
    const abort = new AbortController();
    this.activeAbort = abort;
    const timeout = setTimeout(() => abort.abort(), this.checkTimeoutMs);
    timeout.unref();
    try {
      const response = await this.fetcher(this.manifestUrl, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        signal: abort.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new UpdaterFailure('UPDATE_MANIFEST_FETCH_FAILED');
      let manifest: SignedUpdateManifest;
      try {
        manifest = signedUpdateManifestSchema.parse(
          JSON.parse(await readBoundedText(response, MAX_MANIFEST_BYTES)),
        );
      } catch (error) {
        if (error instanceof UpdaterFailure) throw error;
        throw new UpdaterFailure('UPDATE_MANIFEST_INVALID');
      }
      const artifactUrl = secureUpdateUrl(manifest.artifact.url);
      if (artifactUrl.origin !== this.manifestUrl.origin)
        throw new UpdaterFailure('UPDATE_ARTIFACT_ORIGIN_MISMATCH');
      if (!this.verifyManifest(manifest)) throw new UpdaterFailure('UPDATE_SIGNATURE_INVALID');
      if (compareVersions(manifest.version, this.options.currentVersion) <= 0) {
        this.manifest = undefined;
        await this.removeReadyArtifact();
        return this.setStatus({ state: 'idle' });
      }
      await this.removeReadyArtifact();
      this.manifest = manifest;
      return this.setStatus({ state: 'available', availableVersion: manifest.version });
    } catch (error) {
      if (abort.signal.aborted && this.cancelRequested) return this.setStatus({ state: 'idle' });
      return this.fail(
        error,
        abort.signal.aborted ? 'UPDATE_CHECK_TIMEOUT' : 'UPDATE_CHECK_FAILED',
      );
    } finally {
      clearTimeout(timeout);
      if (this.activeAbort === abort) this.activeAbort = undefined;
    }
  }

  private async download(): Promise<UpdaterStatus> {
    const manifest = this.manifest;
    if (!manifest) return this.setStatus({ state: 'error', errorCode: 'UPDATE_NOT_AVAILABLE' });
    this.cancelRequested = false;
    const abort = new AbortController();
    this.activeAbort = abort;
    const timeout = setTimeout(() => abort.abort(), this.downloadTimeoutMs);
    timeout.unref();
    const temporaryPath = join(
      this.options.downloadDirectory,
      `${manifest.artifact.fileName}.part`,
    );
    const finalPath = join(this.options.downloadDirectory, manifest.artifact.fileName);
    this.setStatus({
      state: 'downloading',
      availableVersion: manifest.version,
      progress: 0,
    });
    await mkdir(this.options.downloadDirectory, { recursive: true, mode: 0o700 });
    await rm(temporaryPath, { force: true });
    let output: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const response = await this.fetcher(secureUpdateUrl(manifest.artifact.url), {
        method: 'GET',
        redirect: 'error',
        signal: abort.signal,
        headers: { Accept: 'application/octet-stream' },
      });
      if (!response.ok || !response.body) throw new UpdaterFailure('UPDATE_DOWNLOAD_FAILED');
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength !== manifest.artifact.size)
        throw new UpdaterFailure('UPDATE_ARTIFACT_SIZE_MISMATCH');
      output = await open(temporaryPath, 'wx', 0o600);
      const digest = createHash('sha256');
      const reader = response.body.getReader();
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > manifest.artifact.size) {
          await reader.cancel();
          throw new UpdaterFailure('UPDATE_ARTIFACT_SIZE_MISMATCH');
        }
        digest.update(value);
        await output.write(value);
        this.setStatus({
          state: 'downloading',
          availableVersion: manifest.version,
          progress: Math.min(99, Math.floor((received * 100) / manifest.artifact.size)),
        });
      }
      await output.sync();
      await output.close();
      output = undefined;
      if (received !== manifest.artifact.size)
        throw new UpdaterFailure('UPDATE_ARTIFACT_SIZE_MISMATCH');
      if (digest.digest('hex') !== manifest.artifact.sha256)
        throw new UpdaterFailure('UPDATE_ARTIFACT_HASH_MISMATCH');
      await rm(finalPath, { force: true });
      await rename(temporaryPath, finalPath);
      this.readyPath = finalPath;
      return this.setStatus({
        state: 'ready',
        availableVersion: manifest.version,
        progress: 100,
      });
    } catch (error) {
      await output?.close().catch(() => {});
      await rm(temporaryPath, { force: true });
      if (abort.signal.aborted && this.cancelRequested)
        return this.setStatus({ state: 'available', availableVersion: manifest.version });
      return this.fail(
        error,
        abort.signal.aborted ? 'UPDATE_DOWNLOAD_TIMEOUT' : 'UPDATE_DOWNLOAD_FAILED',
        manifest.version,
      );
    } finally {
      clearTimeout(timeout);
      if (this.activeAbort === abort) this.activeAbort = undefined;
    }
  }

  private async cancel(): Promise<UpdaterStatus> {
    if (!this.activeAbort || !this.activeOperation) return this.status();
    this.cancelRequested = true;
    this.activeAbort.abort();
    await this.activeOperation.catch(() => {});
    return this.status();
  }

  private async install(): Promise<UpdaterStatus> {
    if (this.currentStatus.state !== 'ready' || !this.readyPath || !this.manifest)
      return this.setStatus({ state: 'error', errorCode: 'UPDATE_NOT_READY' });
    try {
      const artifact = await hashFileBounded(this.readyPath, this.manifest.artifact.size);
      if (artifact.bytes !== this.manifest.artifact.size)
        throw new UpdaterFailure('UPDATE_ARTIFACT_SIZE_MISMATCH');
      if (artifact.sha256 !== this.manifest.artifact.sha256)
        throw new UpdaterFailure('UPDATE_ARTIFACT_HASH_MISMATCH');
      const error = await this.options.openInstaller(this.readyPath);
      if (error) throw new UpdaterFailure('UPDATE_INSTALL_FAILED');
      return this.status();
    } catch (error) {
      return this.fail(error, 'UPDATE_INSTALL_FAILED', this.currentStatus.availableVersion);
    }
  }

  private verifyManifest(manifest: SignedUpdateManifest): boolean {
    try {
      return verify(
        null,
        Buffer.from(canonicalManifestRecord(manifest), 'utf8'),
        this.publicKey,
        Buffer.from(manifest.artifact.signature, 'base64'),
      );
    } catch {
      return false;
    }
  }

  private fail(error: unknown, fallback: string, availableVersion?: string): UpdaterStatus {
    const errorCode = error instanceof UpdaterFailure ? error.code : fallback;
    return this.setStatus({
      state: 'error',
      errorCode,
      ...(availableVersion ? { availableVersion } : {}),
    });
  }

  private setStatus(status: UpdaterStatus): UpdaterStatus {
    this.currentStatus = updaterStatusSchema.parse(status);
    return this.status();
  }

  private async removeReadyArtifact(): Promise<void> {
    if (!this.readyPath) return;
    const previous = this.readyPath;
    this.readyPath = undefined;
    await rm(previous, { force: true });
  }
}

export function createDesktopUpdaterFromEnvironment(
  options: UpdaterEnvironmentOptions,
): DesktopUpdaterPort {
  const environment = options.environment ?? process.env;
  const manifestUrl = environment.AXTERM_UPDATE_MANIFEST_URL?.trim();
  const publicKeyBase64 = environment.AXTERM_UPDATE_PUBLIC_KEY_BASE64?.trim();
  if (!manifestUrl && !publicKeyBase64) return new DisabledDesktopUpdater();
  if (!manifestUrl || !publicKeyBase64) return new MisconfiguredDesktopUpdater();
  try {
    return new SignedReleaseUpdater({
      currentVersion: options.currentVersion,
      manifestUrl,
      publicKeyBase64,
      downloadDirectory: options.downloadDirectory,
      openInstaller: options.openInstaller,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
  } catch {
    return new MisconfiguredDesktopUpdater();
  }
}

export function canonicalManifestRecord(manifest: SignedUpdateManifest): string {
  return [
    manifest.version,
    manifest.publishedAt,
    manifest.artifact.fileName,
    String(manifest.artifact.size),
    manifest.artifact.sha256,
    manifest.artifact.url,
  ].join('\n');
}

function secureUpdateUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new UpdaterFailure('UPDATE_URL_UNSAFE');
  if (url.username || url.password) throw new UpdaterFailure('UPDATE_URL_UNSAFE');
  return url;
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) throw new UpdaterFailure('UPDATE_MANIFEST_FETCH_FAILED');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new UpdaterFailure('UPDATE_MANIFEST_TOO_LARGE');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

async function hashFileBounded(path: string, maximumBytes: number) {
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) throw new UpdaterFailure('UPDATE_ARTIFACT_SIZE_MISMATCH');
    digest.update(chunk);
  }
  return { bytes, sha256: digest.digest('hex') };
}

function compareVersions(left: string, right: string): number {
  const numeric = (value: string) =>
    value
      .split('-', 1)[0]!
      .split('.')
      .slice(0, 3)
      .map((part) => Number(part));
  const a = numeric(left);
  const b = numeric(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return left.includes('-') === right.includes('-') ? 0 : left.includes('-') ? -1 : 1;
}
