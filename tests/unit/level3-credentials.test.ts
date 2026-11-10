// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/credentials/credentials/tests/credentials.spec.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  credentialRef,
  encodeOpaqueCredentialRef,
  decodeOpaqueCredentialRef,
  isCredentialKeySegment,
} from '../../packages/infra/credentials/src/index.ts';
import type { CredentialRef } from '../../packages/infra/credentials/src/index.ts';
import * as PublicCredentials from '@axterm/plugin-api/credentials';
import { credentialKey, parseCredentialKey } from '../../packages/infra/credentials/src/index.ts';
import { MemoryCredentials } from '../support/level3-memory-credentials.ts';

const REF = credentialRef('PROVIDER_API_KEY');

const contexts: Context[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
});

async function boot(seed: Record<string, string> = {}): Promise<Context> {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(MemoryCredentials, seed);
  return ctx;
}

describe('credentialRef', () => {
  it('brands POSIX shell identifiers', () => {
    expect(credentialRef('PROVIDER_API_KEY')).toBe('PROVIDER_API_KEY');
    expect(credentialRef('_private')).toBe('_private');
    expect(credentialRef('lower_case9')).toBe('lower_case9');
  });

  it('rejects every other shape', () => {
    for (const invalid of ['', '9LEADING', 'WITH-DASH', 'WITH SPACE', 'ns:key']) {
      expect(() => credentialRef(invalid)).toThrow(TypeError);
    }
  });
});

describe('isCredentialKeySegment', () => {
  it('answers whether credentialKey would accept the segment', () => {
    for (const valid of ['llm-pi-ai', 'openai-codex', 'a', 'z9']) {
      expect(isCredentialKeySegment(valid)).toBe(true);
    }
    // The shapes an arbitrary settings dict key can take that a record id
    // cannot: a consumer asks here instead of learning it from a throw.
    for (const invalid of ['', 'My_Proxy', 'z.ai', 'UPPER', '9leading', 'a/b']) {
      expect(isCredentialKeySegment(invalid)).toBe(false);
    }
  });
});

describe('the credentials seam through the memory provider', () => {
  it('mounts as ctx.credentials and resolves a seeded reference with its source', async () => {
    const ctx = await boot({ PROVIDER_API_KEY: 'sk-seeded' });
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-seeded', source: 'memory' });
    expect(await ctx.credentials.describe(REF)).toEqual({
      configured: true,
      source: 'memory',
      writable: true,
    });
  });

  it('treats an empty stored value as absent everywhere', async () => {
    const ctx = await boot({ PROVIDER_API_KEY: '' });
    expect(await ctx.credentials.resolve(REF)).toBeUndefined();
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: false, writable: true });
  });

  it('stores through set, removes through unset, and emits the committed change', async () => {
    const ctx = await boot();
    const events: CredentialRef[] = [];
    ctx.on('credentials/reference-updated', (ref) => void events.push(ref));

    await ctx.credentials.set(REF, 'sk-live');
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-live', source: 'memory' });
    await ctx.credentials.unset(REF);
    expect(await ctx.credentials.resolve(REF)).toBeUndefined();
    expect(events).toEqual([REF, REF]);
  });

  it('rejects an empty set and keeps an absent unset silent', async () => {
    const ctx = await boot();
    const events: CredentialRef[] = [];
    ctx.on('credentials/reference-updated', (ref) => void events.push(ref));

    await expect(ctx.credentials.set(REF, '')).rejects.toThrow(/empty value/);
    await ctx.credentials.unset(REF);
    expect(events).toEqual([]);
  });

  it('removes the service with its fiber', async () => {
    const ctx = new Context();
    const fiber = await ctx.plugin(MemoryCredentials);
    expect(ctx.get('credentials')).toBeDefined();
    await fiber.dispose();
    expect(ctx.get('credentials')).toBeUndefined();
  });
});

it('maps legacy and Unicode identifiers reversibly without changing the source identifier', () => {
  for (const original of [
    'cred_19bd4dc7-a193-4336-82c7-3bd69ec92111',
    'folder/reference:v2',
    '凭据🗝️',
    '\uFEFFidentifier',
  ]) {
    const encoded = encodeOpaqueCredentialRef(original);
    expect(encoded).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    expect(decodeOpaqueCredentialRef(encoded)).toBe(original);
  }
  for (const invalid of ['CREF1_0', 'CREF1_ff', 'CREF1_FF', 'CREF1_C080', 'CREF1_EDA080'])
    expect(() => decodeOpaqueCredentialRef(credentialRef(invalid))).toThrow();
  for (const invalid of ['', '\uD800', 'a'.repeat(513)])
    expect(() => encodeOpaqueCredentialRef(invalid)).toThrow();
});

it('contains secret-bearing observer failures after commit and reports only the stable failure code', async () => {
  const ctx = await boot();
  const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {});
  ctx.on('credentials/reference-updated', () => {
    throw new Error('PRIVATE_OBSERVER_MARKER');
  });
  ctx.on('credentials/reference-updated', async () => {
    throw new Error('PRIVATE_ASYNC_OBSERVER_MARKER');
  });
  await ctx.credentials.set(REF, 'stored-value');
  await Promise.resolve();
  expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'stored-value', source: 'memory' });
  expect(warning).toHaveBeenCalled();
  expect(JSON.stringify(warning.mock.calls)).toContain('CREDENTIAL_LISTENER_FAILED');
  expect(JSON.stringify(warning.mock.calls)).not.toContain('PRIVATE_');
});

it('uses the public constructors and brands through the private provider compatibility facade', async () => {
  expect(credentialRef).toBe(PublicCredentials.credentialRef);
  expect(encodeOpaqueCredentialRef).toBe(PublicCredentials.encodeOpaqueCredentialRef);
  expect(decodeOpaqueCredentialRef).toBe(PublicCredentials.decodeOpaqueCredentialRef);
  expect(credentialKey).toBe(PublicCredentials.credentialKey);
  expect(parseCredentialKey).toBe(PublicCredentials.parseCredentialKey);
  const ctx = await boot();
  const ref = PublicCredentials.credentialRef('EXTERNAL_PLUGIN_KEY');
  await ctx.credentials.set(ref, 'host-only-fixture');
  expect(await ctx.credentials.resolve(ref)).toEqual({
    value: 'host-only-fixture',
    source: 'memory',
  });
  const key = PublicCredentials.credentialKey('external-plugin', 'account');
  await ctx.credentials.modifyRecord(key, async () => ({
    kind: 'grant',
    payload: { token: 'host-only-fixture' },
  }));
  expect(await ctx.credentials.listRecords()).toEqual([{ key, kind: 'grant' }]);
});
