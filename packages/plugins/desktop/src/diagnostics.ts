import { Readable } from 'node:stream';
import { z } from 'zod';
import { RemoteError } from '@axterm/plugin-api';
import { defineDomain, domainTable, type Domain } from '@axterm/plugin-api/storage';
import { commandPayloadHash } from '@axterm/infra-storage-domain';
import type { Context } from '@deepseek-ai/cordis';
import type {
  DesktopDiagnostics,
  DesktopDiagnosticLogs,
  DesktopDiagnosticExport,
  DesktopDiagnosticOutcome,
} from '@axterm/plugin-api/desktop';
import type { LocalFileLease } from '@axterm/plugin-api/host';
import type { DesktopUpdates } from './updater.ts';
const rowSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    at: z.number().finite(),
    generation: z.string().max(256),
    level: z.enum(['info', 'warn', 'error', 'debug']),
    code: z.string().regex(/^[A-Z0-9_]{1,100}$/u),
  })
  .strict();
const journalSchema = z
  .object({ rows: z.array(rowSchema).max(1000), dropped: z.number().int().nonnegative() })
  .strict();
const exportSchema = z
  .object({
    fingerprint: z.string().length(64),
    generation: z.string().max(256),
    phase: z.enum(['pending', 'complete', 'uncertain']),
    result: z
      .object({
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(1024 * 1024),
        createdAt: z.iso.datetime(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.phase === 'complete') !== (value.result !== undefined))
      ctx.addIssue({ code: 'custom', message: 'Diagnostic receipt does not match its phase' });
  });
export const desktopDiagnosticsDomain = defineDomain({
  owner: '@axterm/plugin-desktop',
  name: 'desktop_diagnostics',
  version: 1,
  global: {
    schema: journalSchema,
    initial: { rows: [], dropped: 0 } as z.infer<typeof journalSchema>,
  },
  tables: { exports: domainTable(exportSchema) },
});
const codes = new Set([
  'CLIENT_MODULES_REFRESH_FAILED',
  'DESKTOP_TASK_DRAIN_FAILED',
  'DESKTOP_TASK_STATE_UNAVAILABLE',
  'DESKTOP_SHUTDOWN_FAILED',
  'HOST_FAILED',
  'PRELOAD_FAILED',
  'CLIENT_BOOT_FAILED',
  'SHELL_FAILED',
  'REMOTE_EVENT_FAILED',
  'APP_STARTUP_FAILED',
  'PROFILE_START_FAILED',
  'PLUGIN_ACTIVATION_FAILED',
]);
const failure = (
  reason:
    'invalid-input' | 'stale' | 'unavailable' | 'closed' | 'capacity' | 'uncertain' | 'conflict',
) => new RemoteError('desktop/failure', 'Desktop diagnostics failed', { reason });
interface ExportJob {
  readonly fingerprint: string;
  readonly abort: AbortController;
  readonly task: Promise<DesktopDiagnosticExport>;
}
/** All persistent facts use the owned Domain; Files retains sole filesystem authority. */
export class DesktopDiagnosticsOwner {
  private readonly queue: z.infer<typeof rowSchema>[] = [];
  private dropped = 0;
  private sequence: number;
  private writing: Promise<void> | undefined;
  private failed = false;
  private accepting = true;
  private closing: Promise<void> | undefined;
  private readonly jobs = new Map<string, ExportJob>();
  private readonly leases = new Map<string, LocalFileLease>();
  private readonly lifetime = new AbortController();
  private readonly readings = new Set<Promise<DesktopDiagnostics>>();
  constructor(
    private readonly ctx: Context,
    private readonly domain: Domain<typeof desktopDiagnosticsDomain>,
    private readonly updates: DesktopUpdates,
  ) {
    this.sequence = domain.global.get().rows.at(-1)?.sequence ?? 0;
  }
  capture(message: {
    readonly ts: number;
    readonly type: 'info' | 'warn' | 'error' | 'debug';
    readonly args: readonly unknown[];
  }): void {
    if (!this.accepting || this.failed) return;
    if (this.queue.length >= 64) {
      this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + 1);
      return;
    }
    if (
      !Number.isFinite(message.ts) ||
      !['info', 'warn', 'error', 'debug'].includes(message.type) ||
      this.sequence >= Number.MAX_SAFE_INTEGER
    )
      return;
    const candidate = message.args[0];
    this.queue.push({
      sequence: ++this.sequence,
      at: message.ts,
      generation: this.ctx.runtimeIdentity.generation,
      level: message.type,
      code:
        typeof candidate === 'string' && codes.has(candidate)
          ? candidate
          : 'RUNTIME_' + message.type.toUpperCase(),
    });
    this.startWriter();
  }
  private startWriter(): void {
    if (this.writing) return;
    const task = Promise.resolve()
      .then(async () => {
        while (this.queue.length || this.dropped) {
          const batch = this.queue.splice(0),
            dropped = this.dropped;
          this.dropped = 0;
          const prior = this.domain.global.get(),
            rows = [...prior.rows, ...batch];
          await this.domain.global.set({
            rows: rows.slice(-1000),
            dropped: Math.min(
              Number.MAX_SAFE_INTEGER,
              prior.dropped + dropped + Math.max(0, rows.length - 1000),
            ),
          });
        }
      })
      .catch(() => {
        this.failed = true;
        this.queue.length = 0;
        this.dropped = 0;
      });
    this.writing = task;
    void task.finally(() => {
      if (this.writing === task) this.writing = undefined;
    });
  }
  active(): boolean {
    return this.jobs.size > 0 || this.leases.size > 0;
  }
  private assertOpen(): void {
    if (!this.accepting) throw failure('closed');
    if (this.failed) throw failure('unavailable');
  }
  async logs(): Promise<DesktopDiagnosticLogs> {
    this.assertOpen();
    await this.writing;
    this.assertOpen();
    const journal = this.domain.global.get(),
      lines = journal.rows.map((row) => JSON.stringify(row));
    let bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0),
      removed = 0;
    while (bytes > 256 * 1024 && removed < lines.length) {
      bytes -= Buffer.byteLength(lines[removed++]!) + 1;
    }
    return { lines: lines.slice(removed), truncated: journal.dropped > 0 || removed > 0 };
  }
  snapshot(signal: AbortSignal): Promise<DesktopDiagnostics> {
    this.assertOpen();
    if (this.readings.size >= 32) throw failure('capacity');
    const owned = AbortSignal.any([signal, this.lifetime.signal]);
    const task = Promise.resolve().then(() => this.readSnapshot(owned));
    this.readings.add(task);
    const release = () => this.readings.delete(task);
    void task.then(release, release);
    return task;
  }
  private async readSnapshot(signal: AbortSignal): Promise<DesktopDiagnostics> {
    this.assertOpen();
    signal.throwIfAborted();
    const journal = this.domain.global.get(),
      inspection = this.ctx.get('desktopTaskInspection');
    const active = inspection ? (await inspection.inspect(signal)).active : undefined;
    const updater = await this.updates.status(signal);
    signal.throwIfAborted();
    this.assertOpen();
    return {
      generation: this.ctx.runtimeIdentity.generation,
      uptimeSeconds: Math.max(
        0,
        (Date.now() - Date.parse(this.ctx.runtimeIdentity.startedAt)) / 1000,
      ),
      database: 'ok',
      updater,
      resources: {
        diagnosticLogRecords: journal.rows.length,
        diagnosticExports: this.jobs.size,
        ...(active === undefined ? {} : { activeWork: active ? 1 : 0 }),
        residentBytes: process.memoryUsage().rss,
      },
    };
  }
  outcome(key: string, generation: string): DesktopDiagnosticOutcome {
    this.assertOpen();
    this.check(key, generation);
    const row = this.domain.table('exports').get(key);
    if (!row) return { phase: 'not-found' };
    if (row.generation !== generation) throw failure('stale');
    return { phase: row.phase, ...(row.result ? { result: row.result } : {}) };
  }
  private check(key: string, generation: string): void {
    if (!z.uuid().safeParse(key).success) throw failure('invalid-input');
    if (generation !== this.ctx.runtimeIdentity.generation) throw failure('stale');
  }
  export(
    key: string,
    generation: string,
    grantId: string,
    signal: AbortSignal,
  ): Promise<DesktopDiagnosticExport> {
    this.assertOpen();
    this.check(key, generation);
    if (!z.string().min(1).max(256).safeParse(grantId).success) throw failure('invalid-input');
    signal.throwIfAborted();
    const fingerprint = commandPayloadHash({ generation, grantId }),
      old = this.jobs.get(key);
    if (old) {
      if (old.fingerprint !== fingerprint) throw failure('conflict');
      return old.task;
    }
    const receipts = this.domain.table('exports'),
      receipt = receipts.get(key);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw failure('conflict');
      if (receipt.phase === 'complete' && receipt.result) return Promise.resolve(receipt.result);
      throw failure('uncertain');
    }
    if (this.jobs.size >= 4 || receipts.size + this.jobs.size >= 2000) throw failure('capacity');
    const files = this.ctx.get('files');
    if (!files) throw failure('unavailable');
    const abort = new AbortController(),
      lifetime = AbortSignal.any([signal, abort.signal]);
    const task = Promise.resolve().then(async () => {
      lifetime.throwIfAborted();
      await receipts.put(key, { fingerprint, generation, phase: 'pending' });
      let lease: Awaited<ReturnType<typeof files.open>> | undefined;
      try {
        const createdAt = new Date().toISOString(),
          payload = Buffer.from(
            JSON.stringify(
              {
                format: 'axterm-diagnostics-v1',
                createdAt,
                runtime: await this.snapshot(lifetime),
                logs: await this.logs(),
              },
              null,
              2,
            ),
          );
        if (payload.length > 1024 * 1024) throw failure('capacity');
        lifetime.throwIfAborted();
        lease = await files.open(grantId, 'write', lifetime);
        this.leases.set(key, lease);
        await lease.write(lease.path, Readable.from([payload]), { overwrite: true, mode: 0o600 });
        await lease.close();
        this.leases.delete(key);
        lease = undefined;
        const result = { bytes: payload.length, createdAt };
        await receipts.put(key, { fingerprint, generation, phase: 'complete', result });
        return result;
      } catch {
        if (lease) {
          try {
            await lease.close();
            this.leases.delete(key);
          } catch {
            /* Keep ownership for close and exit inspection. */
          }
        }
        await receipts.put(key, { fingerprint, generation, phase: 'uncertain' });
        throw failure('uncertain');
      }
    });
    this.jobs.set(key, { fingerprint, abort, task });
    const release = () => this.jobs.delete(key);
    void task.then(release, release);
    return task;
  }
  async drain(key: string, generation: string): Promise<DesktopDiagnosticOutcome> {
    this.check(key, generation);
    const job = this.jobs.get(key);
    job?.abort.abort();
    await job?.task.catch(() => {});
    const lease = this.leases.get(key);
    if (lease) {
      try {
        await lease.close();
        this.leases.delete(key);
      } catch {
        throw failure('uncertain');
      }
    }
    return this.outcome(key, generation);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.accepting = false;
      this.lifetime.abort();
      for (const job of this.jobs.values()) job.abort.abort();
      await Promise.allSettled([...this.jobs.values()].map((job) => job.task));
      await Promise.allSettled([...this.readings]);
      await this.writing;
      for (const [key, lease] of [...this.leases]) {
        try {
          await lease.close();
          this.leases.delete(key);
        } catch {
          /* Report remaining authority after actual close fails. */
        }
      }
      if (this.leases.size) throw failure('uncertain');
      if (this.failed) throw failure('unavailable');
    })());
  }
}
