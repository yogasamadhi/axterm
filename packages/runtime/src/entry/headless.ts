import { randomUUID } from 'node:crypto';
import { APP_VERSION } from '@workspace/shared';
import { startRuntime } from '../bootstrap/runtime';

// Local-only development/embedding entry. Durable remote auth is Phase 11.
const runtime = await startRuntime({
  generation: randomUUID(),
  appVersion: APP_VERSION,
  mode: 'headless',
});
console.info(
  JSON.stringify({ component: 'runtime', baseUrl: runtime.baseUrl, ...runtime.metadata }),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  await runtime.close();
}
const onSignal = () => {
  void stop().catch(() => {
    process.exitCode = 1;
  });
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
