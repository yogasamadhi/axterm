import { arch, hostname, platform, release } from 'node:os';
import { basename } from 'node:path';
import {
  terminalInformationSnapshotSchema,
  type TerminalInformationGroupName,
  type TerminalInformationSnapshot,
  type TerminalSession,
} from '@axterm/plugin-api/terminals';
import type { ConnectionsApplication, TerminalApplication } from '@axterm/plugin-api/host';

import {
  parseTerminalInformationGroup,
  REMOTE_TERMINAL_INFORMATION_COMMANDS,
  TERMINAL_INFORMATION_TTL_MS,
} from './terminal-information-model.ts';

const GROUPS: TerminalInformationGroupName[] = [
  'sysinfo',
  'cpu',
  'memory',
  'uptime',
  'users',
  'network',
  'disks',
  'activities',
];
const CACHE_LIMIT = 64;
const MAX_COMMAND_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 5_000;

interface CachedGroup {
  state: 'ready' | 'stale' | 'unsupported' | 'error';
  updatedAt: string | null;
  sampledAt: number | null;
  expiresAt: number;
  errorCode: string | null;
  data: unknown;
}

interface TerminalCache {
  touchedAt: number;
  groups: Partial<Record<TerminalInformationGroupName, CachedGroup>>;
  cpuHistory: TerminalInformationSnapshot['cpuHistory'];
}

export class TerminalInformationService {
  private readonly cache = new Map<string, TerminalCache>();
  private readonly inFlight = new Map<
    string,
    { promise: Promise<CachedGroup>; abort: AbortController; consumers: Set<AbortSignal> }
  >();

