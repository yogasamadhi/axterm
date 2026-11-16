import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalVaultCredentials } from '../../packages/infra/credential-vault/src/index.ts';
import { PiLoginOwner } from '../../packages/engines/pi/src/login-owner.ts';
import { PiVaultCredentials } from '../../packages/engines/pi/src/credential-store.ts';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
import { streamPiAgent, piCatalog } from '@axterm/engine-pi-core';
import { piSseStart, piSseText, piSseEnd } from '../fixtures/pi-sse.ts';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function boot() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-pi-login-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const ctx = new Context();
  cleanup.push(() => ctx.fiber.dispose());
  await ctx.plugin(LocalVaultCredentials, { directory });
  const owner = new PiLoginOwner(ctx);
  cleanup.push(() => owner.close());
  return { directory, ctx, owner };
}

it('uses Pi API-key prompts, stores only an encrypted grant and cancels unanswered interactions', async () => {
  const { owner, directory, ctx } = await boot();
  const initial = owner.begin('google', 'api_key');
  await vi.waitFor(() => expect(owner.get(initial.id).prompt?.type).toBe('secret'));
  const prompt = owner.get(initial.id).prompt!;
  owner.respond(initial.id, prompt.id, 'LOGIN_API_KEY_CANARY');
  expect(() => owner.respond(initial.id, prompt.id, 'duplicate')).toThrow();
  await vi.waitFor(() => expect(owner.get(initial.id).status).toBe('succeeded'));
  const state = owner.get(initial.id);
  expect(state.models.length).toBeGreaterThan(0);
  expect(JSON.stringify(state)).not.toContain('LOGIN_API_KEY_CANARY');
  const store = new PiVaultCredentials(
    ctx.credentials,
    'google',
    encodeOpaqueCredentialRef(state.credentialRef!),
  );
  expect(await store.read('google')).toEqual({ type: 'api_key', key: 'LOGIN_API_KEY_CANARY' });
  for (const file of await readdir(directory))
    expect(await readFile(join(directory, file), 'utf8')).not.toContain('LOGIN_API_KEY_CANARY');
  await owner.cancel(initial.id);
  expect((await store.read('google'))?.type).toBe('api_key');
  const pending = owner.begin('google', 'api_key');
  await vi.waitFor(() => expect(owner.get(pending.id).prompt).toBeDefined());
  await owner.cancel(pending.id);
  expect(() => owner.get(pending.id)).toThrow();
  await owner.close();
  expect(() => owner.begin('google', 'api_key')).toThrow('CLOSED');
});

it('uses Pi device-code OAuth and exposes subscription metadata without returning tokens', async () => {
  const { owner, directory } = await boot();
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (resource: string | URL | Request) => {
    const url = resource instanceof Request ? resource.url : String(resource);
    urls.push(url);
    if (url === 'https://auth.x.ai/oauth2/device/code')
      return Response.json({
        device_code: 'DEVICE_PRIVATE_CANARY',
        user_code: 'VISIBLE-CODE',
        verification_uri: 'https://auth.x.ai/activate',
        interval: 1,
        expires_in: 60,
      });
    if (url === 'https://auth.x.ai/oauth2/token')
      return Response.json({
        access_token: 'OAUTH_ACCESS_CANARY',
        refresh_token: 'OAUTH_REFRESH_CANARY',
        expires_in: 3600,
      });
    throw new Error('Unexpected authentication network target');
  });
  expect(piCatalog().find(({ id }) => id === 'openai-codex')?.oauth?.subscription).toBe(true);
  const initial = owner.begin('xai', 'oauth');
  await vi.waitFor(() =>
    expect(owner.get(initial.id).events).toContainEqual(
      expect.objectContaining({ type: 'device_code', userCode: 'VISIBLE-CODE' }),
    ),
  );
  await vi.waitFor(() => expect(owner.get(initial.id).status).toBe('succeeded'), { timeout: 3000 });
  expect(JSON.stringify(owner.get(initial.id))).not.toMatch(
    /DEVICE_PRIVATE_CANARY|OAUTH_ACCESS_CANARY|OAUTH_REFRESH_CANARY/,
  );
  expect(urls).toEqual(['https://auth.x.ai/oauth2/device/code', 'https://auth.x.ai/oauth2/token']);
  for (const file of await readdir(directory))
    expect(await readFile(join(directory, file), 'utf8')).not.toMatch(
      /OAUTH_ACCESS_CANARY|OAUTH_REFRESH_CANARY/,
    );
});

