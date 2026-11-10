import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionFetchRoute } from '@axterm/infra-connection';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import WebServer from '@axterm/infra-web-server';
import * as Connection from '@axterm/infra-connection';
import { MANAGED_FILE_IMPORT_PATH, fileGrantSchema } from '@axterm/plugin-api/files';
import { MemoryCredentials } from '../support/level3-memory-credentials.ts';
import { createManagedImportFixture } from '../support/level3-managed-import-fixture.ts';
import { FileHttpImports } from '../../packages/plugins/files/src/adapters/http-imports.ts';
import { ManagedFileImportModel } from '../../packages/plugins/files/src/client/imports.ts';

it('uses authenticated loopback streaming imports, validates actual lengths and exposes no provisional grants', async () => {
  const f = await createManagedImportFixture();
  let imports: FileHttpImports | undefined;
  try {
    await f.ctx.plugin(MemoryCredentials);
    await f.ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
    await f.ctx.plugin(Connection);
    imports = new FileHttpImports(f.ctx, f.files);
    const origin = f.ctx.webServer.getOrigin();
    const body = 'visible user file';
    const headers = {
      'content-type': 'application/octet-stream',
      'x-axterm-file-name': encodeURIComponent('用户文書.txt'),
      'x-axterm-file-size': String(Buffer.byteLength(body)),
    };
    expect(
      (await fetch(origin + MANAGED_FILE_IMPORT_PATH, { method: 'POST', headers, body })).status,
    ).toBe(401);
    const token = (
      await readFile(await f.ctx.connection.createLaunchTokenFile(f.home), 'utf8')
    ).trim();
    const auth = await fetch(origin + '/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(auth.status).toBe(200);
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
    const response = await fetch(origin + MANAGED_FILE_IMPORT_PATH, {
      method: 'POST',
      headers: { ...headers, cookie, 'x-axterm-generation': f.generation },
      body,
    });
    expect(response.status).toBe(200);
    const grant = fileGrantSchema.parse(await response.json());
    expect(grant.permissions).toEqual(['read']);
    expect(grant.name).toBe('用户文書.txt');
    expect(await f.ctx.fileGrants.list()).toEqual([grant]);
    expect((await f.ctx.fileGrants.readText(grant.grantId, 1024)).content).toBe(body);
    await f.ctx.fileGrants.revoke(grant.grantId);
    const mismatch = await fetch(origin + MANAGED_FILE_IMPORT_PATH, {
      method: 'POST',
      headers: {
        ...headers,
        cookie,
        'x-axterm-generation': f.generation,
        'x-axterm-file-size': '1',
      },
      body,
    });
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).details.reason).toBe('invalid-input');
    const chunked = (declared: number, value: string) =>
      fetch(origin + MANAGED_FILE_IMPORT_PATH, {
        method: 'POST',
        headers: {
          ...headers,
          cookie,
          'x-axterm-generation': f.generation,
          'x-axterm-file-size': String(declared),
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(value));
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
    const tooLong = await chunked(1, body);
    expect(tooLong.status).toBe(413);
    expect((await tooLong.json()).details.reason).toBe('capacity');
    const tooShort = await chunked(1024, body);
    expect(tooShort.status).toBe(400);
    expect((await tooShort.json()).details.reason).toBe('invalid-input');
    expect(await f.ctx.fileGrants.list()).toEqual([]);
    const editable = await fetch(origin + MANAGED_FILE_IMPORT_PATH, {
      method: 'POST',
      headers: {
        ...headers,
        cookie,
        'x-axterm-generation': f.generation,
        'x-axterm-editable': '1',
      },
      body,
    });
    expect(editable.status).toBe(200);
    const writable = fileGrantSchema.parse(await editable.json());
    expect(writable.permissions).toEqual(['read', 'write']);
    await f.ctx.fileGrants.revoke(writable.grantId);
    let uploaded: RequestInit['body'];
    const model = new ManagedFileImportModel(
      () => f.generation,
      (input, init) => {
        uploaded = init.body;
        return fetch(new URL(input, origin), {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
        });
      },
    );
    try {
      const file = new File([body], 'client-file.txt');
      const imported = await model.import(file, false);
      expect(uploaded).toBe(file);
      expect((await f.ctx.fileGrants.readText(imported.grantId, 1024)).content).toBe(body);
      expect(Object.isFrozen(imported.permissions)).toBe(true);
      await f.ctx.fileGrants.revoke(imported.grantId);
      const empty = await model.import(new File([], 'empty-file.txt'), false);
      expect((await f.ctx.fileGrants.readText(empty.grantId, 1024)).content).toBe('');
      await f.ctx.fileGrants.revoke(empty.grantId);
    } finally {
      await model.dispose();
    }
    await vi.waitFor(() => expect(imports!.resourceCount()).toBe(0));
    expect(await readdir(join(f.home, 'imports'))).toEqual([]);
    await imports.close();
  } finally {
    await imports?.close();
    await f.close();
  }
});

for (const stop of ['request', 'owner', 'withdrawal-failure'] as const)
  it(`cancels and actually drains an incomplete body on ${stop}`, async () => {
    const f = await createManagedImportFixture();
    let imports: FileHttpImports | undefined;
    try {
      let route: ConnectionFetchRoute | undefined;
      const withdraw = vi.fn(async () => {
        if (stop === 'withdrawal-failure') throw new Error('controlled withdrawal failure');
      });
      // Invoke the exact registered handler with a controllable body; authority,
      // leases and disk cleanup still use the real native bridge fixture.
      const context = {
        runtimeIdentity: f.ctx.runtimeIdentity,
        get: (key: string) => f.ctx.get(key),
        connection: {
          fetch: {
            register(value: typeof route) {
              route = value;
              return withdraw;
            },
          },
        },
      } as unknown as Context;
      imports = new FileHttpImports(context, f.files);
      const abort = new AbortController();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
        },
        cancel() {
          cancelled = true;
        },
      });
      const task = route!.fetch(
        new Request('http://127.0.0.1/api/files/import', {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'x-axterm-file-name': 'incomplete.txt',
            'x-axterm-file-size': '1000',
          },
          body,
          signal: abort.signal,
          duplex: 'half',
        } as RequestInit & { duplex: 'half' }),
      );
      await vi.waitFor(() => expect(f.capabilities.resourceCount()).toBeGreaterThan(0));
      expect(await f.ctx.fileGrants.list()).toEqual([]);
      let closing: Promise<void> | undefined;
      if (stop === 'request') abort.abort();
      else {
        closing = imports.close();
        // Observe the deliberate failure before awaiting another task.
        void closing.catch(() => {});
        expect(imports.close()).toBe(closing);
      }
      const response = await task;
      expect(response.status).toBe(409);
      expect((await response.json()).details.reason).toBe('cancelled');
      if (stop === 'withdrawal-failure')
        await expect(closing).rejects.toMatchObject({ code: 'files/failure' });
      else await (closing ?? imports.close());
      expect(cancelled).toBe(true);
      expect(imports.resourceCount()).toBe(0);
      expect(await readdir(join(f.home, 'imports'))).toEqual([]);
      if (stop === 'withdrawal-failure')
        await expect(imports.close()).rejects.toMatchObject({ code: 'files/failure' });
    } finally {
      await imports?.close().catch(() => {});
      await f.close();
    }
  });