  private readonly lifetime = new AbortController();
  private readonly snapshots = new Set<Promise<TerminalInformationSnapshot>>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly terminals: Pick<TerminalApplication, 'get' | 'list'>,
    private readonly connections: () => Pick<ConnectionsApplication, 'exec'> | undefined,
  ) {}

  snapshot(terminalId: string, signal?: AbortSignal): Promise<TerminalInformationSnapshot> {
    if (this.lifetime.signal.aborted || this.snapshots.size >= 16)
      return Promise.reject(Error('TERMINAL_INFORMATION_UNAVAILABLE'));
    const owned = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const task = this.sample(terminalId, owned);
    this.snapshots.add(task);
    void task.then(
      () => this.snapshots.delete(task),
      () => this.snapshots.delete(task),
    );
    return task;
  }
  private async sample(
    terminalId: string,
    signal: AbortSignal,
  ): Promise<TerminalInformationSnapshot> {
    signal.throwIfAborted();
    const terminal = this.terminals.get(terminalId);
    this.prune();
    const cache = this.requireCache(terminalId);
    cache.touchedAt = Date.now();
    if (terminal.kind === 'local') return this.localSnapshot(terminal, cache);

    const groups: Partial<Record<TerminalInformationGroupName, CachedGroup>> = {};
    if (terminal.kind === 'ssh' && terminal.connectionId) {
      for (let index = 0; index < GROUPS.length; index += 2) {
        signal.throwIfAborted();
        const names = GROUPS.slice(index, index + 2);
        const resolved = await Promise.all(
          names.map((name) =>
            this.resolveRemoteGroup(
              { ...terminal, connectionId: terminal.connectionId! },
              name,
              cache,
              signal,
            ),
          ),
        );
        names.forEach((name, offset) => (groups[name] = resolved[offset]!));
      }
    } else {
      for (const name of GROUPS) groups[name] = unsupportedGroup();
    }
    return terminalInformationSnapshotSchema.parse({
      terminalId,
      kind: terminal.kind,
      sampledAt: new Date().toISOString(),
      cpuHistory: cache.cpuHistory,
      groups: Object.fromEntries(
        GROUPS.map((name) => [name, presentGroup(groups[name] ?? unsupportedGroup())]),
      ),
    });
  }

  cacheCount(): number {
    this.prune();
    return this.cache.size;
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  resourceSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({
      terminalInformationCaches: this.cache.size,
      terminalInformationRequests: this.inFlight.size + this.snapshots.size,
    });
  }
  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([
        ...this.snapshots,
        ...[...this.inFlight.values()].map((entry) => entry.promise),
      ]);
      this.cache.clear();
      this.inFlight.clear();
    })());
  }

  private localSnapshot(terminal: TerminalSession, cache: TerminalCache) {
    const now = new Date().toISOString();
    const system = readyGroup(
      {
        os: platform(),
        hostname: hostname().slice(0, 255),
        kernel: release().slice(0, 256),
        arch: arch().slice(0, 64),
        shell: basename(process.env.SHELL ?? process.env.COMSPEC ?? '').slice(0, 128),
      },
      now,
      Date.now() + TERMINAL_INFORMATION_TTL_MS.sysinfo,
    );
    cache.groups.sysinfo = system;
    const groups = Object.fromEntries(
      GROUPS.map((name) => [name, name === 'sysinfo' ? system : unsupportedGroup()]),
    );
    return terminalInformationSnapshotSchema.parse({
      terminalId: terminal.id,
      kind: terminal.kind,
      sampledAt: now,
      cpuHistory: [],
      groups: Object.fromEntries(
        GROUPS.map((name) => [name, presentGroup(groups[name] ?? unsupportedGroup())]),
      ),
    });
  }

  private resolveRemoteGroup(
    terminal: TerminalSession & { connectionId: string },
    name: TerminalInformationGroupName,
    cache: TerminalCache,
    signal: AbortSignal,
  ): Promise<CachedGroup> {
    signal.throwIfAborted();
    const existing = cache.groups[name];
    if (existing && existing.expiresAt > Date.now()) return Promise.resolve(existing);
    const key = `${terminal.id}:${name}`;
    let entry = this.inFlight.get(key);
    if (!entry) {
      if (this.inFlight.size >= 16) return Promise.reject(Error('TERMINAL_INFORMATION_CAPACITY'));
      const abort = new AbortController(),
        consumers = new Set<AbortSignal>();
      const promise = this.sampleRemoteGroup(terminal, name, cache, abort.signal).finally(() => {
        if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
      });
      entry = { promise, abort, consumers };
      this.inFlight.set(key, entry);
    }
    const shared = entry;
    shared.consumers.add(signal);
    const release = () => {
      signal.removeEventListener('abort', release);
      shared.consumers.delete(signal);
      if (!shared.consumers.size) shared.abort.abort();
    };
    signal.addEventListener('abort', release, { once: true });
    if (signal.aborted) release();
    return shared.promise.finally(release);
  }

  private async sampleRemoteGroup(
    terminal: TerminalSession & { connectionId: string },
    name: TerminalInformationGroupName,
    cache: TerminalCache,
    signal: AbortSignal,
  ): Promise<CachedGroup> {
    const previous = cache.groups[name];
    try {
      const connections = this.connections();
      if (!connections) throw Error('CONNECTIONS_UNAVAILABLE');
      const result = await connections.exec(terminal.connectionId, {
        command: REMOTE_TERMINAL_INFORMATION_COMMANDS[name],
        maxBytes: MAX_COMMAND_BYTES,
        signal: AbortSignal.any([
          this.lifetime.signal,
          signal,
          AbortSignal.timeout(COMMAND_TIMEOUT_MS),
        ]),
      });
      this.lifetime.signal.throwIfAborted();
      signal.throwIfAborted();
      if (result.exitCode === 126 || result.exitCode === 127) {
        const group = unsupportedGroup();
        cache.groups[name] = group;
        return group;
      }
      if (result.exitCode !== 0) throw new Error('COMMAND_FAILED');
      const sampledAt = Date.now();
      const previousNetwork =
        name === 'network' && previous?.data && previous.sampledAt
          ? {
              data: previous.data as NonNullable<
                TerminalInformationSnapshot['groups']['network']['data']
              >,
              sampledAt: previous.sampledAt,
            }
          : undefined;
      const data = parseTerminalInformationGroup(name, result.stdout, sampledAt, previousNetwork);
      if (data === null) throw new Error('PARSE_FAILED');
      const updatedAt = new Date(sampledAt).toISOString();
      const group = readyGroup(data, updatedAt, sampledAt + TERMINAL_INFORMATION_TTL_MS[name]);
      cache.groups[name] = group;
      if (name === 'cpu' && typeof data === 'number') {
        cache.cpuHistory = [...cache.cpuHistory, { sampledAt: updatedAt, percent: data }].slice(
          -60,
        );
      }
      return group;
    } catch (cause) {
      this.lifetime.signal.throwIfAborted();
      signal.throwIfAborted();
      const errorCode =
        cause instanceof Error && cause.message === 'PARSE_FAILED'
          ? 'PARSE_FAILED'
          : cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')
            ? 'COMMAND_TIMEOUT'
            : 'COMMAND_FAILED';
      const failed: CachedGroup = previous?.data
        ? {
            ...previous,
            state: 'stale',
            errorCode,
            expiresAt: Date.now() + 5_000,
          }
        : {
            state: 'error',
            updatedAt: null,
            sampledAt: null,
            expiresAt: Date.now() + 5_000,
            errorCode,
            data: null,
          };
      cache.groups[name] = failed;
      return failed;
    }
  }

  private requireCache(terminalId: string): TerminalCache {
    const current = this.cache.get(terminalId);
    if (current) return current;
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = [...this.cache.entries()].sort(
        ([, left], [, right]) => left.touchedAt - right.touchedAt,
      )[0]?.[0];
      if (oldest) this.cache.delete(oldest);
    }
    const created: TerminalCache = { touchedAt: Date.now(), groups: {}, cpuHistory: [] };
    this.cache.set(terminalId, created);
    return created;
  }

  private prune(): void {
    const live = new Set(
      this.terminals
        .list()
        .filter(({ state }) => state === 'opening' || state === 'ready')
        .map(({ id }) => id),
    );
    for (const id of this.cache.keys()) if (!live.has(id)) this.cache.delete(id);
  }
}

function readyGroup(data: unknown, updatedAt: string, expiresAt: number): CachedGroup {
  return {
    state: 'ready',
    updatedAt,
    sampledAt: Date.parse(updatedAt),
    expiresAt,
    errorCode: null,
    data,
  };
}

function unsupportedGroup(): CachedGroup {
  return {
    state: 'unsupported',
    updatedAt: null,
    sampledAt: null,
    expiresAt: Number.POSITIVE_INFINITY,
    errorCode: 'UNSUPPORTED',
    data: null,
  };
}

function presentGroup({ state, updatedAt, errorCode, data }: CachedGroup) {
  return { state, updatedAt, errorCode, data };
}
