import type {} from '@axterm/plugin-api/host';
// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/storage/storage-domain/src/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * Domain data form (`ctx.storage.domain`): schema-validated, change-emitting
 * KV domains over storage backends. The single implementation of the domain
 * layer — consumers depend on this package and never touch backends directly.
 * Plugin `Config` is schemastery; record schemas inside domain specs are zod
 * (see `src/spec.ts` for the split rationale).
 * @module @axterm/infra-storage-domain
 */

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { storageBackendServiceKey } from '@axterm/infra-storage';
import { DomainError, StorageError } from '@axterm/plugin-api';
import { defineDomain, descriptorOf } from '@axterm/plugin-api';
import type {
  RelationalDomain,
  RelationalDomainSpec,
  RelationalParticipant,
  RelationalFacet,
  DomainSpec,
} from '@axterm/plugin-api';
import { DomainImpl } from './domain.ts';
import type { Domain } from '@axterm/plugin-api';

export { DomainError } from '@axterm/plugin-api';
export { DomainCommands, commandPayloadHash } from './commands.ts';
export type { DomainErrorCode, DomainErrorOptions, InvalidRecordDetail } from '@axterm/plugin-api';
export { defineDomain, domainTable, descriptorOf } from '@axterm/plugin-api';
export type {
  DomainSpec,
  DomainGlobalSpec,
  DomainTableSpec,
  TableKeyOf,
  TableValueOf,
  GlobalValueOf,
} from '@axterm/plugin-api';
export type { DomainChanged } from '@axterm/plugin-api';
export type { Domain, DomainGlobal, DomainGlobalHandleOf, KvTable } from '@axterm/plugin-api';

/** Cordis plugin name. */
export const name = 'storage-domain';
/** The storage hub must be present before the form can mount. */
export const inject = ['storage'];

/**
 * Plugin config. Which backend serves which domain is decided here, not
 * globally on the hub: `backend` is the default route and `routes` overrides
 * it per domain name. A route naming an unregistered backend fails loud at
 * `open` with `backend-not-found`.
 */
export interface Config {
  /** Default backend name for every domain without an explicit route. Required: there is no universally correct medium. */
  backend: string;
  /** Per-domain overrides: domain name → backend name. */
  routes?: Record<string, string>;
}

export const Config: z<Config> = z.object({
  backend: z.string().required(),
  routes: z.dict(z.string()).default({}),
});

/**
 * The mounted domain facility. Opens declared domains over routed backends;
 * one facility instance owns the open-domain table and enforces single-open
 * per domain name.
 */
export class DomainFacility {
  private readonly domains = new Map<string, DomainImpl | RelationalDomain>();
  private readonly openings = new Set<Promise<unknown>>();
  private readonly relationalOwners = new WeakMap<RelationalParticipant, RelationalFacet>();
  private active = true;
  /** Names reserved by an in-flight or completed open, so concurrent opens of one name fail loud. */
  private readonly reserved = new Set<string>();

  /**
   * @param ctx - Context of the domain plugin; open-domain effects and change
   * events attach here.
   * @param config - Validated plugin config.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  /**
   * Open one declared domain. Steps, each failing the whole call: reject a
   * name that is already open (`already-open`); resolve the backend route
   * (`backend-not-found` passes through from the hub); require its `kv` facet
   * (`facet-unsupported`); open the unit projected from the spec (backend
   * `version-mismatch`/`malformed-medium` pass through); load and validate
   * every stored record against the spec's zod schemas (`invalid-record`
   * with the offending table and key — unless the spec declares
   * `invalidRecords: 'backup-and-skip'` and the unit can move documents aside, in
   * which case the failing record is backed up, logged, and skipped);
   * construct the domain.
   *
   * Lifecycle: the CALLER owns the returned handle and closes it via
   * `Domain.close()` (typically as its own `ctx.effect` disposer) — the
   * facility does not tie the domain to any consumer fiber. Domains still
   * open when the facility unmounts are closed by the plugin disposer.
   * @param spec - The domain declaration, typically from `defineDomain`.
   * @returns the opened domain handle, typed by the spec.
   */
  open<S extends RelationalDomainSpec>(spec: S): Promise<RelationalDomain>;
  open<S extends DomainSpec>(spec: S): Promise<Domain<S>>;
  open(spec: DomainSpec | RelationalDomainSpec): Promise<Domain<DomainSpec> | RelationalDomain> {
    if (!this.active) return Promise.reject(new DomainError('closed', 'Domain provider is closed'));
    const task =
      spec.kind === 'relational'
        ? this.openRelational(defineDomain(spec))
        : this.openDomain(defineDomain(spec));
    this.openings.add(task);
    const settled = () => {
      this.openings.delete(task);
    };
    void task.then(settled, settled);
    return task;
  }

