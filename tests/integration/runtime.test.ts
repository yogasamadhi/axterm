import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootstrapResponseSchema,
  problemSchema,
  runtimeMetadataSchema,
} from '../../packages/contracts/src/index';
import { startRuntime, type RuntimeOptions } from '../../packages/runtime/src/bootstrap/runtime';
import { createRuntimeClient } from '../../packages/client/src/api-client';

const runtimes: Awaited<ReturnType<typeof startRuntime>>[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function launch(options: Partial<RuntimeOptions> = {}) {
  const runtime = await startRuntime({
    generation: randomUUID(),
    appVersion: '0.1.0',
    mode: 'headless',
    ...options,
  });
  runtimes.push(runtime);
  return runtime;
}
async function login(runtime: Awaited<ReturnType<typeof launch>>) {
  const response = await fetch(`${runtime.baseUrl}/api/v1/auth/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: runtime.bootstrap().bootstrapToken }),
  });
  expect(response.status).toBe(200);
  return bootstrapResponseSchema.parse(await response.json()).sessionToken;
}

describe('real loopback HTTP contract', () => {
  it('exposes only liveness anonymously and authenticates metadata', async () => {
    const runtime = await launch();
    const health = await fetch(`${runtime.baseUrl}/health`);
    expect(await health.json()).toEqual({ status: 'ok' });
    expect(health.headers.get('X-Runtime-Generation')).toBeNull();
    const denied = await fetch(`${runtime.baseUrl}/api/v1/runtime`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('Content-Type')).toContain('application/problem+json');
    expect(problemSchema.parse(await denied.json()).code).toBe('UNAUTHORIZED');
    const token = await login(runtime);
    const headers = { Authorization: `Bearer ${token}` };
    const response = await fetch(`${runtime.baseUrl}/api/v1/runtime`, { headers });
    const metadata = runtimeMetadataSchema.parse(await response.json());
    expect(metadata.generation).toBe(runtime.metadata.generation);
    expect(metadata.pid).toBe(process.pid);
    expect(await (await fetch(`${runtime.baseUrl}/api/v1/version`, { headers })).json()).toEqual({
      apiVersion: 'v1',
      appVersion: '0.1.0',
    });
    expect(
      await (await fetch(`${runtime.baseUrl}/api/v1/capabilities`, { headers })).json(),
    ).toEqual({
      apiVersion: 'v1',
      capabilities: [
        'runtime.metadata',
        'persistence',
        'host.manager',
        'bookmark.tree',
        'connection.history',
        'command.history',
        'connection.profiles',
        'quick-command.tree',
        'batch-operations',
        'terminal.triggers',
        'terminal.information',
        'widgets',
        'terminal.local',
        'terminal.ssh',
        'proxy.ssh',
        'sftp',
        'sftp.recursive',
        'sftp.edit',
        'sftp.chmod',
        'ftp',
        'ftps',
        'ftp.recursive',
        'terminal.telnet',
        'terminal.serial',
        'session.rdp',
        'session.vnc',
        'session.spice',
        'tunnels',
        'ai',
        'ai.tools',
      ],
    });
    const logout = await fetch(`${runtime.baseUrl}/api/v1/auth/logout`, {
      method: 'POST',
      headers,
    });
    expect(logout.status).toBe(204);
    expect((await fetch(`${runtime.baseUrl}/api/v1/runtime`, { headers })).status).toBe(401);
  });
  it('enforces exact Origin, Host, preflight, token replay, query and generation policy', async () => {
    const origin = 'http://127.0.0.1:5173';
    const runtime = await launch({ devOrigin: origin });
    for (const hostile of ['null', 'https://evil.example', 'http://127.0.0.1:5174']) {
      const response = await fetch(`${runtime.baseUrl}/health`, { headers: { Origin: hostile } });
      expect(response.status).toBe(403);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        `${runtime.baseUrl}/health`,
        { headers: { Host: 'evil.example' } },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(hostileHostStatus).toBe(403);
    const preflight = await fetch(`${runtime.baseUrl}/api/v1/runtime`, {
      method: 'OPTIONS',
      headers: { Origin: origin },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    const bootstrapToken = runtime.bootstrap().bootstrapToken;
    const token = await login(runtime);
    const replay = await fetch(`${runtime.baseUrl}/api/v1/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken }),
    });
    expect(replay.status).toBe(401);
    expect(JSON.stringify(await replay.json())).not.toContain(bootstrapToken);
    const stale = await fetch(`${runtime.baseUrl}/api/v1/runtime`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Runtime-Generation': randomUUID() },
    });
    expect(stale.status).toBe(401);
    expect(problemSchema.parse(await stale.json()).code).toBe('STALE_GENERATION');
    expect((await fetch(`${runtime.baseUrl}/health?token=forbidden`)).status).toBe(400);
  });
  it('returns sanitized, typed errors for malformed, oversized and missing input', async () => {
    const runtime = await launch();
    for (const body of [
      '{',
      '{}',
      '{"bootstrapToken":3}',
      '{"bootstrapToken":"secret","unexpected":true}',
    ]) {
      const response = await fetch(`${runtime.baseUrl}/api/v1/auth/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(response.status).toBe(400);
      const problem = problemSchema.parse(await response.json());
      expect(problem.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(problem)).not.toContain('secret');
    }
    const oversized = await fetch(`${runtime.baseUrl}/api/v1/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: 'x'.repeat(5_000) }),
    });
    expect(oversized.status).toBe(413);
    expect(problemSchema.parse(await oversized.json()).code).toBe('PAYLOAD_TOO_LARGE');
    expect((await fetch(`${runtime.baseUrl}/missing`)).status).toBe(404);
  });
  it('rate limits bootstrap attempts', async () => {
    const runtime = await launch();
    let response: Response | undefined;
    for (let i = 0; i < 21; i++)
      response = await fetch(`${runtime.baseUrl}/api/v1/auth/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bootstrapToken: 'x'.repeat(43) }),
      });
    expect(response?.status).toBe(429);
  });
  it('serves production assets with strict CSP and no path or API fallback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-assets-'));
    directories.push(directory);
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'index.html'), '<!doctype html><title>fixture</title>');
    await writeFile(join(directory, 'assets/app.js'), 'export const ready = true;');
    const runtime = await launch({ rendererDirectory: directory });
    const page = await fetch(`${runtime.baseUrl}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('fixture');
    expect(page.headers.get('Content-Security-Policy')).toContain(
      "script-src 'self' 'wasm-unsafe-eval';",
    );
    expect(page.headers.get('Content-Security-Policy')).not.toContain(
      "script-src 'self' 'unsafe-inline'",
    );
    expect(page.headers.get('Content-Security-Policy')).not.toContain("'unsafe-eval'");
    expect(page.headers.get('Content-Security-Policy')).toContain(
      "style-src 'self' 'unsafe-inline'",
    );
    expect((await fetch(`${runtime.baseUrl}/assets/app.js`)).status).toBe(200);
    expect((await fetch(`${runtime.baseUrl}/assets/%2e%2e%2fpackage.json`)).status).toBe(404);
    const token = await login(runtime);
    expect(
      (
        await fetch(`${runtime.baseUrl}/api/v1/unknown`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
  });
  it('closes HTTP listeners deterministically, including repeated shutdown', async () => {
    const runtime = await launch();
    await fetch(`${runtime.baseUrl}/health`);
    await Promise.all([runtime.close(), runtime.close()]);
    await expect(fetch(`${runtime.baseUrl}/health`)).rejects.toThrow();
  });
  it('runs generated Client against HTTP, rediscovers after restart and rejects old sessions', async () => {
    let runtime = await launch();
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    try {
      const [first, parallel] = await Promise.all([client.status(), client.status()]);
      expect(first.metadata).toEqual(parallel.metadata);
      await runtime.close();
      runtime = await launch();
      await expect(client.status()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
      const second = await client.status();
      expect(second.metadata.generation).not.toBe(first.metadata.generation);
      expect(JSON.stringify(second)).not.toMatch(/sessionToken|bootstrapToken|Authorization/);
    } finally {
      client.dispose();
    }
  });
  it('discards pending responses from an earlier generation even when transport ignores abort', async () => {
    const runtime = await launch();
    let release: (() => void) | undefined;
    let signalBlocked: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      signalBlocked = resolve;
    });
    let delay = false;
    const client = createRuntimeClient(
      { resolve: async () => runtime.bootstrap() },
      async (input, init) => {
        const response = await fetch(input, init);
        if (
          delay &&
          input instanceof Request &&
          new URL(input.url).pathname === '/api/v1/runtime'
        ) {
          signalBlocked?.();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return response;
      },
    );
    try {
      await client.status();
      delay = true;
      const pending = client.status();
      const rejected = expect(pending).rejects.toMatchObject({ code: 'STALE_GENERATION' });
      await blocked;
      client.reconnect();
      release?.();
      await rejected;
    } finally {
      client.dispose();
    }
  });
});
