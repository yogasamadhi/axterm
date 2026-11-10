import { assertWidgetAuthority } from '../../packages/plugins/automation/src/adapters/widget-authority.ts';
import { NodeLocalFileServer } from '../../packages/plugins/automation/src/adapters/widgets/node-local-file-server.ts';
import { NodeLocalFtpServer } from '../../packages/plugins/automation/src/adapters/widgets/node-local-ftp-server.ts';
import { NodeLocalSshServer } from '../../packages/plugins/automation/src/adapters/widgets/node-local-ssh-server.ts';
import { NodeMcpServer } from '../../packages/plugins/automation/src/adapters/widgets/node-mcp-server.ts';
import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Client as FtpClient } from 'basic-ftp';
import { createRequire } from 'node:module';
import type * as Ssh2 from 'ssh2';
const { Client: SshClient } = createRequire(
  new URL('../../packages/plugins/automation/package.json', import.meta.url),
)('ssh2') as typeof Ssh2;
import { afterEach, expect, it, vi } from 'vitest';
import { NativeFileGrantRegistry } from '@axterm/infra-desktop-native';
import type { FileGrants } from '@axterm/plugin-api/host';
import LocalSubprocess from '@axterm/infra-subprocess-local';
import { GrantedStreamingFiles } from '../../packages/plugins/files/src/adapters/streaming-files.ts';
import { WidgetServers } from '../../packages/plugins/automation/src/application/widgets.ts';
import { WidgetCommands } from '../../packages/plugins/automation/src/adapters/widget-commands.ts';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(gate?: Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-l3-widgets-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const generation = randomUUID(),
    ctx = new Context();
  cleanup.push(() => ctx.fiber.dispose());
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.automation);
  cleanup.push(() => domain.close());
  const registry = new NativeFileGrantRegistry(generation);
  cleanup.push(() => registry.close());
  const leases = new Set<AbortController>();
  const grants: Pick<FileGrants, 'authorize'> = {
    authorize: async (id, permission, signal) => {
      const abort = new AbortController();
      const live = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
      await gate;
      const authority = await registry.authorize(id, permission, live);
      leases.add(abort);
      return {
        authority,
        signal: live,
        assert: () => live.throwIfAborted(),
        dispose: () => {
          abort.abort();
          leases.delete(abort);
        },
      };
    },
  };
  ctx.provide('fileGrants', grants as FileGrants);
  ctx.provide('files', new GrantedStreamingFiles(() => grants));
  const grant = await registry.createTrustedPath(directory, 'directory', ['read', 'write']);
  const owner = new WidgetServers(
    ctx,
    generation,
    {
      assertAuthority: assertWidgetAuthority,
      file: new NodeLocalFileServer(),
      ftp: new NodeLocalFtpServer(),
      ssh: (subprocess) => new NodeLocalSshServer(subprocess),
      mcp: new NodeMcpServer(),
    },
    new WidgetCommands(domain, 'desktop', generation),
  );
  cleanup.push(() => owner.close());
  return { directory, generation, ctx, registry, grant, owner, leases, domain };
}
it('serves bounded Files-owned HTTP ranges, replaces facts, replays only the same identity and stops on grant revocation', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'hello.txt'), 'abcdefgh');
  const watch = f.owner.watch(new AbortController().signal);
  const baseline = await watch.next();
  expect(baseline.value?.type).toBe('baseline');
  const key = randomUUID(),
    input = { grantId: f.grant.grantId, port: 0 };
  const started = await f.owner.start(key, f.generation, 'local-file-server', input);
  expect(started.status).toBe('completed');
  const instance = started.instance!;
  expect(JSON.stringify(f.owner.facts())).not.toContain(f.directory);
  const response = await fetch(instance.serverInfo!.url + '/hello.txt', {
    headers: { range: 'bytes=2-4' },
  });
  expect(response.status).toBe(206);
  expect(await response.text()).toBe('cde');
  expect((await f.owner.start(key, f.generation, 'local-file-server', input)).instance!.id).toBe(
    instance.id,
  );
  expect(() =>
    f.owner.start(key, f.generation, 'local-file-server', { ...input, port: 1 }),
  ).toThrow();
  expect((await watch.next()).value?.type).toBe('replace');
  for (const lease of [...f.leases]) lease.abort();
  await vi.waitFor(() => expect(f.owner.facts().instances).toHaveLength(0));
  expect(f.owner.outcome(key, f.generation).status).toBe('completed');
  await watch.return?.();
});
it('reserves capacity before async grant authorization and drains failed starts', async () => {
  const admitted = Promise.withResolvers<void>(),
    f = await fixture(admitted.promise);
  const starts = Array.from({ length: 9 }, () =>
    f.owner.start(randomUUID(), f.generation, 'local-file-server', {
      grantId: f.grant.grantId,
      port: 0,
    }),
  );
  await Promise.resolve();
  expect(f.owner.facts().instances).toHaveLength(8);
  admitted.resolve();
  const results = await Promise.all(starts);
  expect(results.filter((result) => result.status === 'completed')).toHaveLength(8);
  expect(results[8]!.reason).toBe('capacity');
  await f.owner.close();
  expect(f.owner.active()).toBe(false);
});
it('retains real FTP authentication, streaming upload and download through an owned grant', async () => {
  const f = await fixture();
  const started = await f.owner.start(randomUUID(), f.generation, 'local-ftp-server', {
    grantId: f.grant.grantId,
    port: 0,
    username: 'tester',
    password: 'FTP_WIDGET_SECRET',
    passivePortStart: 51160,
    passivePortEnd: 51167,
  });
  expect(started.status).toBe('completed');
  const client = new FtpClient(3000);
  cleanup.push(() => client.close());
  await client.access({
    host: '127.0.0.1',
    port: started.instance!.port!,
    user: 'tester',
    password: 'FTP_WIDGET_SECRET',
  });
  await client.uploadFrom(Readable.from(['owned-ftp']), 'uploaded.txt');
  expect(await readFile(join(f.directory, 'uploaded.txt'), 'utf8')).toBe('owned-ftp');
  expect(JSON.stringify(f.owner.facts())).not.toContain('FTP_WIDGET_SECRET');
  client.close();
  await f.owner.stop(randomUUID(), f.generation, started.instance!.id);
  expect(f.owner.facts().instances).toHaveLength(0);
});
it('runs real SSH exec through ctx.subprocess and releases sessions before stop completes', async () => {
  const f = await fixture();
  await f.ctx.plugin(LocalSubprocess);
  const started = await f.owner.start(randomUUID(), f.generation, 'local-ssh-server', {
    grantId: f.grant.grantId,
    port: 0,
    username: 'tester',
    password: 'SSH_WIDGET_SECRET',
  });
  expect(started.status).toBe('completed');
  const client = new SshClient();
  cleanup.push(() => {
    client.end();
  });
  await new Promise<void>((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
    client.connect({
      host: '127.0.0.1',
      port: started.instance!.port!,
      username: 'tester',
      password: 'SSH_WIDGET_SECRET',
      readyTimeout: 3000,
    });
  });
  const output = await new Promise<string>((resolve, reject) =>
    client.exec('printf OWNED_WIDGET_EXEC', (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      let text = '';
      stream.on('data', (data: Buffer) => (text += data.toString()));
      stream.once('close', () => resolve(text));
      stream.once('error', reject);
    }),
  );
  expect(output).toBe('OWNED_WIDGET_EXEC');
  const sftp = await new Promise<Ssh2.SFTPWrapper>((resolve, reject) =>
    client.sftp((error, channel) => (error ? reject(error) : resolve(channel))),
  );
  await new Promise<void>((resolve, reject) =>
    sftp.writeFile('sftp.txt', 'OWNED_SFTP', (error) => (error ? reject(error) : resolve())),
  );
  expect(await readFile(join(f.directory, 'sftp.txt'), 'utf8')).toBe('OWNED_SFTP');
  sftp.end();
  const shell = await new Promise<string>((resolve, reject) =>
    client.shell({ term: 'xterm', cols: 80, rows: 24 }, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      let text = '';
      stream.on('data', (data: Buffer) => (text += data.toString()));
      stream.once('close', () => resolve(text));
      stream.once('error', reject);
      stream.write('printf OWNED_WIDGET_PTY; exit\n');
    }),
  );
  expect(shell).toContain('OWNED_WIDGET_PTY');

  client.end();
  await f.owner.stop(randomUUID(), f.generation, started.instance!.id);
  expect(f.owner.active()).toBe(false);
});
it.each([false, true])(
  'authenticates MCP through current credentials and cancels its existing AI source before draining HTTP (owned=%s)',
  async (owned) => {
    const f = await fixture(),
      closed = vi.fn(async () => {}),
      callTool = vi.fn(async () => ({
        runId: randomUUID(),
        state: 'succeeded' as const,
        result: { visible: true },
      }));
    const removeOwned = vi.fn(async () => {});
    f.ctx.provide('temporaryCredentials', { removeOwned });
    const credentialRef = 'cred_' + randomUUID(),
      proof = { generation: f.generation, commandId: randomUUID() };
    f.ctx.provide('credentials', {
      resolve: async () => ({ value: 'MCP_WIDGET_SECRET', source: 'fixture' }),
    } as unknown as Context['credentials']);
    f.ctx.provide('aiMcpTools', {
      listTools: () => [
        {
          name: 'host.getSummary',
          title: 'Summary',
          description: 'Visible summary',
          inputSchema: { type: 'object' },
          risk: 'read_only',
        },
      ],
      registerSource: () => ({
        listTools: () => [
          {
            name: 'host.getSummary',
            title: 'Summary',
            description: 'Visible summary',
            inputSchema: { type: 'object' },
            risk: 'read_only',
          },
        ],
        callTool,
        close: closed,
      }),
    });
    const started = await f.owner.start(randomUUID(), f.generation, 'mcp-server', {
      port: 0,
      credentialRef,
      ...(owned ? { ownedCredential: proof } : {}),
      enabledTools: ['host.getSummary'],
    });
    expect(started.status).toBe('completed');
    expect(
      f.owner.facts().instances.find((item) => item.id === started.instance!.id),
    ).toMatchObject({
      widgetId: 'mcp-server',
      bindHost: '127.0.0.1',
      serverInfo: { authentication: 'bearer', protocol: 'mcp', toolCount: 1, activeSessions: 0 },
    });
    const second = await f.owner.start(randomUUID(), f.generation, 'mcp-server', {
      port: 0,
      credentialRef,
      enabledTools: ['host.getSummary'],
    });
    expect(second).toMatchObject({ status: 'failed', reason: 'capacity' });
    const url = started.instance!.serverInfo!.url;
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer MCP_WIDGET_SECRET',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'fixture', version: '1' },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(f.owner.facts())).not.toContain('MCP_WIDGET_SECRET');
    await f.owner.stop(randomUUID(), f.generation, started.instance!.id);
    expect(closed).toHaveBeenCalledOnce();
    if (owned) {
      expect(removeOwned).toHaveBeenCalledOnce();
      expect(removeOwned).toHaveBeenCalledWith(
        expect.any(String),
        f.generation,
        credentialRef,
        proof,
      );
    } else expect(removeOwned).not.toHaveBeenCalled();
  },
);