  transaction<T>(participants: readonly RelationalParticipant[], operation: () => T): T {
    if (!this.active) throw new DomainError('closed', 'Domain provider is closed');
    if (!participants.length || participants.length > 256)
      throw new RangeError('Invalid transaction participants');
    let selected: RelationalFacet | undefined;
    for (const participant of participants) {
      const owner = this.relationalOwners.get(participant);
      if (!owner || (selected && selected !== owner))
        throw new StorageError(
          'ownership-conflict',
          'Transaction participants must share one open routed medium',
        );
      selected = owner;
    }
    return selected!.transaction(participants, operation);
  }

  private async openRelational(spec: RelationalDomainSpec): Promise<RelationalDomain> {
    if (this.reserved.has(spec.name))
      throw new DomainError('already-open', `Domain '${spec.name}' is already open`);
    this.reserved.add(spec.name);
    try {
      const backend = this.ctx.storage.backend.get(
        this.config.routes?.[spec.name] ?? this.config.backend,
      );
      if (!backend.sql)
        throw new DomainError('facet-unsupported', 'Selected backend has no relational facet');
      const domain = await backend.sql.open(spec);
      if (!this.active) {
        await domain.close();
        throw new DomainError('closed', 'Domain provider closed during open');
      }
      const close = domain.close.bind(domain);
      const view: RelationalDomain = {
        ...domain,
        close: async () => {
          await close();
          this.relationalOwners.delete(domain.participant);
          this.domains.delete(spec.name);
          this.reserved.delete(spec.name);
        },
      };
      this.domains.set(spec.name, view);
      this.relationalOwners.set(domain.participant, backend.sql);
      return view;
    } catch (error) {
      this.reserved.delete(spec.name);
      throw error;
    }
  }

