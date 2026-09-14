import { parentEnvelopeSchema, type ChildEnvelope } from '@workspace/contracts/desktop';
import { startRuntime } from '../bootstrap/runtime';

// Structural adapter to Electron's embedded Node parentPort; no Electron import/types.
interface SupervisionPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  off(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(envelope: ChildEnvelope): void;
}
const port = (process as unknown as { parentPort?: SupervisionPort }).parentPort;
if (!port) throw new Error('Desktop entry requires a utility process parent');
const parentPort = port;
let startup: ReturnType<typeof startRuntime> | undefined;
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  parentPort.off('message', onMessage);
  if (startup) await (await startup).close();
  process.exit(0);
}
function onMessage(event: { data: unknown }) {
  const parsed = parentEnvelopeSchema.safeParse(event.data);
  if (!parsed.success) return;
  if (parsed.data.type === 'shutdown') {
    void stop().catch(() => process.exit(1));
    return;
  }
  if (startup || stopping) return;
  const input = parsed.data;
  startup = startRuntime({
    generation: input.generation,
    appVersion: input.appVersion,
    mode: 'desktop',
    ...(input.devOrigin ? { devOrigin: input.devOrigin } : {}),
    ...(input.rendererDirectory ? { rendererDirectory: input.rendererDirectory } : {}),
    ...(input.dataDirectory ? { dataDirectory: input.dataDirectory } : {}),
    ...(input.hostCapabilityUrl ? { hostCapabilityUrl: input.hostCapabilityUrl } : {}),
    ...(input.hostCapabilityToken ? { hostCapabilityToken: input.hostCapabilityToken } : {}),
    ...(input.runtimeIngressToken ? { runtimeIngressToken: input.runtimeIngressToken } : {}),
    onReady: (bootstrap) => parentPort.postMessage({ type: 'ready', bootstrap, pid: process.pid }),
  });
  void startup.catch(() => {
    parentPort.postMessage({ type: 'crash', code: 'STARTUP_FAILED' });
    process.exit(1);
  });
}
parentPort.on('message', onMessage);