it('retains the exact five-widget catalog, scoped HTTP lifecycle, version-three rename and stream withdrawal', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'index.html'), '<h1>Axterm Widget</h1>');
  expect(f.owner.facts().definitions.map(({ id }) => id)).toEqual([
    'file-renamer',
    'local-file-server',
    'local-ftp-server',
    'local-ssh-server',
    'mcp-server',
  ]);
  const watch = f.owner.watch(new AbortController().signal);
  expect((await watch.next()).value?.type).toBe('baseline');
  const started = await f.owner.start(randomUUID(), f.generation, 'local-file-server', {
      grantId: f.grant.grantId,
      port: 0,
    }),
    instance = started.instance!;
  expect(instance).toMatchObject({
    widgetId: 'local-file-server',
    state: 'running',
    ownerGeneration: f.generation,
    bindHost: '127.0.0.1',
    serverInfo: { rootName: f.grant.name },
  });
  expect(instance.port).toBeGreaterThan(0);
  expect(f.owner.facts().instances).toHaveLength(1);
  expect(f.owner.active()).toBe(true);
  const running = (await watch.next()).value;
  expect(running).toMatchObject({
    type: 'replace',
    instances: [{ id: instance.id, state: 'running' }],
  });
  const response = await fetch(instance.serverInfo!.url);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('Axterm Widget');
  const renamed = await f.owner.rename(randomUUID(), f.generation, instance.id, {
    title: 'Release files',
  });
  expect(renamed.instance).toMatchObject({ title: 'Release files', version: 3 });
  expect(f.owner.facts().instances[0]?.title).toBe('Release files');
  const next = (await watch.next()).value;
  expect(next).toMatchObject({
    type: 'replace',
    instances: [{ id: instance.id, title: 'Release files' }],
  });
  expect(next!.cursor).toBeGreaterThan(running!.cursor);
  const stopped = await f.owner.stop(randomUUID(), f.generation, instance.id);
  expect(stopped.instance?.state).toBe('stopped');
  expect(f.owner.facts().instances).toEqual([]);
  expect((await watch.next()).value).toMatchObject({ type: 'replace', instances: [] });
  await expect(fetch(instance.serverInfo!.url)).rejects.toThrow();
  await watch.return?.();
  expect(f.leases.size).toBe(0);
});
it('retains HEAD and exact ranges while refusing dotfiles and a real symlink escape through Files', async () => {
  const f = await fixture(),
    outside = await mkdtemp(join(tmpdir(), 'axterm-widget-outside-'));
  cleanup.push(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(f.directory, 'nested'));
  await writeFile(join(f.directory, 'nested/payload.txt'), '0123456789');
  await writeFile(join(f.directory, '.private'), 'hidden');
  await writeFile(join(outside, 'secret.txt'), 'outside');
  await symlink(outside, join(f.directory, 'escape'));
  const started = await f.owner.start(randomUUID(), f.generation, 'local-file-server', {
    grantId: f.grant.grantId,
    port: 0,
    dotfiles: 'deny',
  });
  const url = started.instance!.serverInfo!.url;
  const head = await fetch(url + '/nested/payload.txt', { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.headers.get('content-length')).toBe('10');
  expect(await head.text()).toBe('');
  const range = await fetch(url + '/nested/payload.txt', { headers: { Range: 'bytes=2-5' } });
  expect(range.status).toBe(206);
  expect(range.headers.get('content-range')).toBe('bytes 2-5/10');
  expect(await range.text()).toBe('2345');
  for (const path of ['/.private', '/escape/secret.txt']) {
    const denied = await fetch(url + path);
    expect(denied.status).toBe(403);
    await denied.body?.cancel();
  }
  await f.owner.stop(randomUUID(), f.generation, started.instance!.id);
  expect(f.leases.size).toBe(0);
});
it('rejects a file grant before admitting any directory server and releases its selected authority', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'one.txt'), 'one');
  const grant = await f.registry.createTrustedPath(join(f.directory, 'one.txt'), 'file', ['read']);
  const result = await f.owner.start(randomUUID(), f.generation, 'local-file-server', {
    grantId: grant.grantId,
    port: 0,
  });
  expect(result).toMatchObject({ status: 'failed', reason: 'invalid-input' });
  expect(f.owner.facts().instances).toEqual([]);
  expect(f.leases.size).toBe(0);
});

