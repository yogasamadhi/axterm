import { createHash, randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { RemoteError } from '@axterm/plugin-api';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
import * as C from '@axterm/plugin-api/automation';
import type { FileGrantLease, AiMcpToolSource } from '@axterm/plugin-api/host';
import type {
  RunningWidgetServer,
  RunningMcpServer,
  WidgetServerAdapters,
  WidgetCommandReceipts,
} from '../ports/widgets.ts';
const definitions: C.WidgetDefinition[] = [
  {
    id: 'file-renamer',
    name: 'File Renamer',
    description: 'Batch rename files in a granted folder using a reviewed template.',
    version: '1.0.0',
    type: 'once',
    builtin: true,
    singleInstance: false,
  },
  {
    id: 'local-file-server',
    name: 'Static File Server',
    description: 'Serve files from a granted local folder over a bounded HTTP server.',
    version: '1.0.0',
    type: 'instance',
    builtin: true,
    singleInstance: false,
  },
  {
    id: 'local-ftp-server',
    name: 'Local FTP Server',
    description: 'Share a granted folder through a bounded local FTP server.',
    version: '1.0.0',
    type: 'instance',
    builtin: true,
    singleInstance: false,
  },
  {
    id: 'local-ssh-server',
    name: 'SSH Server',
    description: 'Expose a granted folder through a local SSH, shell and SFTP server.',
    version: '1.0.0',
    type: 'instance',
    builtin: true,
    singleInstance: false,
  },
  {
    id: 'mcp-server',
    name: 'MCP Server',
    description: 'Expose the bounded Axterm AI Tool Registry through authenticated MCP.',
    version: '1.0.0',
    type: 'instance',
    builtin: true,
    singleInstance: true,
  },
];
interface Owned {
  metadata: C.WidgetInstance;
  server?: RunningWidgetServer;
  release?: () => Promise<void>;
  source?: AiMcpToolSource;
  stop?: Promise<void>;
  starting?: Promise<void>;
}
interface Command {
  resource?: string;
  identity: string;
  outcome: C.WidgetCommandOutcome;
  task: Promise<C.WidgetCommandOutcome>;
}
/** Transient generation-owned resources. No password or native path enters facts or receipts. */
export class WidgetServers {
  private closed = false;
  private cursor = 0;
  private readonly instances = new Map<string, Owned>();
  private readonly commands = new Map<string, Command>();
  private readonly followers = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly stats: ReturnType<typeof setInterval>;
  private statusText = '';
  constructor(
    private readonly ctx: Context,
    private readonly generation: string,
    private readonly adapters: WidgetServerAdapters,
    private readonly receipts: WidgetCommandReceipts,
  ) {
    this.stats = setInterval(() => {
      if (this.closed) return;
      const next = JSON.stringify(
        [...this.instances.values()].flatMap((item) =>
          item.server && 'status' in item.server
            ? [(item.server as RunningMcpServer).status()]
            : [],
        ),
      );
      if (next !== this.statusText) {
        this.statusText = next;
        this.changed();
      }
    }, 1000);
    this.stats.unref();
  }
  resourceSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({
      widgetInstances: this.instances.size,
      widgetRequests: this.pending.size,
      widgetFollowers: this.followers.size,
      widgetCommandReceipts: this.commands.size,
    });
  }
  active(): boolean {
    return this.instances.size > 0 || this.pending.size > 0;
  }
  private failure(reason: C.WidgetFailureReason) {
    return new RemoteError('automation/widget-failure', 'The Widget operation failed', { reason });
  }
  private changed() {
    this.cursor++;
    for (const notify of this.followers) notify();
  }
  facts(): C.WidgetFacts {
    return {
      generation: this.generation,
      cursor: this.cursor,
      definitions: structuredClone(definitions),
      instances: [...this.instances.values()].map((item) => {
        const metadata = structuredClone(item.metadata);
        if (metadata.serverInfo && item.server && 'status' in item.server)
          Object.assign(metadata.serverInfo, (item.server as RunningMcpServer).status());
        return metadata;
      }),
      mcpTools: (this.ctx.get('aiMcpTools')?.listTools() ?? []).map(
        ({ name, title, description, risk }) => ({ name, title, description, risk }),
      ),
    };
  }
  outcome(key: string, generation: string): C.WidgetCommandOutcome {
    this.checkGeneration(generation);
    if (!/^[0-9a-f-]{36}$/u.test(key)) throw this.failure('invalid-input');
    const command = this.commands.get(key);
    if (
      command?.outcome.reason === 'uncertain' &&
      command.resource &&
      !this.instances.has(command.resource)
    )
      return { ...structuredClone(command.outcome), reason: 'unavailable' };
    return structuredClone(
      command?.outcome ?? {
        key,
        generation,
        status: this.receipts.has(key) ? 'failed' : 'missing',
        ...(this.receipts.has(key) ? { reason: 'receipt-expired' as const } : {}),
        cursor: this.cursor,
      },
    );
  }
  private checkGeneration(generation: string) {
    if (generation !== this.generation) throw this.failure('stale');
  }
  private command(
    key: string,
    generation: string,
    operation: string,
    input: unknown,
    run: () => Promise<C.WidgetInstance | undefined>,
  ): Promise<C.WidgetCommandOutcome> {
    this.checkGeneration(generation);
    if (this.closed) throw this.failure('closed');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(key))
      throw this.failure('invalid-input');
    const identity = createHash('sha256')
      .update(operation)
      .update(JSON.stringify(input))
      .digest('hex');
    const previous = this.commands.get(key);
    if (previous) {
      if (previous.identity !== identity) throw this.failure('conflict');
      return previous.task.then((value) => structuredClone(value));
    }
    if (this.pending.size >= 32) throw this.failure('capacity');
    if (this.commands.size >= 2048) {
      for (const [oldKey, old] of this.commands) {
        if (old.outcome.status === 'pending') continue;
        this.commands.delete(oldKey);
        if (this.commands.size < 2048) break;
      }
    }
    if (!this.receipts.admit(key, operation, input))
      return Promise.resolve({
        key,
        generation,
        status: 'failed',
        reason: 'receipt-expired',
        cursor: this.cursor,
      });
    const command: Command = {
      identity,
      outcome: { key, generation, status: 'pending', cursor: this.cursor },
      task: Promise.resolve(undefined as never),
    };
    command.task = Promise.resolve()
      .then(run)
      .then(
        (instance) =>
          (command.outcome = {
            key,
            generation,
            status: 'completed',
            cursor: this.cursor,
            ...(instance ? { instance: structuredClone(instance) } : {}),
          }),
        (error) =>
          (command.outcome = {
            key,
            generation,
            status: 'failed',
            cursor: this.cursor,
            reason:
              error instanceof RemoteError && error.code === 'automation/widget-failure'
                ? (error.details as { reason: C.WidgetFailureReason }).reason
                : 'unavailable',
          }),
      );
    this.commands.set(key, command);
    this.pending.add(command.task);
    void command.task.finally(() => this.pending.delete(command.task));
    return command.task.then((value) => structuredClone(value));
  }
  start(
    key: string,
    generation: string,
    kind: Exclude<C.WidgetId, 'file-renamer'>,
    raw: unknown,
  ): Promise<C.WidgetCommandOutcome> {
    const captured = structuredClone(raw);
    return this.command(key, generation, 'start:' + kind, captured, async () => {
      if (this.closed) throw this.failure('closed');
      if (
        this.instances.size >= 8 ||
        (kind === 'mcp-server' &&
          [...this.instances.values()].some((item) => item.metadata.widgetId === kind))
      )
        throw this.failure('capacity');
      const schema =
        kind === 'local-file-server'
          ? C.startLocalFileServerSchema
          : kind === 'local-ftp-server'
            ? C.startLocalFtpServerSchema
            : kind === 'local-ssh-server'
              ? C.startLocalSshServerSchema
              : C.startMcpServerSchema;
      const parsed = schema.safeParse(captured);
      if (!parsed.success) throw this.failure('invalid-input');
      const input = parsed.data,
        id = randomUUID(),
        now = new Date().toISOString();
      const owned: Owned = {
        metadata: {
          id,
          widgetId: kind,
          title: input.title,
          state: 'starting',
          bindHost: null,
          port: null,
          serverInfo: null,
          ownerGeneration: this.generation,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      };
      const started = Promise.withResolvers<void>();
      owned.starting = started.promise;
      this.commands.get(key)!.resource = id;
      this.instances.set(id, owned);
      this.changed();
      try {
        let rootName = 'AI Tool Registry',
          username: string | null = null,
          authentication: 'none' | 'password' | 'bearer' = 'none';
        if (kind === 'mcp-server') {
          const mcp = C.startMcpServerSchema.parse(captured),
            ai = this.ctx.get('aiMcpTools'),
            credentials = this.ctx.get('credentials');
          owned.release = async () => {
            if (mcp.ownedCredential) {
              const cleanup = this.ctx.get('temporaryCredentials');
              if (!cleanup) throw this.failure('unavailable');
              await cleanup.removeOwned(
                randomUUID(),
                this.generation,
                mcp.credentialRef,
                mcp.ownedCredential,
              );
            }
          };
          if (!ai || !credentials) throw this.failure('unavailable');
          const source = (owned.source = ai.registerSource('widget_' + id));
          const available = new Set(source.listTools().map((tool) => tool.name));
          if (mcp.enabledTools.some((name) => !available.has(name)))
            throw this.failure('invalid-input');
          const resolveApiKey = async () => {
            const value = await credentials.resolve(encodeOpaqueCredentialRef(mcp.credentialRef));
            if (!value?.value) throw this.failure('unavailable');
            return value.value;
          };
          await resolveApiKey();
          owned.server = await this.adapters.mcp.start({
            ...mcp,
            resolveApiKey,
            gateway: {
              listTools: () => [...source.listTools()],
              callTool: (...args) => source.callTool(...args),
            },
          });
          authentication = 'bearer';
        } else {
          const grants = this.ctx.get('fileGrants');
          if (!grants) throw this.failure('unavailable');
          const leases: FileGrantLease[] = [];
          owned.release = async () => {
            for (const lease of leases) lease.dispose();
          };
          const read = await grants.authorize(
            'grantId' in input ? input.grantId : '',
            'read',
            this.lifetime.signal,
          );
          leases.push(read);
          if (read.authority.grant.kind !== 'directory') throw this.failure('invalid-input');
          rootName = read.authority.grant.name;
          if (kind !== 'local-file-server')
            leases.push(
              await grants.authorize(read.authority.grant.grantId, 'write', this.lifetime.signal),
            );
          const assertAuthority = () => this.adapters.assertAuthority(leases);
          await assertAuthority();
          if (kind === 'local-file-server') {
            const files = this.ctx.get('files');
            if (!files) throw this.failure('unavailable');
            const fileLease = await files.open(
                read.authority.grant.grantId,
                'read',
                this.lifetime.signal,
              ),
              release = owned.release;
            owned.release = async () => {
              await fileLease.close();
              await release?.();
            };
            owned.server = await this.adapters.file.start({
              ...C.startLocalFileServerSchema.parse(captured),
              files: fileLease,
            });
          } else if (kind === 'local-ftp-server') {
            const ftp = C.startLocalFtpServerSchema.parse(captured);
            username = ftp.anonymous ? 'anonymous' : ftp.username;
            authentication = ftp.anonymous ? 'none' : 'password';
            owned.server = await this.adapters.ftp.start({
              ...ftp,
              rootPath: read.authority.rootPath,
              assertAuthority,
            });
          } else {
            const ssh = C.startLocalSshServerSchema.parse(captured),
              subprocess = this.ctx.get('subprocess');
            if (!subprocess) throw this.failure('unavailable');
            username = ssh.username;
            authentication = 'password';
            owned.server = await this.adapters.ssh(subprocess).start({
              ...ssh,
              rootPath: read.authority.rootPath,
              assertAuthority,
            });
          }
          for (const lease of leases) {
            const revoked = () => {
              void this.stopOwned(owned).catch(() => undefined);
            };
            lease.signal.addEventListener('abort', revoked, { once: true });
            const release = owned.release;
            owned.release = async () => {
              lease.signal.removeEventListener('abort', revoked);
              await release?.();
            };
          }
        }
        if (this.closed || this.lifetime.signal.aborted) {
          await this.stopOwned(owned, true);
          throw this.failure('closed');
        }
        const server = owned.server!;
        owned.metadata = {
          ...owned.metadata,
          state: 'running',
          bindHost: server.host,
          port: server.port,
          serverInfo: {
            url: server.url,
            rootName,
            username,
            authentication,
            protocol:
              kind === 'local-file-server'
                ? 'http'
                : kind === 'local-ftp-server'
                  ? 'ftp'
                  : kind === 'local-ssh-server'
                    ? 'ssh'
                    : 'mcp',
          },
          version: 2,
          updatedAt: new Date().toISOString(),
        };
        this.changed();
        return owned.metadata;
      } catch (error) {
        try {
          await this.stopOwned(owned, true);
        } catch {
          owned.metadata.state = 'failed';
          owned.metadata.errorCode = 'WIDGET_CLEANUP_FAILED';
          this.changed();
          throw this.failure('uncertain');
        }
        throw error;
      } finally {
        delete owned.starting;
        started.resolve();
      }
    });
  }
  rename(
    key: string,
    generation: string,
    id: string,
    input: C.RenameWidgetInstanceInput,
  ): Promise<C.WidgetCommandOutcome> {
    return this.command(key, generation, 'rename', { id, input }, async () => {
      const parsed = C.renameWidgetInstanceSchema.safeParse(input),
        owned = this.instances.get(id);
      if (!parsed.success) throw this.failure('invalid-input');
      if (!owned) throw this.failure('not-found');
      if (owned.metadata.state !== 'running') throw this.failure('conflict');
      owned.metadata = {
        ...owned.metadata,
        title: parsed.data.title,
        version: owned.metadata.version + 1,
        updatedAt: new Date().toISOString(),
      };
      this.changed();
      return owned.metadata;
    });
  }
  stop(key: string, generation: string, id: string): Promise<C.WidgetCommandOutcome> {
    return this.command(key, generation, 'stop', id, async () => {
      const owned = this.instances.get(id);
      if (!owned) throw this.failure('not-found');
      await this.stopOwned(owned);
      return { ...owned.metadata, state: 'stopped' };
    });
  }
  private stopOwned(owned: Owned, fromStart = false): Promise<void> {
    if (owned.starting && !fromStart) return owned.starting.then(() => this.stopOwned(owned));
    return (owned.stop ??= (async () => {
      owned.metadata = {
        ...owned.metadata,
        state: 'stopping',
        version: owned.metadata.version + 1,
        updatedAt: new Date().toISOString(),
      };
      this.changed();
      const results = await Promise.allSettled([owned.source?.close(), owned.server?.stop()]);
      if (results.some((result) => result.status === 'rejected')) {
        owned.metadata.state = 'failed';
        owned.metadata.errorCode = 'WIDGET_STOP_FAILED';
        this.changed();
        throw this.failure('unavailable');
      }
      await owned.release?.();
      this.instances.delete(owned.metadata.id);
      this.changed();
    })().catch((error) => {
      delete owned.stop;
      owned.metadata.state = 'failed';
      owned.metadata.errorCode = 'WIDGET_STOP_FAILED';
      this.changed();
      throw error;
    }));
  }
  async stopMcp(): Promise<void> {
    await Promise.all(
      [...this.instances.values()]
        .filter((item) => item.metadata.widgetId === 'mcp-server')
        .map((item) => this.stopOwned(item)),
    );
  }
  watch(signal: AbortSignal): AsyncIterableIterator<C.WidgetUpdate> {
    signal.throwIfAborted();
    if (this.closed) throw this.failure('closed');
    if (this.followers.size >= 64) throw this.failure('capacity');
    let open = true,
      wake: (() => void) | undefined;
    const notify = () => wake?.();
    const close = () => {
      open = false;
      this.followers.delete(notify);
      signal.removeEventListener('abort', close);
      this.lifetime.signal.removeEventListener('abort', close);
      notify();
    };
    this.followers.add(notify);
    signal.addEventListener('abort', close, { once: true });
    this.lifetime.signal.addEventListener('abort', close, { once: true });
    const iterator = async function* (this: WidgetServers): AsyncGenerator<C.WidgetUpdate> {
      let cursor = -1;
      try {
        while (open) {
          const wait = Promise.withResolvers<void>();
          wake = () => wait.resolve();
          if (cursor === this.cursor) {
            await wait.promise;
            continue;
          }
          const facts = this.facts();
          yield { ...facts, type: cursor < 0 ? 'baseline' : 'replace' };
          cursor = facts.cursor;
        }
      } finally {
        close();
      }
    }.call(this);
    return {
      next: () => iterator.next(),
      return: async () => {
        close();
        return iterator.return(undefined);
      },
      throw: async (error) => {
        close();
        return iterator.throw(error);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.stats);
    this.lifetime.abort();
    await Promise.allSettled([...this.pending]);
    const result = await Promise.allSettled(
      [...this.instances.values()].map((item) => this.stopOwned(item)),
    );
    if (result.some((item) => item.status === 'rejected')) throw this.failure('unavailable');
    this.commands.clear();
  }
}
