import type { AiRun } from '@workspace/contracts';
import { LocalShellError } from '../shell-error';

interface RunClient {
  aiRun(id: string): Promise<AiRun>;
  cancelAi(id: string): Promise<unknown>;
}
const canceled = () => new DOMException('AI suggestion canceled', 'AbortError');

export async function waitForAiResult(
  client: RunClient,
  run: AiRun,
  signal: AbortSignal,
  messages: { timeout: string; failed: string },
): Promise<string> {
  const cancel = () => void client.cancelAi(run.id).catch(() => undefined);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) {
      cancel();
      throw canceled();
    }
    const deadline = Date.now() + 20_000;
    let current = run;
    while (!['succeeded', 'failed', 'canceled'].includes(current.state)) {
      if (signal.aborted) throw canceled();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        cancel();
        throw new LocalShellError(messages.timeout);
      }
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(200, remaining));
        const abort = () => {
          clearTimeout(timer);
          reject(canceled());
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      if (signal.aborted) throw canceled();
      current = await client.aiRun(run.id);
      // A response from an old terminal lifetime must not become a suggestion in a new one.
      if (signal.aborted) throw canceled();
    }
    if (current.state === 'succeeded') return current.result ?? '';
    if (current.state === 'canceled') throw canceled();
    throw new LocalShellError(messages.failed);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