it('keeps serving after the bounded receipt window while refusing an expired nonce without replay', async () => {
  const f = await fixture();
  const firstKey = randomUUID();
  const input = { grantId: f.grant.grantId, port: 0 };
  const first = await f.owner.start(firstKey, f.generation, 'local-file-server', input);
  await f.owner.stop(randomUUID(), f.generation, first.instance!.id);
  for (let cycle = 0; cycle < 1050; cycle++) {
    const started = await f.owner.start(randomUUID(), f.generation, 'local-file-server', input);
    expect(started.status).toBe('completed');
    expect((await f.owner.stop(randomUUID(), f.generation, started.instance!.id)).status).toBe(
      'completed',
    );
  }
  expect(f.owner.resourceSnapshot().widgetCommandReceipts).toBeLessThanOrEqual(2048);
  const durable = JSON.stringify(f.domain.all('SELECT * FROM axterm_automation_command_receipts'));
  expect(f.domain.all('SELECT command_id FROM axterm_automation_command_receipts')).toHaveLength(
    2102,
  );
  expect(durable).not.toContain(f.grant.grantId);
  expect(durable).not.toContain(f.directory);
  const reopened = new WidgetCommands(f.domain, 'desktop', f.generation);
  expect(reopened.admit(firstKey, 'start:local-file-server', input)).toBe(false);
  expect(() =>
    new WidgetCommands(f.domain, 'desktop', randomUUID()).admit(
      firstKey,
      'start:local-file-server',
      input,
    ),
  ).toThrow(expect.objectContaining({ details: { reason: 'conflict' } }));
  expect(f.owner.facts().instances).toEqual([]);
  expect(await f.owner.start(firstKey, f.generation, 'local-file-server', input)).toMatchObject({
    status: 'failed',
    reason: 'receipt-expired',
  });
  expect(f.owner.outcome(firstKey, f.generation)).toMatchObject({
    status: 'failed',
    reason: 'receipt-expired',
  });
  expect(() =>
    f.owner.start(firstKey, f.generation, 'local-file-server', { ...input, port: 1 }),
  ).toThrow(expect.objectContaining({ details: { reason: 'conflict' } }));
  expect(f.owner.facts().instances).toEqual([]);
  await f.owner.close();
  expect(Object.values(f.owner.resourceSnapshot()).every((value) => value === 0)).toBe(true);
}, 30_000);