  private async openDomain<S extends DomainSpec>(spec: S): Promise<Domain<S>> {
    if (this.reserved.has(spec.name)) {
      throw new DomainError('already-open', `domain '${spec.name}' is already open`);
    }
    this.reserved.add(spec.name);
    try {
      const backendName = this.config.routes?.[spec.name] ?? this.config.backend;
      const backend = this.ctx.storage.backend.get(backendName);
      if (!backend.kv) {
        throw new DomainError(
          'facet-unsupported',
          `backend '${backendName}' routed for domain '${spec.name}' has no kv facet`,
        );
      }
      const unit = await backend.kv.open(descriptorOf(spec));
      try {
        const snapshot = await unit.loadAll();
        if (!this.active) throw new DomainError('closed', 'Domain provider closed during open');
        const tables = new Map<string, Map<string, unknown>>();
        for (const [table, tableSpec] of Object.entries(spec.tables)) {
          const records = new Map<string, unknown>();
          for (const [key, raw] of Object.entries(snapshot.tables[table] ?? {})) {
            let parsed: unknown;
            try {
              parsed = parseRecord(spec.name, table, key, () => tableSpec.valueSchema.parse(raw));
            } catch (error) {
              // Backup-and-skip policy (disposable derived data): move the record's
              // document aside, log the concrete failure, and open without the
              // record. Backends that cannot move a document keep the loud path.
              if (spec.invalidRecords !== 'backup-and-skip' || unit.backupRecord === undefined)
                throw error;
              const moved = await unit.backupRecord(table, key);
              this.ctx.logger.error(
                `domain '${spec.name}': derived record failed validation and was backed up to '${moved}'`,
              );
              continue;
            }
            records.set(key, parsed);
          }
          tables.set(table, records);
        }
        // A null stored global means "never written": serve `initial` without
        // materializing it — the first `set` writes.
        const globalSpec = spec.global;
        const globalValue =
          globalSpec === undefined
            ? undefined
            : snapshot.global === null
              ? parseRecord(spec.name, '', '', () => globalSpec.schema.parse(globalSpec.initial))
              : parseRecord(spec.name, '', '', () => globalSpec.schema.parse(snapshot.global));
        // The onClosed hook runs strictly after teardown completes: writes
        // landing during the drain still emit domain/changed, and the name
        // frees up for reopening only once the domain is fully closed.
        const domain: DomainImpl = new DomainImpl(this.ctx, spec, unit, tables, globalValue, () => {
          this.domains.delete(spec.name);
          this.reserved.delete(spec.name);
        });
        this.domains.set(spec.name, domain);
        // The single type-erasure point: DomainImpl is the untyped runtime,
        // Domain<S> the spec-typed view; the unknown hop is required because
        // S's conditional global-handle type stays unresolved here.
        return domain as unknown as Domain<S>;
      } catch (error) {
        await unit.close();
        throw error;
      }
    } catch (error) {
      // Any failure means the domain never registered (nothing can throw
      // after it), so releasing the name reservation is unconditional.
      this.reserved.delete(spec.name);
      throw error;
    }
  }

  /**
   * Look up an open domain by name, untyped. Diagnostic surface; typed
   * consumers hold the handle returned by {@link open}.
   * @param name - Domain name.
   * @returns the open domain runtime, or `undefined` when not open.
   */
  get(name: string): DomainImpl | RelationalDomain | undefined {
    return this.domains.get(name);
  }

  /**
   * Close every domain still open on this facility. The unmount path for
   * consumers that never called `Domain.close()` themselves; closing is
   * idempotent, so double-closing an already-closed domain is harmless.
   * @returns resolution after every unit is released.
   */
  async closeAll(): Promise<void> {
    this.active = false;
    await Promise.allSettled([...this.openings]);
    await Promise.all([...this.domains.values()].map((domain) => domain.close()));
  }
}

/** Run one zod parse, translating failure to `invalid-record` with its location. */
function parseRecord<T>(domain: string, table: string, key: string, parse: () => T): T {
  try {
    return parse();
  } catch {
    const slot = table === '' ? 'global' : `record '${key}' in table '${table}'`;
    throw new DomainError(
      'invalid-record',
      `domain '${domain}': stored ${slot} does not match its schema`,
      { detail: { table, key } },
    );
  }
}

/**
 * Mount the domain data form on the storage hub.
 * @param ctx - Plugin context.
 * @param config - Validated plugin config.
 * @returns resolution after an already-available backend set activates the form.
 */
export function apply(ctx: Context, config: Config): Promise<void> {
  const backendServices = [...new Set([config.backend, ...Object.values(config.routes ?? {})])].map(
    storageBackendServiceKey,
  );

  const fiber = ctx.inject(backendServices, (domainCtx) => {
    const facility = new DomainFacility(domainCtx, config);
    domainCtx.effect(() => {
      const unmount = domainCtx.storage.mount('domain', facility);
      return async () => {
        // Close leftovers before unmounting: draining writes still emit
        // domain/changed.
        await facility.closeAll();
        await unmount();
      };
    });
    domainCtx.provide('storageDomain', facility);
  });
  return Promise.resolve(fiber).then(() => {});
}
