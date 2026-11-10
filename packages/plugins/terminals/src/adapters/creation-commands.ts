import { createHash } from 'node:crypto';
import type { TerminalSession, TerminalCommandOutcome } from '@axterm/plugin-api/terminals';
export class TerminalCommandError extends Error {
  constructor(
    readonly reason:
      'invalid-input' | 'conflict' | 'capacity' | 'closed' | 'receipt-expired' | 'unavailable',
  ) {
    super('TERMINAL_COMMAND_' + reason.toUpperCase().replaceAll('-', '_'));
  }
}
interface Entry<T> {
  readonly operation: string;
  readonly hash: string;
  pending?: Promise<T>;
  id?: string;
  expired: boolean;
  failed: boolean;
}
/** Generation-only deduplication for terminal creation/disconnection; plaintext inputs are never retained. */
export class TerminalCreationCommands<T extends { id: string } = TerminalSession> {
  private readonly entries = new Map<string, Entry<T>>();
  private accepting = true;
  constructor(private readonly current: (id: string) => T) {}
  execute(
    key: string,
    operation: 'create' | 'disconnect' | 'record-start' | 'record-stop',
    input: unknown,
    apply: () => T | Promise<T>,
  ): Promise<T> {
    if (!this.accepting) return Promise.reject(new TerminalCommandError('closed'));
    if (
      typeof key !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)
    )
      return Promise.reject(new TerminalCommandError('invalid-input'));
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(input);
    } catch {
      return Promise.reject(new TerminalCommandError('invalid-input'));
    }
    if (!encoded || Buffer.byteLength(encoded) > 1024 * 1024)
      return Promise.reject(new TerminalCommandError('invalid-input'));
    const hash = createHash('sha256').update(encoded).digest('hex');
    key = key.toLowerCase();
    const previous = this.entries.get(key);
    if (previous) {
      if (previous.hash !== hash || previous.operation !== operation)
        return Promise.reject(new TerminalCommandError('conflict'));
      if (previous.pending) return previous.pending;
      if (previous.failed) return Promise.reject(new TerminalCommandError('unavailable'));
      if (previous.expired || !previous.id)
        return Promise.reject(new TerminalCommandError('receipt-expired'));
      try {
        return Promise.resolve(this.current(previous.id));
      } catch {
        return Promise.reject(new TerminalCommandError('receipt-expired'));
      }
    }
    if (this.entries.size >= 10_000) return Promise.reject(new TerminalCommandError('capacity'));
    const entry: Entry<T> = { operation, hash, expired: false, failed: false };
    this.entries.set(key, entry);
    const pending = Promise.resolve()
      .then(() => {
        if (!this.accepting) throw new TerminalCommandError('closed');
        return apply();
      })
      .then(
        (connection) => {
          entry.id = connection.id;
          delete entry.pending;
          this.prune();
          return connection;
        },
        (error) => {
          entry.failed = true;
          delete entry.pending;
          throw error;
        },
      );
    entry.pending = pending;
    return pending;
  }
  outcome(key: string): TerminalCommandOutcome {
    if (!this.accepting) throw new TerminalCommandError('closed');
    if (
      typeof key !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)
    )
      throw new TerminalCommandError('invalid-input');
    const entry = this.entries.get(key.toLowerCase());
    if (!entry) return { status: 'missing' };
    if (entry.pending) return { status: 'pending' };
    if (entry.id) return { status: 'accepted', id: entry.id };
    return { status: entry.expired ? 'expired' : 'uncertain' };
  }
  stop(): void {
    this.accepting = false;
  }
  async dispose(): Promise<void> {
    this.stop();
    await Promise.allSettled(
      [...this.entries.values()].flatMap((entry) => (entry.pending ? [entry.pending] : [])),
    );
    this.entries.clear();
  }
  private prune(): void {
    const completed = [...this.entries.values()].filter((entry) => entry.id !== undefined);
    for (const entry of completed.slice(0, Math.max(0, completed.length - 2000))) {
      delete entry.id;
      entry.expired = true;
    }
  }
}
