import { Service, type FiberState, type Context } from '@deepseek-ai/cordis';
import { RegistrationLifetime } from '@axterm/infra-scope';
import type { CatalogReferences, CatalogReferenceSource } from '@axterm/plugin-api/host';
import { ApplicationError } from './application/errors.ts';
// Cordis exposes an ambient const enum; retain its checked member type without a runtime enum import.
const ACTIVE_FIBER: FiberState.ACTIVE = 2;
export class CatalogReferenceRegistry extends Service implements CatalogReferences {
  private readonly entries = new Map<string, CatalogReferenceSource & { available(): boolean }>();
  private readonly registrations: RegistrationLifetime;
  private closed = false;
  constructor(
    ctx: Context,
    private readonly required: readonly string[] = ['@axterm/plugin-connections'],
  ) {
    super(ctx, 'catalogReferences');
    this.registrations = new RegistrationLifetime(ctx);
    ctx.effect(() => () => {
      this.closed = true;
    });
  }
  register(owner: string, contribution: CatalogReferenceSource): () => Promise<void> {
    this.assertOpen();
    if (
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,127}$/.test(owner) ||
      typeof contribution.retainedBy !== 'function' ||
      !contribution.participant
    )
      throw new Error('CATALOG_REFERENCE_INVALID');
    if (this.entries.has(owner)) throw new Error('CATALOG_REFERENCE_DUPLICATE');
    if (this.entries.size >= 64) throw new Error('CATALOG_REFERENCE_CAPACITY');
    const caller = this.ctx;
    const entry = Object.freeze({
      participant: contribution.participant,
      retainedBy: contribution.retainedBy.bind(contribution),
      available: () => caller.fiber.state === ACTIVE_FIBER,
    });
    return this.registrations.owner(this.ctx).effect(() => {
      this.entries.set(owner, entry);
      return () => {
        if (this.entries.get(owner) === entry) this.entries.delete(owner);
      };
    });
  }
  participants() {
    this.assertOpen();
    return [...this.entries.values()]
      .filter((entry) => entry.available())
      .map((entry) => entry.participant);
  }
  retainedBy(id: string): readonly 'tunnel'[] {
    this.assertOpen();
    if (this.required.some((owner) => !this.entries.get(owner)?.available()))
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Catalog reference owners are unavailable',
        503,
      );
    const result = new Set<'tunnel'>();
    for (const entry of this.entries.values()) {
      if (!entry.available())
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Catalog reference owner is unloading',
          503,
        );
      let reasons: readonly 'tunnel'[];
      try {
        reasons = entry.retainedBy(id);
      } catch {
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Catalog reference state is unavailable',
          503,
        );
      }
      if (
        !Array.isArray(reasons) ||
        reasons.length > 64 ||
        reasons.some((reason) => reason !== 'tunnel')
      )
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Catalog reference state is unavailable',
          503,
        );
      for (const reason of reasons) result.add(reason);
    }
    return [...result];
  }
  private assertOpen() {
    if (this.closed)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Catalog reference registry is closed',
        503,
      );
  }
}
