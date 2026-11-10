import { commandPayloadHash } from '@axterm/infra-storage-domain';
import { RemoteError } from '@axterm/plugin-api';
/** Controls apply only to live immutable task ids; retain generation-local nonces without eviction. */
export class TransferControls {
  private open = true;
  private readonly entries = new Map<
    string,
    { operation: string; hash: string; value?: unknown; error?: unknown }
  >();
  execute<T>(key: string, operation: string, input: unknown, perform: () => T): T {
    if (!this.open)
      throw new RemoteError('transfers/failure', 'Transfer controls are closed', {
        reason: 'closed',
      });
    if (
      typeof key !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)
    )
      throw new RemoteError('transfers/failure', 'Invalid transfer command', {
        reason: 'invalid-input',
      });
    key = key.toLowerCase();
    const hash = commandPayloadHash(input);
    const previous = this.entries.get(key);
    if (previous) {
      if (previous.operation !== operation || previous.hash !== hash)
        throw new RemoteError('transfers/failure', 'Transfer command identity changed', {
          reason: 'conflict',
        });
      if (previous.error) throw previous.error;
      return structuredClone(previous.value) as T;
    }
    if (this.entries.size >= 20_000)
      throw new RemoteError('transfers/failure', 'Transfer control capacity exceeded', {
        reason: 'capacity',
      });
    const entry: { operation: string; hash: string; value?: unknown; error?: unknown } = {
      operation,
      hash,
    };
    this.entries.set(key, entry);
    try {
      const value = perform();
      entry.value = structuredClone(value);
      return value;
    } catch (error) {
      entry.error = error ?? new Error('TRANSFER_CONTROL_UNCERTAIN');
      throw error;
    }
  }
  close(): void {
    this.open = false;
    this.entries.clear();
  }
}
