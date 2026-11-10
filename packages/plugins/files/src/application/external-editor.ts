import { createHash } from 'node:crypto';
import { posix, join } from 'node:path';
import { Readable } from 'node:stream';
import { RemoteError, remoteErrorOf } from '@axterm/plugin-api';
import * as Contract from '@axterm/plugin-api/files';
import type { Context } from '@deepseek-ai/cordis';
import type { HostFiles, SubprocessHandle } from '@axterm/plugin-api/host';
import type { FileCommands } from '../ports/commands.ts';
import type { RemoteFileApplication } from './remote-files.ts';
const failure = (reason: Contract.FilesFailureReason) =>
  new RemoteError('files/failure', 'External editing could not complete', { reason });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
interface Session {
  value: Contract.ExternalEditorSession;
  grantId: string;
  revision: string;
  lineEnding: 'lf' | 'crlf';
  hash: string;
  busy: boolean;
  process?: SubprocessHandle;
  launchFailed?: boolean;
}
/** Transient edit authority; only compact statuses cross observation and journal boundaries. */
export class ExternalEditorApplication {
  private readonly sessions = new Map<string, Session>();
  private readonly orphans = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private admissions = 0;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly ctx: Context,
    private readonly files: HostFiles,
    private readonly remote: Pick<RemoteFileApplication, 'readText' | 'saveExternalText'>,
    private readonly commands: FileCommands,
  ) {}
  resourceCount() {
    return this.sessions.size + this.orphans.size + this.admissions + this.pending.size;
  }
  create(key: string, input: Contract.CreateExternalEditor, signal: AbortSignal) {
    const parsed = Contract.createExternalEditorSchema.parse(input);
    this.generation(parsed.generation);
    return this.commands.execute(
      key,
      'createExternalEditor',
      parsed,
      (owned) =>
        this.run(owned, async (lifetime) => {
          if (this.sessions.size + this.orphans.size + this.admissions >= 8)
            throw failure('capacity');
          const imports = this.ctx.get('fileImports'),
            applications = this.ctx.get('fileApplications');
          if (!imports || !applications) throw failure('unavailable');
          this.admissions++;
          let managed: string | undefined, session: Session | undefined;
          try {
            const document = await this.remote.readText(parsed.target, parsed.path, lifetime);
            const name = localEditorFileName(parsed.path);
            const bytes = Buffer.from(document.content, 'utf8');
            if (bytes.length > Contract.MANAGED_EDITABLE_IMPORT_MAX_BYTES || bytes.includes(0))
              throw failure('capacity');
            const grant = await imports.prepare(
              { name, size: bytes.length, editable: true, editableDirectory: true },
              lifetime,
            );
            managed = grant.grantId;
            this.orphans.add(managed);
            const lease = await this.files.open(grant.grantId, 'write', lifetime);
            try {
              await lease.write(lease.path, Readable.from([bytes]));
            } finally {
              await lease.close();
            }
            const directory = await imports.commit(grant.grantId, lifetime);
            this.orphans.delete(managed);
            managed = directory.grantId;
            this.orphans.add(managed);
            if (directory.kind !== 'directory' || !directory.expiresAt)
              throw failure('unavailable');
            lifetime.throwIfAborted();
            const now = new Date().toISOString();
            session = {
              value: {
                id: key,
                target: parsed.target,
                remotePath: parsed.path,
                fileName: name,
                state: 'watching',
                createdAt: now,
                updatedAt: now,
                expiresAt: directory.expiresAt,
              },
              grantId: directory.grantId,
              revision: document.revision,
              lineEnding: document.lineEnding,
              hash: digest(document.content),
              busy: true,
            };
            this.sessions.set(key, session);
            this.orphans.delete(managed);
            const executable = this.ctx.get('configuration')?.getSettings()
              .fileManager.externalEditor;
            if (executable) {
              const subprocess = this.ctx.get('subprocess'),
                grants = this.ctx.get('fileGrants');
              if (!subprocess || !grants) throw failure('unavailable');
              const cwd = await grants.resolveDirectory(directory.grantId, '', lifetime);
              const process = subprocess.spawn({
                argv: [executable, join(cwd, name)],
                cwd,
                stdio: { stdin: 'ignore', stdout: { maxBytes: 0 }, stderr: { maxBytes: 0 } },
                graceMs: 1000,
                signal: this.lifetime.signal,
              });
              session.process = process;
              const selected = session;
              void process.done.then(
                (outcome) => {
                  if (outcome.exitCode !== 0 && this.sessions.get(key) === selected) {
                    selected.launchFailed = true;
                    this.mark(selected, 'error', 'unavailable');
                  }
                },
                () => {
                  if (this.sessions.get(key) === selected) {
                    selected.launchFailed = true;
                    this.mark(selected, 'error', 'unavailable');
                  }
                },
              );
            } else await applications.open(directory.grantId, name, lifetime);
            return 1;
          } catch (error) {
            if (session) {
              session.launchFailed = true;
              const reason =
                remoteErrorOf(error)?.code === 'files/failure'
                  ? (remoteErrorOf(error)!.details as { reason: Contract.FilesFailureReason })
                  : undefined;
              this.mark(session, 'error', reason?.reason ?? 'uncertain');
              // A possibly accepted editor must never lose its only local copy automatically.
              throw failure(reason?.reason ?? 'uncertain');
            }
            if (managed) {
              await imports.discard(managed);
              this.orphans.delete(managed);
            }
            throw error;
          } finally {
            if (session) session.busy = false;
            this.admissions--;
          }
        }),
      signal,
    );
  }
  async snapshot(signal: AbortSignal): Promise<{ sessions: Contract.ExternalEditorSession[] }> {
    return this.run(signal, async (owned) => {
      const values = [...this.sessions.values()];
      for (const session of values) {
        if (session.busy) continue;
        session.busy = true;
        try {
          const content = await this.read(session, owned);
          const state =
            digest(content) === session.hash
              ? session.value.state === 'saved'
                ? 'saved'
                : 'watching'
              : session.value.state === 'conflict'
                ? 'conflict'
                : 'changed';
          // Keep a failed launch visible until an explicit close, even if its copy is unchanged.
          if (!session.launchFailed) this.mark(session, state);
        } catch (error) {
          if (owned.aborted) throw error;
          const marked = remoteErrorOf(error);
          this.mark(
            session,
            'error',
            marked?.code === 'files/failure' ? marked.details.reason : 'unavailable',
          );
        } finally {
          session.busy = false;
        }
      }
      return {
        sessions: [...this.sessions.values()].map((session) =>
          Contract.externalEditorSessionSchema.parse(session.value),
        ),
      };
    });
  }
  push(generation: string, key: string, id: string, signal: AbortSignal) {
    this.generation(generation);
    return this.commands.execute(
      key,
      'pushExternalEditor',
      { generation, id },
      (owned) =>
        this.run(owned, async (lifetime) => {
          const session = this.acquire(id);
          try {
            const content = await this.read(session, lifetime);
            const saved = await this.remote.saveExternalText(
              session.value.target,
              {
                path: session.value.remotePath,
                content,
                overwriteRevision: session.revision,
                lineEnding: session.lineEnding,
              },
              lifetime,
            );
            session.revision = saved.revision;
            session.hash = digest(content);
            this.mark(session, 'saved');
            return 1;
          } catch (error) {
            const marked = remoteErrorOf(error),
              reason =
                marked?.code === 'files/failure'
                  ? marked.details.reason
                  : lifetime.aborted
                    ? 'uncertain'
                    : 'unavailable';
            this.mark(session, reason === 'conflict' ? 'conflict' : 'error', reason);
            throw failure(reason);
          } finally {
            session.busy = false;
          }
        }),
      signal,
    );
  }
  remove(generation: string, key: string, id: string, signal: AbortSignal) {
    this.generation(generation);
    return this.commands.execute(
      key,
      'closeExternalEditor',
      { generation, id },
      (owned) =>
        this.run(owned, async () => {
          const session = this.acquire(id);
          try {
            await this.discard(session);
            return 1;
          } finally {
            session.busy = false;
          }
        }),
      signal,
    );
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.pending]);
      const orphanResults = await Promise.allSettled(
        [...this.orphans].map(async (id) => {
          const imports = this.ctx.get('fileImports');
          if (!imports) throw failure('unavailable');
          await imports.discard(id);
          this.orphans.delete(id);
        }),
      );
      const results = await Promise.allSettled(
        [...this.sessions.values()].map((session) => this.discard(session)),
      );
      if (
        [...results, ...orphanResults].some((r) => r.status === 'rejected') ||
        this.sessions.size ||
        this.orphans.size ||
        this.admissions
      )
        throw failure('uncertain');
    })());
  }
  private generation(value: string) {
    this.assert();
    if (value !== this.ctx.runtimeIdentity.generation) throw failure('stale');
  }
  private acquire(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw failure('not-found');
    if (session.busy) throw failure('conflict');
    session.busy = true;
    return session;
  }
  private async discard(session: Session) {
    await session.process?.dispose();
    const imports = this.ctx.get('fileImports');
    if (!imports) throw failure('unavailable');
    await imports.discard(session.grantId);
    this.sessions.delete(session.value.id);
  }
  private mark(
    session: Session,
    state: Contract.ExternalEditorSession['state'],
    reason?: Contract.FilesFailureReason,
  ) {
    if (session.value.state === state && session.value.reason === reason) return;
    session.value = { ...session.value, state, updatedAt: new Date().toISOString() };
    if (reason) session.value.reason = reason;
    else delete session.value.reason;
  }
  private async read(session: Session, signal: AbortSignal) {
    if (Date.parse(session.value.expiresAt) <= Date.now()) throw failure('stale');
    const lease = await this.files.open(session.grantId, 'read', signal);
    try {
      const stream = await lease.read(session.value.fileName),
        chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const raw of stream) {
          signal.throwIfAborted();
          const chunk = Buffer.from(raw);
          size += chunk.length;
          if (size > Contract.MANAGED_EDITABLE_IMPORT_MAX_BYTES) throw failure('capacity');
          chunks.push(chunk);
        }
      } finally {
        stream.destroy();
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.includes(0)) throw failure('invalid-input');
      try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw failure('invalid-input');
      }
    } finally {
      await lease.close();
    }
  }
  private assert() {
    if (this.closing || this.lifetime.signal.aborted) throw failure('closed');
  }
  private run<T>(signal: AbortSignal, perform: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assert();
    if (this.pending.size >= 16) return Promise.reject(failure('capacity'));
    const owned = AbortSignal.any([signal, this.lifetime.signal]);
    const task = Promise.resolve().then(() => {
      owned.throwIfAborted();
      return perform(owned);
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
}

/** Retained portable copy naming; no command parsing is involved. */
function localEditorFileName(path: string): string {
  const name = (posix.basename(path) || 'remote.txt')
    .replace(/[<>:"'/\\|?*]/gu, '_')
    .split('')
    .map((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? '_' : character,
    )
    .join('')
    .replace(/[ .]+$/u, '')
    .slice(0, 255);
  return Contract.grantedEntryNameSchema.parse(
    name && name !== '.' && name !== '..' ? name : 'remote.txt',
  );
}
