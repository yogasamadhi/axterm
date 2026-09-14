import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import { NodeLocalFileServer } from '../adapters/widget/node-local-file-server';
import { ElectermLocalFtpServer } from '../adapters/widget/electerm-local-ftp-server';
import { NodeLocalSshServer } from '../adapters/widget/node-local-ssh-server';
import { NodeMcpServer } from '../adapters/widget/node-mcp-server';
import { RealtimeHub } from './realtime-hub';
import { WidgetService } from './widget-service';

const generation = '00000000-0000-4000-8000-000000000090';

describe('WidgetService local file server lifecycle', () => {
  let root: string;
  let outside: string;
  let service: WidgetService;
  let events: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'axterm-widget-root-'));
    outside = await mkdtemp(join(tmpdir(), 'axterm-widget-outside-'));
    await writeFile(join(root, 'index.html'), '<h1>Axterm Widget</h1>');
    await writeFile(join(root, '.private'), 'hidden');
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'payload.txt'), '0123456789');
    await symlink(outside, join(root, 'escape'));
    const host = {
      resolveGrant: vi.fn(async () => ({
        grantId: 'grant_widget',
        kind: 'directory' as const,
        name: 'Shared Files',
        permissions: ['read' as const, 'write' as const],
        createdAt: new Date().toISOString(),
        path: root,
      })),
    } as unknown as HostCapabilityClient;
    const realtime = new RealtimeHub();
    events = [];
    realtime.subscribe((event) => events.push(event.type));
    service = new WidgetService(
      generation,
      host,
      new NodeLocalFileServer(),
      new ElectermLocalFtpServer(),
      new NodeLocalSshServer(),
      realtime,
    );
  });

  afterEach(async () => {
    await service.closeAll();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  it('lists the Electerm-derived catalog and owns a bounded running instance', async () => {
    expect(service.listDefinitions().map(({ id }) => id)).toEqual([
      'file-renamer',
      'local-file-server',
      'local-ftp-server',
      'local-ssh-server',
      'mcp-server',
    ]);
    const instance = await service.startLocalFileServer({ grantId: 'grant_widget' });
    expect(instance).toMatchObject({
      widgetId: 'local-file-server',
      state: 'running',
      ownerGeneration: generation,
      bindHost: '127.0.0.1',
      serverInfo: { rootName: 'Shared Files' },
    });
    expect(instance.port).toBeGreaterThan(0);
    expect(service.resourceCount()).toBe(1);
    expect(events).toContain('widget.instance.started');

    const response = await fetch(instance.serverInfo!.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Axterm Widget');

    const renamed = service.rename(instance.id, { title: 'Release files' });
    expect(renamed.title).toBe('Release files');
    expect(renamed.version).toBe(3);
    expect(service.listInstances()[0]?.title).toBe('Release files');

    const stopped = await service.stop(instance.id);
    expect(stopped.state).toBe('stopped');
    expect(service.listInstances()).toEqual([]);
    expect(events).toEqual([
      'widget.instance.started',
      'widget.instance.renamed',
      'widget.instance.stopping',
      'widget.instance.stopped',
    ]);
    await expect(fetch(instance.serverInfo!.url)).rejects.toThrow();
  });

  it('supports HEAD and ranges while rejecting dotfiles and symlink escape', async () => {
    const instance = await service.startLocalFileServer({
      grantId: 'grant_widget',
      dotfiles: 'deny',
    });
    const url = instance.serverInfo!.url;
    const head = await fetch(`${url}/nested/payload.txt`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
    const range = await fetch(`${url}/nested/payload.txt`, {
      headers: { Range: 'bytes=2-5' },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await range.text()).toBe('2345');
    expect((await fetch(`${url}/.private`)).status).toBe(403);
    expect((await fetch(`${url}/escape/secret.txt`)).status).toBe(403);
  });

  it('rejects grants without directory read scope', async () => {
    const host = {
      resolveGrant: vi.fn(async () => ({
        grantId: 'grant_file',
        kind: 'file' as const,
        name: 'one.txt',
        permissions: ['read' as const],
        createdAt: new Date().toISOString(),
        path: join(root, 'index.html'),
      })),
    } as unknown as HostCapabilityClient;
    const invalid = new WidgetService(
      generation,
      host,
      new NodeLocalFileServer(),
      new ElectermLocalFtpServer(),
      new NodeLocalSshServer(),
      new RealtimeHub(),
    );
    await expect(invalid.startLocalFileServer({ grantId: 'grant_file' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });

  it('previews and idempotently applies a reviewed file rename', async () => {
    await writeFile(join(root, 'alpha.txt'), 'alpha');
    await writeFile(join(root, 'beta.txt'), 'beta');
    const preview = await service.previewFileRename({
      grantId: 'grant_widget',
      template: '{name}-{n:2}.{ext}',
      fileTypes: 'txt',
      includeSubfolders: false,
      startNumber: 1,
      preserveCase: true,
    });
    expect(preview).toMatchObject({ total: 2, ready: 2, conflicts: 0, canRun: true });
    expect(preview.items).toEqual([
      { source: 'alpha.txt', target: 'alpha-01.txt', state: 'ready' },
      { source: 'beta.txt', target: 'beta-02.txt', state: 'ready' },
    ]);

    const first = await service.runFileRename(preview.id, 'rename-receipt');
    const repeated = await service.runFileRename(preview.id, 'rename-receipt');
    expect(repeated).toEqual(first);
    expect(first.renamed).toBe(2);
    expect(await readFile(join(root, 'alpha-01.txt'), 'utf8')).toBe('alpha');
    expect((await readdir(root)).sort()).toContain('beta-02.txt');
    expect(events).toContain('widget.file-renamer.completed');
  });

  it('blocks a rename preview with target conflicts', async () => {
    await writeFile(join(root, 'release.log'), 'one');
    await writeFile(join(root, 'release-1.out'), 'existing');
    const preview = await service.previewFileRename({
      grantId: 'grant_widget',
      template: '{name}-{n}.out',
      fileTypes: 'log',
    });
    expect(preview.conflicts).toBe(1);
    expect(preview.canRun).toBe(false);
    await expect(service.runFileRename(preview.id, 'blocked-rename')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('owns one authenticated MCP instance and deletes its local credential on stop', async () => {
    const deleteCredential = vi.fn(async () => undefined);
    const host = {
      resolveCredential: vi.fn(async () => 'mcp-local-secret-123456'),
      deleteCredential,
    } as unknown as HostCapabilityClient;
    const mcp = new WidgetService(
      generation,
      host,
      new NodeLocalFileServer(),
      new ElectermLocalFtpServer(),
      new NodeLocalSshServer(),
      new RealtimeHub(),
      new NodeMcpServer(),
    );
    mcp.setMcpToolGateway({
      listTools: () => [
        {
          name: 'system.inspectMemory',
          title: 'Inspect memory',
          description: 'Read memory information.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          risk: 'read_only',
        },
      ],
      callTool: async () => ({
        runId: '00000000-0000-4000-8000-000000000091',
        state: 'succeeded',
        result: { freeBytes: 42 },
      }),
    });
    const instance = await mcp.startMcpServer({
      credentialRef: 'cred_mcp',
      port: 0,
      enabledTools: ['system.inspectMemory'],
    });
    expect(instance).toMatchObject({
      widgetId: 'mcp-server',
      bindHost: '127.0.0.1',
      serverInfo: {
        authentication: 'bearer',
        protocol: 'mcp',
        toolCount: 1,
        activeSessions: 0,
      },
    });
    await expect(
      mcp.startMcpServer({
        credentialRef: 'cred_mcp',
        port: 0,
        enabledTools: ['system.inspectMemory'],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await mcp.stop(instance.id);
    expect(deleteCredential).toHaveBeenCalledWith('cred_mcp');
    await mcp.closeAll();
  });
});
