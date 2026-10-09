import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { ExternalEditorSession } from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type { ProductRepository } from '../adapters/sqlite/product-repository';
import { ApplicationError, isApplicationError } from './errors';
import type { SftpService } from './sftp-service';

const MAX_EXTERNAL_EDITORS = 8;

interface ManagedExternalEditor extends ExternalEditorSession {
  grantId: string;
  remoteRevision: string;
  lineEnding: 'lf' | 'crlf';
  baselineHash: string;
}

export class ExternalEditorService {
  private readonly sessions = new Map<string, ManagedExternalEditor>();

  constructor(
    private readonly sftp: Pick<SftpService, 'readText' | 'writeText'>,
    private readonly host: HostCapabilityClient | undefined,
    private readonly repository?: Pick<ProductRepository, 'getSettings'>,
  ) {}

  async create(connectionId: string, path: string): Promise<ExternalEditorSession> {
    if (this.sessions.size >= MAX_EXTERNAL_EDITORS)
      throw new ApplicationError(
        'INVALID_STATE',
        `At most ${MAX_EXTERNAL_EDITORS} external editors may be open`,
        409,
      );
    const host = this.requireHost();
    const document = await this.sftp.readText(connectionId, path);
    const grant = await host.createEditableFile(localEditorFileName(path), document.content);
    try {
      const editorExecutable =
        this.repository?.getSettings().fileManager.externalEditor || undefined;
      if (editorExecutable) await host.openEditableFile(grant.grantId, editorExecutable);
      else await host.openEditableFile(grant.grantId);
    } catch (error) {
      await host.revokeGrant(grant.grantId).catch(() => {});
      throw error;
    }
    const now = new Date().toISOString();
    const managed: ManagedExternalEditor = {
      id: randomUUID(),
      connectionId,
      remotePath: path,
      fileName: grant.name,
      state: 'watching',
      createdAt: now,
      updatedAt: now,
      expiresAt: grant.expiresAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
      grantId: grant.grantId,
      remoteRevision: document.revision,
      lineEnding: document.lineEnding,
      baselineHash: contentHash(document.content),
    };
    this.sessions.set(managed.id, managed);
    return publicSession(managed);
  }

  async get(id: string): Promise<ExternalEditorSession> {
    const session = this.requireSession(id);
    try {
      const document = await this.requireHost().readGrantedText(session.grantId);
      const changed = contentHash(document.content) !== session.baselineHash;
      const nextState = changed
        ? session.state === 'conflict'
          ? 'conflict'
          : 'changed'
        : session.state === 'saved'
          ? 'saved'
          : 'watching';
      if (nextState !== session.state) {
        session.state = nextState;
        session.updatedAt = new Date().toISOString();
        session.message =
          nextState === 'changed'
            ? 'The local editor copy has changed and is ready to upload'
            : undefined;
      }
    } catch (error) {
      session.state = 'error';
      session.updatedAt = new Date().toISOString();
      session.message = isApplicationError(error)
        ? error.message
        : 'The local editor copy is unavailable';
    }
    return publicSession(session);
  }

  async push(id: string): Promise<ExternalEditorSession> {
    const session = this.requireSession(id);
    const local = await this.requireHost().readGrantedText(session.grantId);
    try {
      const saved = await this.sftp.writeText(session.connectionId, {
        path: session.remotePath,
        content: local.content,
        overwriteRevision: session.remoteRevision,
        lineEnding: session.lineEnding,
      });
      session.remoteRevision = saved.revision;
      session.baselineHash = contentHash(local.content);
      session.state = 'saved';
      session.message = 'Changes uploaded to the remote file';
      session.updatedAt = new Date().toISOString();
      return publicSession(session);
    } catch (error) {
      session.state =
        isApplicationError(error) && error.code === 'REMOTE_EDIT_CONFLICT' ? 'conflict' : 'error';
      session.message =
        session.state === 'conflict'
          ? 'The remote file changed; the local editor copy has been preserved'
          : error instanceof Error
            ? error.message
            : 'The external editor changes could not be uploaded';
      session.updatedAt = new Date().toISOString();
      throw error;
    }
  }

  async close(id: string): Promise<void> {
    const session = this.requireSession(id);
    this.sessions.delete(id);
    await this.requireHost().revokeGrant(session.grantId);
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const host = this.host;
    if (!host) return;
    await Promise.allSettled(sessions.map(({ grantId }) => host.revokeGrant(grantId)));
  }

  resourceCount(): number {
    return this.sessions.size;
  }

  private requireHost(): HostCapabilityClient {
    if (!this.host)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'External editing requires the Desktop Host',
        503,
      );
    return this.host;
  }

  private requireSession(id: string): ManagedExternalEditor {
    const session = this.sessions.get(id);
    if (!session) throw new ApplicationError('NOT_FOUND', 'External editor session not found', 404);
    return session;
  }
}

function publicSession(session: ManagedExternalEditor): ExternalEditorSession {
  const {
    grantId: _grantId,
    remoteRevision: _remoteRevision,
    lineEnding: _lineEnding,
    baselineHash: _baselineHash,
    ...result
  } = session;
  return result;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('base64url');
}

function localEditorFileName(path: string): string {
  const candidate = (posix.basename(path) || 'remote.txt')
    .replace(/[<>:"/\\|?*]/gu, '_')
    .split('')
    .map((character) => (character.codePointAt(0)! < 32 ? '_' : character))
    .join('')
    .replace(/[ .]+$/u, '')
    .slice(0, 255);
  return candidate || 'remote.txt';
}
