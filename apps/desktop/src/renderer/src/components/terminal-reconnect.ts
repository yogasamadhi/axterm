import type { Connection } from '@workspace/contracts';

export interface TerminalReconnectPresentation {
  tone: 'progress' | 'error';
  message: 'RECONNECTING' | 'DISCONNECTED';
  countdown: number | null;
  errorCode: string | null;
  canRetry: boolean;
  canCancel: boolean;
}

interface TrackedConnectionRecovery {
  recovering: boolean;
}

export class TerminalReconnectTransitionTracker {
  readonly #capacity: number;
  #generation: string | undefined;
  #connections = new Map<string, TrackedConnectionRecovery>();

  constructor(capacity = 64) {
    this.#capacity = Math.max(1, capacity);
  }

  reset(generation?: string): void {
    this.#generation = generation;
    this.#connections.clear();
  }

  observe(generation: string, connection: Connection): boolean {
    if (this.#generation !== generation) this.reset(generation);
    const previous = this.#connections.get(connection.id);
    const recovering =
      connection.state === 'reconnecting' ||
      ((previous?.recovering ?? false) && connection.state !== 'failed') ||
      (connection.reconnectAttempt > 0 && connection.state !== 'ready');
    const becameReady = connection.state === 'ready' && (previous?.recovering ?? false);

    if (connection.state === 'closed' || connection.state === 'closing') {
      this.#connections.delete(connection.id);
    } else {
      this.#connections.delete(connection.id);
      this.#connections.set(connection.id, {
        recovering: connection.state === 'ready' ? false : recovering,
      });
      while (this.#connections.size > this.#capacity) {
        const oldest = this.#connections.keys().next().value as string | undefined;
        if (!oldest) break;
        this.#connections.delete(oldest);
      }
    }
    return becameReady;
  }
}

export function reconnectCountdownSeconds(
  nextReconnectAt: string | null,
  now = Date.now(),
): number | null {
  if (!nextReconnectAt) return null;
  const deadline = Date.parse(nextReconnectAt);
  if (!Number.isFinite(deadline)) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1_000));
}

export function terminalReconnectPresentation(
  connection: Connection | undefined,
  now = Date.now(),
): TerminalReconnectPresentation | null {
  if (!connection) return null;
  if (connection.state === 'reconnecting') {
    const countdown = reconnectCountdownSeconds(connection.nextReconnectAt, now);
    return {
      tone: 'progress',
      message: 'RECONNECTING',
      countdown,
      errorCode: null,
      canRetry: true,
      canCancel: true,
    };
  }
  if (connection.state === 'failed')
    return {
      tone: 'error',
      message: 'DISCONNECTED',
      countdown: null,
      errorCode: connection.errorCode ?? null,
      canRetry: true,
      canCancel: false,
    };
  return null;
}
