import { commandPayloadHash } from '@axterm/infra-storage-domain';
import { RemoteError } from '@axterm/plugin-api';
interface Entry {
  hash: string;
  result: Promise<unknown>;
}
/** Generation-only async receipts. A rejected or expired command is never executed again. */
export class TerminalTransferCommands {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  execute<T>(key: string, input: unknown, perform: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(this.fail('closed'));
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(key))
      return Promise.reject(this.fail('invalid-input'));
    const id = key.toLowerCase(),
      hash = commandPayloadHash(input),
      old = this.entries.get(id);
    if (old)
      return old.hash === hash ? (old.result as Promise<T>) : Promise.reject(this.fail('conflict'));
    if (this.entries.size >= 2048) return Promise.reject(this.fail('capacity'));
    const result = Promise.resolve().then(() => {
      if (this.closed) throw this.fail('closed');
      return perform();
    });
    this.entries.set(id, { hash, result });
    void result.catch(() => {});
    return result;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.entries.values()].map((value) => value.result));
    this.entries.clear();
  }
  private fail(reason: 'closed' | 'invalid-input' | 'conflict' | 'capacity') {
    return new RemoteError('terminals/failure', 'Terminal transfer command failed', { reason });
  }
}
