import { Service, type FiberState, type Context } from '@deepseek-ai/cordis';
import { RemoteError } from '@axterm/plugin-api';
import type {
  ConfigurationHistory,
  ConfigurationHistoryKind,
  ConfigurationHistorySource,
  HistoryPrivacyPatch,
} from '@axterm/plugin-api/host';
import { RegistrationLifetime } from '@axterm/infra-scope';
const ACTIVE_FIBER: FiberState.ACTIVE = 2;
const unavailable = () =>
  new RemoteError('configuration/failure', 'A history owner is unavailable', {
    reason: 'unavailable',
  });
/** This registry belongs to the settings workflow; each participant retains its own actual write handle. */
export class SettingsHistory extends Service implements ConfigurationHistory {
  private readonly entries = new Map<
    ConfigurationHistoryKind,
    ConfigurationHistorySource & { available(): boolean }
  >();
  private readonly registrations: RegistrationLifetime;
  private closed = false;
  constructor(ctx: Context) {
    super(ctx, 'configurationHistory');
    this.registrations = new RegistrationLifetime(ctx);
    ctx.effect(() => () => {
      this.closed = true;
    });
  }
  register(
    kind: ConfigurationHistoryKind,
    source: ConfigurationHistorySource,
  ): () => Promise<void> {
    if (
      this.closed ||
      !['connection-history', 'command-history'].includes(kind) ||
      !source.participant ||
      typeof source.purge !== 'function'
    )
      throw unavailable();
    if (this.entries.has(kind)) throw new Error('CONFIGURATION_HISTORY_DUPLICATE');
    const caller = this.ctx;
    const entry = Object.freeze({
      participant: source.participant,
      purge: source.purge.bind(source),
      available: () => caller.fiber.state === ACTIVE_FIBER,
    });
    return this.registrations.owner(this.ctx).effect(() => {
      this.entries.set(kind, entry);
      return () => {
        if (this.entries.get(kind) === entry) this.entries.delete(kind);
      };
    });
  }
  participants(privacy: HistoryPrivacyPatch) {
    if (this.closed) throw unavailable();
    return this.selected(privacy).flatMap((kind) => {
      const source = this.entries.get(kind);
      return source?.available() ? [source.participant] : [];
    });
  }
  purge(privacy: HistoryPrivacyPatch): void {
    if (this.closed) throw unavailable();
    for (const kind of this.selected(privacy)) {
      const source = this.entries.get(kind);
      if (!source?.available()) throw unavailable();
      const result = source.purge();
      if (result instanceof Promise) {
        void Promise.prototype.then.call(
          result,
          () => {},
          () => {},
        );
        throw unavailable();
      }
      if (!result || !Number.isSafeInteger(result.deletedCount) || result.deletedCount < 0)
        throw unavailable();
    }
  }
  private selected(privacy: HistoryPrivacyPatch): ConfigurationHistoryKind[] {
    return [
      ...(privacy?.connectionHistoryEnabled === false ? ['connection-history' as const] : []),
      ...(privacy?.commandHistoryEnabled === false ? ['command-history' as const] : []),
    ];
  }
}