it('signs in through the pinned Codex device flow and uses the Vault grant for a Codex response', async () => {
  const { owner, directory, ctx } = await boot();
  const accountId = 'CODEX_ACCOUNT_FIXTURE';
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  ).toString('base64');
  const access = `fixture.${payload}.CODEX_ACCESS_CANARY`;
  const refresh = 'CODEX_REFRESH_CANARY';
  const urls: string[] = [];
  const fetchFixture = async (resource: string | URL | Request, init?: RequestInit) => {
    const request = new Request(resource, init);
    urls.push(request.url);
    switch (request.url) {
      case 'https://auth.openai.com/api/accounts/deviceauth/usercode':
        return Response.json({
          device_auth_id: 'PRIVATE_DEVICE_FIXTURE',
          user_code: 'CODEX-123',
          interval: 1,
        });
      case 'https://auth.openai.com/api/accounts/deviceauth/token':
        return Response.json({
          authorization_code: 'PRIVATE_AUTHORIZATION_CODE',
          code_verifier: 'PRIVATE_VERIFIER_FIXTURE',
        });
      case 'https://auth.openai.com/oauth/token':
        expect(new URLSearchParams(await request.text()).get('code')).toBe(
          'PRIVATE_AUTHORIZATION_CODE',
        );
        return Response.json({ access_token: access, refresh_token: refresh, expires_in: 3600 });
      case 'https://chatgpt.com/backend-api/codex/responses':
        expect(request.headers.get('authorization')).toBe(`Bearer ${access}`);
        expect(request.headers.get('chatgpt-account-id')).toBe(accountId);
        return new Response(
          piSseStart('openai-responses') +
            piSseText('openai-responses', 'Codex subscription reply') +
            piSseEnd('openai-responses'),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      default:
        throw new Error('Unexpected Codex fixture request');
    }
  };
  vi.stubGlobal('fetch', fetchFixture);
  const login = owner.begin('openai-codex', 'oauth');
  await vi.waitFor(() => expect(owner.get(login.id).prompt?.type).toBe('select'));
  const prompt = owner.get(login.id).prompt!;
  expect(prompt.options?.map(({ id }) => id)).toEqual(['browser', 'device_code']);
  owner.respond(login.id, prompt.id, 'device_code');
  await vi.waitFor(() => expect(owner.get(login.id).status).toBe('succeeded'), { timeout: 3000 });
  const complete = owner.get(login.id);
  expect(complete.events).toContainEqual(
    expect.objectContaining({
      type: 'device_code',
      userCode: 'CODEX-123',
      verificationUri: 'https://auth.openai.com/codex/device',
    }),
  );
  expect(JSON.stringify(complete)).not.toMatch(
    /PRIVATE_|CODEX_ACCESS_CANARY|CODEX_REFRESH_CANARY/u,
  );
  const store = new PiVaultCredentials(
    ctx.credentials,
    complete.provider,
    encodeOpaqueCredentialRef(complete.credentialRef!),
  );
  expect(await store.read(complete.provider)).toMatchObject({
    type: 'oauth',
    access,
    refresh,
    accountId,
  });
  for (const file of await readdir(directory))
    expect(await readFile(join(directory, file), 'utf8')).not.toMatch(
      /CODEX_ACCESS_CANARY|CODEX_REFRESH_CANARY/u,
    );
  const events = [];
  for await (const event of streamPiAgent({
    provider: { id: complete.provider, models: [], modelOverrides: {} },
    model: complete.models[0]!.id,
    baseUrl: '',
    credentialStore: store,
    system: 'system',
    prompt: 'hello',
    context: '',
    signal: new AbortController().signal,
    fetch: fetchFixture,
    headers: {},
    timeoutMs: 1000,
  }))
    events.push(event);
  expect(events).toContainEqual({ type: 'delta', text: 'Codex subscription reply' });
  expect(urls).toEqual([
    'https://auth.openai.com/api/accounts/deviceauth/usercode',
    'https://auth.openai.com/api/accounts/deviceauth/token',
    'https://auth.openai.com/oauth/token',
    'https://chatgpt.com/backend-api/codex/responses',
  ]);
});

