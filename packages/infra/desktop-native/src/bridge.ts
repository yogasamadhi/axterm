import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { VaultError } from '@axterm/infra-credential-vault';
import {
  NativeError,
  isNativeFrame,
  parseNativeFrame,
  nativeCapabilities,
  MAX_NATIVE_REQUESTS,
  NATIVE_REQUEST_TIMEOUT_MS,
  type NativeFrame,
  type NativeMethod,
  type NativeHandlers,
  type NativeInput,
  type NativeOutput,
} from './protocol.ts';
export interface NativeWire {
  readonly identity: object;
  readonly connected: boolean;
  send(frame: NativeFrame): Promise<void>;
  onMessage(listener: (value: unknown) => void): () => void;
  onDisconnect(listener: () => void): () => void;
}
export interface NodeIpcPeer {
  readonly connected?: boolean;
  send?(message: object, callback: (error: Error | null) => void): boolean;
  on(event: string, listener: (value?: unknown) => void): unknown;
  off(event: string, listener: (value?: unknown) => void): unknown;
}
export function nodeIpcWire(peer: NodeIpcPeer): NativeWire {
  return {
    identity: peer,
    get connected() {
      return peer.connected === true;
    },
    send(frame) {
      return new Promise((resolve, reject) => {
        if (!peer.connected || !peer.send) {
          reject(new NativeError('CLOSED'));
          return;
        }
        try {
          peer.send(frame, (error) => (error ? reject(new NativeError('IO')) : resolve()));
        } catch {
          reject(new NativeError('IO'));
        }
      });
    },
    onMessage(listener) {
      peer.on('message', listener);
      return () => {
        peer.off('message', listener);
      };
    },
    onDisconnect(listener) {
      peer.on('disconnect', listener);
      return () => {
        peer.off('disconnect', listener);
      };
    },
  };
}
const owners = new WeakMap<object, object>();
function claim(wire: NativeWire, owner: object): () => void {
  if (owners.has(wire.identity)) throw new NativeError('PROTOCOL');
  owners.set(wire.identity, owner);
  return () => {
    if (owners.get(wire.identity) === owner) owners.delete(wire.identity);
  };
}
function generation(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new NativeError('INVALID');
  return value;
}
interface Pending {
  method: NativeMethod;
  resolve(value: unknown): void;
  reject(error: NativeError): void;
  dispose(): void;
}
export class NativeClient {
  private readonly lifetime = new AbortController();
  readonly signal = this.lifetime.signal;
  private readonly pending = new Map<string, Pending>();
  private readonly disposers: (() => void)[];
  private active = true;
  readonly generation: string;
  constructor(
    private readonly wire: NativeWire,
    audience: string,
  ) {
    this.generation = generation(audience);
    this.disposers = [
      claim(wire, this),
      wire.onMessage((frame) => this.receive(frame)),
      wire.onDisconnect(() => this.close()),
    ];
    if (!wire.connected) this.close();
  }
  call<K extends NativeMethod>(
    method: K,
    input: NativeInput<K>,
    signal?: AbortSignal,
    timeoutMs = NATIVE_REQUEST_TIMEOUT_MS,
  ): Promise<NativeOutput<K>> {
    if (!this.active || !this.wire.connected) return Promise.reject(new NativeError('CLOSED'));
    if (signal?.aborted) return Promise.reject(new NativeError('CANCELLED'));
    const pair = nativeCapabilities[method];
    const maximum = pair && 'maxTimeoutMs' in pair ? pair.maxTimeoutMs : NATIVE_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximum)
      return Promise.reject(new NativeError('INVALID'));
    if (this.pending.size >= MAX_NATIVE_REQUESTS) return Promise.reject(new NativeError('LIMIT'));
    if (!Object.hasOwn(nativeCapabilities, method))
      return Promise.reject(new NativeError('INVALID'));
    if (!pair) return Promise.reject(new NativeError('INVALID'));
    const checked = pair.input.safeParse(input);
    if (!checked.success) return Promise.reject(new NativeError('INVALID'));
    const id = randomUUID();
    let frame: NativeFrame;
    try {
      frame = parseNativeFrame({
        kind: 'axterm-native',
        version: 1,
        generation: this.generation,
        id,
        type: 'request',
        method,
        input: checked.data,
      });
    } catch {
      return Promise.reject(new NativeError('INVALID'));
    }
    return new Promise<NativeOutput<K>>((resolve, reject) => {
      const cancel = (code: 'CANCELLED' | 'TIMEOUT') => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.dispose();
        pending.reject(new NativeError(code));
        void this.wire
          .send({
            kind: 'axterm-native',
            version: 1,
            generation: this.generation,
            id,
            type: 'cancel',
          })
          .catch(() => {});
      };
      const abort = () => cancel('CANCELLED');
      const timer = setTimeout(() => cancel('TIMEOUT'), timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as NativeOutput<K>),
        reject,
        dispose: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        },
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      void this.wire.send(frame).catch(() => this.fail(id, new NativeError('IO')));
    });
  }
  close(): void {
    if (!this.active) return;
    this.active = false;
    this.lifetime.abort();
    for (const dispose of this.disposers) dispose();
    if (this.wire.connected)
      void this.wire
        .send({
          kind: 'axterm-native',
          version: 1,
          generation: this.generation,
          type: 'closed',
          id: randomUUID(),
        })
        .catch(() => {});
    for (const id of this.pending.keys()) this.fail(id, new NativeError('CLOSED'));
  }
  private fail(id: string, error: NativeError): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.dispose();
    pending.reject(error);
  }
  private receive(raw: unknown): void {
    if (!this.active || !isNativeFrame(raw)) return;
    let frame: NativeFrame;
    try {
      frame = parseNativeFrame(raw);
    } catch {
      this.close();
      return;
    }
    if (frame.generation !== this.generation) return;
    if (frame.type === 'closed') {
      this.close();
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    if (frame.type === 'error') {
      this.fail(frame.id, new NativeError(frame.code));
      return;
    }
    if (frame.type !== 'result') {
      this.close();
      return;
    }
    const result = nativeCapabilities[pending.method].output.safeParse(frame.value);
    if (!result.success) {
      this.fail(frame.id, new NativeError('PROTOCOL'));
      return;
    }
    this.pending.delete(frame.id);
    pending.dispose();
    pending.resolve(result.data);
  }
}
export class NativeServer {
  private readonly requests = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly recent = new Set<string>();
  private readonly disposers: (() => void)[];
  private active = true;
  private closing: Promise<void> | undefined;
  readonly generation: string;
  constructor(
    private readonly wire: NativeWire,
    audience: string,
    private readonly handlers: NativeHandlers,
    private readonly onStop: () => void | Promise<void> = () => {},
  ) {
    this.generation = generation(audience);
    if (
      Object.keys(handlers).length !== Object.keys(nativeCapabilities).length ||
      Object.keys(nativeCapabilities).some(
        (key) => typeof handlers[key as NativeMethod] !== 'function',
      )
    )
      throw new NativeError('INVALID');
    this.disposers = [
      claim(wire, this),
      wire.onMessage((frame) => this.receive(frame)),
      wire.onDisconnect(() => {
        void this.close().catch(() => {});
      }),
    ];
    if (!wire.connected) void this.close().catch(() => {});
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.active = false;
    for (const dispose of this.disposers.slice(1)) dispose();
    for (const request of this.requests.values()) request.abort.abort();
    if (this.wire.connected)
      void this.send({
        kind: 'axterm-native',
        version: 1,
        generation: this.generation,
        type: 'closed',
        id: randomUUID(),
      }).catch(() => {});
    return (this.closing = Promise.resolve().then(async () => {
      try {
        await this.onStop();
      } finally {
        await Promise.allSettled([...this.requests.values()].map((request) => request.done));
        this.recent.clear();
        this.disposers[0]!();
      }
    }));
  }
  private send(frame: NativeFrame): Promise<void> {
    try {
      return this.wire.send(parseNativeFrame(frame));
    } catch {
      return Promise.reject(new NativeError('PROTOCOL'));
    }
  }
  private error(id: string, code: NativeError['code']): void {
    void this.send({
      kind: 'axterm-native',
      version: 1,
      generation: this.generation,
      type: 'error',
      id,
      code,
    }).catch(() => {});
  }
  private receive(raw: unknown): void {
    if (!this.active || !isNativeFrame(raw)) return;
    let frame: NativeFrame;
    try {
      frame = parseNativeFrame(raw);
    } catch {
      void this.close().catch(() => {});
      return;
    }
    if (frame.generation !== this.generation) return;
    if (frame.type === 'closed') {
      void this.close().catch(() => {});
      return;
    }
    if (frame.type === 'cancel') {
      this.requests.get(frame.id)?.abort.abort();
      return;
    }
    if (frame.type !== 'request') {
      void this.close().catch(() => {});
      return;
    }
    if (this.requests.has(frame.id) || this.recent.has(frame.id)) {
      void this.close().catch(() => {});
      return;
    }
    this.recent.add(frame.id);
    if (this.recent.size > 256) this.recent.delete(this.recent.values().next().value!);
    if (this.requests.size >= MAX_NATIVE_REQUESTS) {
      this.error(frame.id, 'LIMIT');
      return;
    }
    const input = nativeCapabilities[frame.method].input.safeParse(frame.input);
    if (!input.success) {
      this.error(frame.id, 'INVALID');
      return;
    }
    const abort = new AbortController();
    // Dispatch erases the heterogeneous handler parameter locally; both sides use the fixed schema pair.
    const handler = this.handlers[frame.method] as (input: unknown, signal: AbortSignal) => unknown;
    const task = Promise.resolve().then(async () => {
      try {
        if (abort.signal.aborted) return;
        const result = nativeCapabilities[frame.method].output.safeParse(
          await handler(input.data, abort.signal),
        );
        if (!result.success) throw new NativeError('FAILED');
        if (this.active && !abort.signal.aborted)
          await this.send({
            kind: 'axterm-native',
            version: 1,
            generation: this.generation,
            type: 'result',
            id: frame.id,
            value: result.data,
          });
      } catch (error) {
        if (this.active && !abort.signal.aborted)
          this.error(
            frame.id,
            error instanceof NativeError || error instanceof VaultError ? error.code : 'FAILED',
          );
      } finally {
        this.requests.delete(frame.id);
      }
    });
    this.requests.set(frame.id, { abort, done: task });
  }
}
