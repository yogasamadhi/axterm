import type { Connection } from '@workspace/contracts';
import type { AxtermMessageKey, Variables } from '../../i18n/core';
import { LocalShellError } from '../shell-error';

export interface ConnectionWaitContext {
  list(): Promise<Connection[]>;
  isDisposed(): boolean;
  generation(): string | undefined;
  signal: AbortSignal;
  x(key: AxtermMessageKey, variables?: Variables): string;
}

/** An owned UI wait over the Client contract, separate from connection establishment in Runtime. */
export async function waitForConnectionReady(
  context: ConnectionWaitContext,
  connectionId: string,
  expectedGeneration?: string,
  timeoutMs = 120_000,
): Promise<Connection> {
  const deadline = Date.now() + Math.min(120_000, Math.max(1, timeoutMs));
  const assertCurrentOwner = () => {
    if (context.isDisposed() || context.signal.aborted)
      throw new LocalShellError(context.x('app.closed'));
    if (expectedGeneration && context.generation() !== expectedGeneration)
      throw new LocalShellError(context.x('app.runtimeRestarted'));
  };
  while (Date.now() < deadline) {
    assertCurrentOwner();
    const connection = (await context.list()).find((item) => item.id === connectionId);
    assertCurrentOwner();
    if (!connection) throw new LocalShellError(context.x('app.connectionClosed'));
    if (connection.state === 'ready') return connection;
    if (connection.state === 'failed')
      throw new LocalShellError(context.x('app.connectionFailed', { detail: '' }));
    if (connection.state === 'closed' || connection.state === 'closing')
      throw new LocalShellError(context.x('app.connectionClosed'));
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        context.signal.removeEventListener('abort', abort);
        resolve();
      };
      const timer = setTimeout(finish, Math.min(200, Math.max(1, deadline - Date.now())));
      const abort = () => {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', abort);
        reject(new LocalShellError(context.x('app.closed')));
      };
      context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) abort();
    });
  }
  throw new LocalShellError(context.x('app.sshWaitTimeout'));
}