it('uses Pi provider-specific API-key setup and request authentication for Cloudflare gateways', async () => {
  const { owner, ctx } = await boot();
  const state = owner.begin('cloudflare-ai-gateway', 'api_key');
  for (const answer of ['CLOUDFLARE_KEY_CANARY', 'account-fixture', 'gateway-fixture']) {
    await vi.waitFor(() => expect(owner.get(state.id).prompt).toBeDefined());
    owner.respond(state.id, owner.get(state.id).prompt!.id, answer);
  }
  await vi.waitFor(() => expect(owner.get(state.id).status).toBe('succeeded'));
  const complete = owner.get(state.id);
  expect(JSON.stringify(complete)).not.toContain('CLOUDFLARE_KEY_CANARY');
  const store = new PiVaultCredentials(
    ctx.credentials,
    complete.provider,
    encodeOpaqueCredentialRef(complete.credentialRef!),
  );
  expect(await store.read(complete.provider)).toMatchObject({
    type: 'api_key',
    key: 'CLOUDFLARE_KEY_CANARY',
    env: { CLOUDFLARE_ACCOUNT_ID: 'account-fixture', CLOUDFLARE_GATEWAY_ID: 'gateway-fixture' },
  });
  let requests = 0;
  vi.stubGlobal('fetch', async (resource: string | URL | Request, init?: RequestInit) => {
    const request = new Request(resource, init);
    requests++;
    expect(request.headers.get('cf-aig-authorization')).toBe('Bearer CLOUDFLARE_KEY_CANARY');
    expect(request.headers.has('authorization')).toBe(false);
    return new Response(
      piSseStart('openai-chat') +
        piSseText('openai-chat', 'Gateway reply') +
        piSseEnd('openai-chat'),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const model = complete.models.find((item) => item.api === 'openai-completions')!;
  const events = [];
  for await (const event of streamPiAgent({
    provider: { id: complete.provider, models: [], modelOverrides: {} },
    model: model.id,
    baseUrl: 'https://fixture.example/v1',
    credentialStore: store,
    system: 'system',
    prompt: 'hello',
    context: '',
    signal: new AbortController().signal,
    fetch: globalThis.fetch,
    headers: {},
    timeoutMs: 1000,
  }))
    events.push(event);
  expect(events).toContainEqual({ type: 'delta', text: 'Gateway reply' });
  expect(requests).toBe(1);
});

it('delegates concurrent OAuth refresh to Pi under the actual Vault lock and uses the rotated token', async () => {
  const { ctx } = await boot();
  const reference = encodeOpaqueCredentialRef(randomUUID());
  const store = new PiVaultCredentials(ctx.credentials, 'xai', reference);
  await store.modify('xai', async () => ({
    type: 'oauth',
    access: 'EXPIRED_ACCESS',
    refresh: 'OLD_REFRESH',
    expires: 0,
  }));
  let refreshes = 0;
  const auth: string[] = [];
  vi.stubGlobal('fetch', async (resource: string | URL | Request, init?: RequestInit) => {
    const request = new Request(resource, init);
    if (request.url === 'https://auth.x.ai/oauth2/token') {
      refreshes++;
      expect(await request.text()).toContain('refresh_token=OLD_REFRESH');
      return Response.json({
        access_token: 'ROTATED_ACCESS',
        refresh_token: 'ROTATED_REFRESH',
        expires_in: 3600,
      });
    }
    expect(request.url).toBe('https://fixture.example/v1/responses');
    auth.push(request.headers.get('authorization')!);
    return new Response(
      piSseStart('openai-responses') +
        piSseText('openai-responses', 'Actual Pi reply') +
        piSseEnd('openai-responses'),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const run = async () => {
    const events = [];
    for await (const event of streamPiAgent({
      provider: { id: 'xai', models: [], modelOverrides: {} },
      model: piCatalog().find(({ id }) => id === 'xai')!.models[0]!.id,
      baseUrl: 'https://fixture.example/v1',
      credentialStore: store,
      system: 'system',
      prompt: 'hello',
      context: '',
      signal: new AbortController().signal,
      fetch: globalThis.fetch,
      headers: {},
      timeoutMs: 1000,
    }))
      events.push(event);
    expect(events).toContainEqual({ type: 'delta', text: 'Actual Pi reply' });
    expect(JSON.stringify(events)).not.toMatch(/ROTATED_ACCESS|ROTATED_REFRESH/);
  };
  await Promise.all([run(), run()]);
  expect(refreshes).toBe(1);
  expect(auth).toEqual(['Bearer ROTATED_ACCESS', 'Bearer ROTATED_ACCESS']);
  expect(await store.read('xai')).toMatchObject({
    access: 'ROTATED_ACCESS',
    refresh: 'ROTATED_REFRESH',
  });
});
