import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { EngineError } from '@axterm/engine-api';
import { loginPiProvider, piCatalog, type PiLoginInteraction } from '@axterm/engine-pi-core';
import {
  piLoginStateSchema,
  piLoginPromptSchema,
  piLoginEventSchema,
  type PiLoginState,
} from '@axterm/plugin-api/ai';
import type { PiProviderAuth } from '@axterm/plugin-api/host';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
import { PiVaultCredentials } from './credential-store.ts';

interface Login {
  state: PiLoginState;
  abort: AbortController;
  done: Promise<void>;
  timer?: ReturnType<typeof setTimeout> | undefined;
  answer?: { id: string; resolve(value: string): void } | undefined;
}
/** Bounded, generation-owned UI bridge; all authentication protocol work belongs to Pi. */
export class PiLoginOwner implements PiProviderAuth {
  private readonly logins = new Map<string, Login>();
  private closed = false;
  constructor(private readonly ctx: Context) {}
  begin(provider: string, method: 'api_key' | 'oauth'): PiLoginState {
    if (this.closed) throw new EngineError('closed');
    if (this.logins.size >= 4) throw new EngineError('capacity');
    const known = piCatalog().find((item) => item.id === provider);
    if (!known || (method === 'oauth' ? !known.oauth : !known.apiKeyAvailable))
      throw new EngineError('unsupported');
    const id = randomUUID();
    const reference = randomUUID();
    const abort = new AbortController();
    const login: Login = {
      state: { id, provider, status: 'running', events: [], models: [] },
      abort,
      done: Promise.resolve(),
    };
    this.logins.set(id, login);
    login.timer = setTimeout(() => abort.abort(), 15 * 60_000);
    login.timer.unref();
    const store = new PiVaultCredentials(
      this.ctx.credentials,
      provider,
      encodeOpaqueCredentialRef(reference),
    );
    const interaction: PiLoginInteraction = {
      signal: abort.signal,
      prompt: (value) => {
        const { signal: _signal, ...metadata } = value;
        const prompt = piLoginPromptSchema.parse({
          ...metadata,
          id: randomUUID(),
          options: value.options ? [...value.options] : undefined,
        });
        // Per-prompt cancellation lets Pi's browser callback win its manual-paste race.
        const signal = value.signal ? AbortSignal.any([abort.signal, value.signal]) : abort.signal;
        return new Promise((resolve, reject) => {
          if (login.answer) return reject(new EngineError('busy'));
          const finish = (answer?: string) => {
            signal.removeEventListener('abort', cancel);
            if (login.answer?.id === prompt.id) {
              login.answer = undefined;
              delete login.state.prompt;
            }
            if (answer === undefined) reject(new EngineError('cancelled'));
            else resolve(answer);
          };
          const cancel = () => finish();
          login.state.prompt = prompt;
          login.answer = { id: prompt.id, resolve: (answer) => finish(answer) };
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) cancel();
        });
      },
      notify: (value) => {
        if (JSON.stringify(value).length > 32768) throw new EngineError('capacity');
        login.state.events = [...login.state.events, piLoginEventSchema.parse(value)].slice(-16);
      },
    };
    login.done = Promise.resolve()
      .then(async () => {
        const models = await loginPiProvider(provider, method, store, interaction);
        abort.signal.throwIfAborted();
        login.state = { ...login.state, status: 'succeeded', credentialRef: reference, models };
      })
      .catch(async () => {
        login.state = { ...login.state, status: abort.signal.aborted ? 'canceled' : 'failed' };
        await store.delete(provider);
      })
      .finally(() => {
        clearTimeout(login.timer);
        delete login.state.prompt;
        login.answer = undefined;
        // A crashed/disconnected page cannot retain a terminal login slot forever.
        login.timer = setTimeout(() => {
          void this.cancel(id).catch(() => {});
        }, 60_000);
        login.timer.unref();
      });
    void login.done.catch(() => {});
    return this.get(id);
  }
  get(id: string): PiLoginState {
    if (this.closed) throw new EngineError('closed');
    const login = this.logins.get(id);
    if (!login) throw new EngineError('missing');
    return piLoginStateSchema.parse(login.state);
  }
  respond(id: string, promptId: string, value: string): void {
    const state = this.get(id);
    const login = this.logins.get(id)!;
    if (value.length > 131072 || login.answer?.id !== promptId || state.status !== 'running')
      throw new EngineError('invalid');
    if (
      state.prompt?.type === 'select' &&
      !state.prompt.options?.some((option) => option.id === value)
    )
      throw new EngineError('invalid');
    login.answer.resolve(value);
  }
  async cancel(id: string): Promise<void> {
    const login = this.logins.get(id);
    if (!login) return;
    login.abort.abort();
    await login.done;
    clearTimeout(login.timer);
    // Completed grants may already be referenced by a committed provider: retain them.
    this.logins.delete(id);
  }
  async secrets(provider: string, reference: string): Promise<readonly string[]> {
    const store = new PiVaultCredentials(
      this.ctx.credentials,
      provider,
      encodeOpaqueCredentialRef(reference),
    );
    const value = await store.read(provider);
    if (!value) throw new EngineError('missing');
    return value.type === 'oauth'
      ? [value.access, value.refresh]
      : [value.key ?? '', ...Object.values(value.env ?? {})];
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.logins.keys()].map((id) => this.cancel(id)));
  }
}
