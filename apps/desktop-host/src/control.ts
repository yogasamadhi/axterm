import {
  parentControlSchema,
  parseHostControl,
  type HostControl,
  type HostInitialize,
} from './protocol.ts';
import type { IndexInjection } from '@axterm/infra-web-server';
import type { NodeIpcPeer } from '@axterm/infra-desktop-native';
export interface HostedApplication {
  readonly origin: string;
  readonly injections: readonly IndexInjection[];
  stop(): Promise<void>;
  inspect(signal: AbortSignal): Promise<{ active: boolean }>;
}
const owners = new WeakSet<object>();
/** Startup/supervision channel; no business verbs are accepted here. */
export function ownHostControl(
  peer: NodeIpcPeer & { disconnect?(): void },
  start: (input: HostInitialize) => Promise<HostedApplication>,
  onFailure?: () => void,
): () => Promise<void> {
  if (owners.has(peer) || !peer.connected || !peer.send)
    throw new Error('HOST_CONTROL_UNAVAILABLE');
  owners.add(peer);
  let generation: string | undefined;
  let starting: Promise<HostedApplication> | undefined;
  let closing: Promise<void> | undefined;
  let accepting = true;
  let inspecting = false;
  const lifetime = new AbortController();
  const send = (value: HostControl) =>
    new Promise<void>((resolve, reject) => {
      if (!peer.connected || !peer.send) {
        reject(new Error('HOST_CONTROL_DISCONNECTED'));
        return;
      }
      try {
        peer.send(parseHostControl(value), (error) =>
          error ? reject(new Error('HOST_CONTROL_SEND_FAILED')) : resolve(),
        );
      } catch {
        reject(new Error('HOST_CONTROL_SEND_FAILED'));
      }
    });
  const initializeTimer = setTimeout(() => {
    void fail('HOST_CONTROL_INVALID').catch(() => {});
  }, 15_000);
  const stop = (reply?: HostControl) =>
    (closing ??= (async () => {
      accepting = false;
      clearTimeout(initializeTimer);
      lifetime.abort();
      peer.off('message', receive);
      peer.off('disconnect', disconnected);
      try {
        await (await starting?.catch(() => undefined))?.stop();
        if (reply && peer.connected) await send(reply).catch(() => {});
      } finally {
        if (peer.connected) peer.disconnect?.();
        owners.delete(peer);
      }
    })());
  const fail = async (code: 'HOST_STARTUP_FAILED' | 'HOST_CONTROL_INVALID') => {
    try {
      await stop(
        generation
          ? { kind: 'axterm-desktop-control', version: 1, generation, type: 'failed', code }
          : undefined,
      );
    } finally {
      onFailure?.();
    }
  };
  const disconnected = () => {
    void stop().catch(() => {});
  };
  const receive = (value?: unknown): void => {
    if (
      !accepting ||
      typeof value !== 'object' ||
      value === null ||
      !('kind' in value) ||
      value.kind !== 'axterm-desktop-control'
    )
      return;
    let message: ReturnType<typeof parentControlSchema.safeParse>;
    try {
      if (JSON.stringify(value).length > 8192) throw new Error();
      message = parentControlSchema.safeParse(value);
    } catch {
      void fail('HOST_CONTROL_INVALID').catch(() => {});
      return;
    }
    if (!message.success) {
      void fail('HOST_CONTROL_INVALID').catch(() => {});
      return;
    }
    const frame = message.data;
    if (frame.type === 'initialize') {
      if (starting) {
        void fail('HOST_CONTROL_INVALID').catch(() => {});
        return;
      }
      clearTimeout(initializeTimer);
      generation = frame.generation;
      starting = Promise.resolve().then(() => start(frame));
      void starting
        .then(async (app) => {
          if (!accepting) return;
          const origin = new URL(app.origin);
          if (
            origin.protocol !== 'http:' ||
            !['127.0.0.1', '[::1]'].includes(origin.hostname) ||
            !origin.port ||
            Number(origin.port) === 0 ||
            origin.pathname !== '/' ||
            origin.username ||
            origin.password ||
            origin.search ||
            origin.hash
          )
            throw new Error('HOST_ORIGIN_INVALID');
          await send({
            kind: 'axterm-desktop-control',
            version: 1,
            generation: frame.generation,
            type: 'ready',
            origin: origin.origin,
            injections: [...app.injections],
          });
        })
        .catch(() => fail('HOST_STARTUP_FAILED'))
        .catch(() => {});
      return;
    }
    if (!starting || frame.generation !== generation) {
      void fail('HOST_CONTROL_INVALID').catch(() => {});
      return;
    }
    if (frame.type === 'shutdown') {
      void stop({
        kind: 'axterm-desktop-control',
        version: 1,
        generation: frame.generation,
        type: 'stopped',
      }).catch(() => {});
      return;
    }
    if (inspecting) {
      void send({
        kind: 'axterm-desktop-control',
        version: 1,
        generation: frame.generation,
        type: 'inspection',
        id: frame.id,
        active: true,
        known: false,
      })
        .catch(() => fail('HOST_CONTROL_INVALID'))
        .catch(() => {});
      return;
    }
    inspecting = true;
    const timeout = new AbortController();
    const signal = AbortSignal.any([timeout.signal, lifetime.signal]);
    const done = Promise.withResolvers<{ active: boolean; known: boolean }>();
    const timer = setTimeout(() => {
      timeout.abort();
      done.resolve({ active: true, known: false });
    }, 1000);
    const aborted = () => done.resolve({ active: true, known: false });
    signal.addEventListener('abort', aborted, { once: true });
    void starting
      .then((app) => app.inspect(signal))
      .then(
        (result) =>
          done.resolve(
            typeof result.active === 'boolean'
              ? { active: result.active, known: true }
              : { active: true, known: false },
          ),
        () => done.resolve({ active: true, known: false }),
      )
      .finally(() => {
        inspecting = false;
      });
    void done.promise
      .then(async (result) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        if (accepting)
          await send({
            kind: 'axterm-desktop-control',
            version: 1,
            generation: frame.generation,
            type: 'inspection',
            id: frame.id,
            ...result,
          });
      })
      .catch(() => fail('HOST_CONTROL_INVALID'))
      .catch(() => {});
  };
  peer.on('message', receive);
  peer.on('disconnect', disconnected);
  return () => stop();
}
