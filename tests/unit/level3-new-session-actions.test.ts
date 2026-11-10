import {
  CatalogEditorOwner,
  type CatalogEditorServices,
} from '../../packages/plugins/catalog/src/client/ui/editor/owner.ts';
import type { SavedCredentialActions } from '@axterm/plugin-api/saved-credentials';
import { expect, it, vi } from 'vitest';
import {
  hostSchema,
  createHostSchema,
  bookmarkTreeSchema,
  connectionHistoryPageSchema,
  type CatalogBaseline,
  type Host,
} from '@axterm/plugin-api/catalog';
import type { CatalogState } from '../../packages/plugins/catalog/src/client/index.ts';
import { NewSessionActions } from '../../packages/plugins/catalog/src/client/ui/session/actions.ts';
import {
  parseQuickConnect,
  type QuickConnectTarget,
} from '../../packages/plugins/catalog/src/client/ui/session/parser.ts';
import { matchesSessionShortcut } from '../../packages/plugins/catalog/src/client/ui/session/shortcut.ts';
const secret = 'QUICK_SECRET_CANARY';
function baseline(generation: string, hosts: readonly Host[]): CatalogBaseline {
  return {
    generation,
    cursor: 0,
    hosts,
    hostGroups: [],
    connectionProfiles: [],
    bookmarks: bookmarkTreeSchema.parse({
      revision: 1,
      etag: '"bookmark-tree-v1"',
      groups: [],
      bookmarks: [],
    }),
    history: connectionHistoryPageSchema.parse({
      revision: 1,
      etag: '"connection-history-v1"',
      sort: 'recent',
      limit: 25,
      total: 0,
      items: [],
      nextCursor: null,
    }),
  };
}
function fixture() {
  let generation = crypto.randomUUID();
  const host = hostSchema.parse({
    ...createHostSchema.parse({ name: 'Saved', hostname: 'saved.test', username: 'operator' }),
    id: crypto.randomUUID(),
    version: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const model = {
    getSnapshot: () =>
      ({ status: 'ready', baseline: baseline(generation, [host]) }) as CatalogState,
  };
  const connections = {
    openSsh: vi.fn(async (..._args: unknown[]) => 'ssh'),
    openHistory: vi.fn(),
  };
  const terminals = { open: vi.fn(async (..._args: unknown[]) => 'local'), activate: vi.fn() };
  const editor = { openQuickConnect: vi.fn(() => crypto.randomUUID()) };
  const actions = new NewSessionActions(model, connections, terminals, editor);
  return {
    actions,
    host,
    connections,
    terminals,
    editor,
    changeGeneration: () => {
      generation = crypto.randomUUID();
    },
  };
}
it('admits transient SSH through its owner without saving a Host or exposing secrets in arrangement state', async () => {
  const f = fixture();
  const observed: unknown[] = [];
  f.actions.subscribe(() => observed.push(f.actions.getSnapshot()));
  const target = parseQuickConnect('ssh://operator:' + secret + '@new.test:2222')!;
  await f.actions.launch(target);
  expect(f.connections.openSsh).toHaveBeenCalledWith(
    expect.objectContaining({
      target: expect.objectContaining({ hostname: 'new.test', port: 2222, authType: 'password' }),
      temporarySecret: secret,
    }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(JSON.stringify(observed)).not.toContain(secret);
  expect(f.terminals.open).not.toHaveBeenCalled();
  await f.actions.close();
});
it('reuses the captured saved Host identity and selected terminal Profile for a matching target', async () => {
  const f = fixture();
  const id = crypto.randomUUID();
  await f.actions.launch(parseQuickConnect('ssh://operator@saved.test')!, id);
  expect(f.connections.openSsh).toHaveBeenCalledWith(
    { hostId: f.host.id },
    expect.objectContaining({ terminal: { profileId: id } }),
  );
  await f.actions.close();
});
it('uses transient private-key grant ownership and never treats a grant as a credential reference', async () => {
  const f = fixture();
  const target = parseQuickConnect('ssh://operator@new.test')!;
  if (target.protocol !== 'ssh') throw new Error('Unexpected parser output');
  target.credentialGrantId = 'selected-file';
  await f.actions.launch(target);
  expect(f.connections.openSsh).toHaveBeenCalledWith(
    expect.objectContaining({
      temporaryCredentialGrantId: 'selected-file',
      target: expect.objectContaining({ authType: 'privateKey' }),
    }),
    expect.anything(),
  );
  expect(JSON.stringify(f.connections.openSsh.mock.calls)).not.toContain('credentialRef');
  await f.actions.close();
});
it('routes local and seven other protocol targets without fabricating saved Bookmark facts', async () => {
  const f = fixture();
  await f.actions.launch({ protocol: 'local' });
  expect(f.terminals.open).toHaveBeenCalledWith(
    { kind: 'local', cols: 160, rows: 80 },
    expect.any(AbortSignal),
  );
  for (const input of [
    'ftp://user@host.test',
    'telnet://user@host.test',
    'rdp://user@host.test',
    'vnc://host.test',
    'spice://host.test',
    'https://example.test/path',
    'serial://COM4',
  ]) {
    const target = parseQuickConnect(input)!;
    await f.actions.launch(target);
    expect(f.editor.openQuickConnect).toHaveBeenLastCalledWith(target);
  }
  expect(f.connections.openSsh).not.toHaveBeenCalled();
  await f.actions.close();
});
it('does not silently start a different workflow for specialized Files/automation intents', async () => {
  const f = fixture();
  const target = parseQuickConnect('ssh://new.test') as Extract<
    QuickConnectTarget,
    { protocol: 'ssh' }
  >;
  expect(await f.actions.launch({ ...target, enableSsh: false, enableSftp: false })).toBe(false);
  expect(await f.actions.launch({ protocol: 'local', batchOperationGrantId: 'batch' })).toBe(false);
  expect(f.connections.openSsh).not.toHaveBeenCalled();
  expect(f.terminals.open).not.toHaveBeenCalled();
  await f.actions.close();
});
it('retires queued launches on generation replacement and never replays failed network admissions', async () => {
  const f = fixture();
  const pending = f.actions.launch(parseQuickConnect('ssh://new.test')!);
  f.changeGeneration();
  expect(await pending).toBe(false);
  expect(f.connections.openSsh).not.toHaveBeenCalled();
  f.connections.openSsh.mockRejectedValueOnce(new Error('lost ACK'));
  expect(await f.actions.launch(parseQuickConnect('ssh://new.test')!)).toBe(false);
  expect(f.connections.openSsh).toHaveBeenCalledTimes(1);
  await f.actions.close();
});
it('cancels and joins actual admitted workspace work on unload', async () => {
  const f = fixture();
  let finish!: () => void;
  f.terminals.open.mockImplementationOnce(
    async (...args: unknown[]) =>
      new Promise((resolve) => {
        const signal = args[1] as AbortSignal;
        signal.addEventListener('abort', () => {
          finish = () => resolve('drained');
        });
      }),
  );
  const pending = f.actions.launch({ protocol: 'local' });
  await Promise.resolve();
  const close = f.actions.close();
  expect(await f.actions.launch({ protocol: 'local' })).toBe(false);
  finish();
  await pending;
  await close;
});
it('matches configured shortcut chords, explicit disabling and custom ownership of default chords', () => {
  const event = {
    code: 'KeyN',
    key: 'n',
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  };
  expect(matchesSessionShortcut(event, 'app_toggleAddBtn', { bindings: {} }, false)).toBe(true);
  expect(
    matchesSessionShortcut(
      event,
      'app_toggleAddBtn',
      { bindings: { app_toggleAddBtn: [] } },
      false,
    ),
  ).toBe(false);
  expect(
    matchesSessionShortcut(
      event,
      'app_toggleAddBtn',
      { bindings: { app_reloadAll: ['alt+n'] } },
      false,
    ),
  ).toBe(false);
  expect(
    matchesSessionShortcut(
      { ...event, code: 'KeyK', key: 'k' },
      'app_toggleAddBtn',
      { bindings: { app_toggleAddBtn: ['alt+k'] } },
      false,
    ),
  ).toBe(true);
  expect(
    matchesSessionShortcut(
      { ...event, altKey: false, metaKey: true },
      'app_newBookmark',
      { bindings: {} },
      true,
    ),
  ).toBe(true);
});

it('holds protocol prefill privately and discards it when its editor closes', async () => {
  const model = {
    getSnapshot: () =>
      ({
        status: 'ready',
        baseline: baseline(crypto.randomUUID(), []),
      }) as CatalogState,
  };
  const owner = new CatalogEditorOwner(
    { catalog: model } as unknown as CatalogEditorServices,
    {} as SavedCredentialActions,
  );
  const target = parseQuickConnect('telnet://operator:' + secret + '@target.test:2323')!;
  if (target.protocol !== 'telnet') throw new Error('Unexpected target');
  const admitted = owner.openQuickConnect(target);
  const selected = owner.getSnapshot().session!;
  expect(admitted).toBe(selected.id);
  expect(owner.openQuickConnect({ ...target, hostname: 'other.test' })).toBeUndefined();
  expect(owner.getSnapshot().session?.id).toBe(selected.id);
  expect(owner.initialTarget(selected.id)).toEqual(target);
  expect(JSON.stringify(owner.getSnapshot())).not.toContain(secret);
  await owner.close();
  expect(owner.initialTarget(selected.id)).toBeUndefined();
  await owner.dispose();
});
it('reports schema rejection before IO instead of throwing a secret-bearing input at the menu', async () => {
  const f = fixture();
  const target = parseQuickConnect('ssh://' + 'u'.repeat(200) + '@new.test')!;
  expect(await f.actions.launch(target)).toBe(false);
  expect(f.connections.openSsh).not.toHaveBeenCalled();
  await f.actions.close();
});

it('routes Files-only SSH to its owner with the captured title and initial local directory authority', async () => {
  const f = fixture();
  const revoke = vi.fn(async () => {});
  f.actions.attachFileGrants({
    create: vi.fn(),
    importFile: vi.fn(),
    revoke,
    revokeInGeneration: revoke,
  });
  const target = parseQuickConnect('ssh://new.test') as Extract<
    QuickConnectTarget,
    { protocol: 'ssh' }
  >;
  expect(
    await f.actions.launch({
      ...target,
      enableSsh: false,
      enableSftp: true,
      title: 'Files target',
      initialDirectoryGrantId: 'owned-directory',
    }),
  ).toBe(true);
  expect(f.connections.openSsh).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      filesOnly: { title: 'Files target', initialDirectoryGrantId: 'owned-directory' },
    }),
  );
  expect(f.terminals.open).not.toHaveBeenCalled();
  expect(revoke).not.toHaveBeenCalled();
  await f.actions.close();
  expect(revoke).not.toHaveBeenCalled();
});

it('forwards captured local and SSH titles only as workspace presentation', async () => {
  const f = fixture();
  expect(await f.actions.launch({ protocol: 'local', title: 'Local title' })).toBe(true);
  expect(f.terminals.open).toHaveBeenCalledExactlyOnceWith(
    { kind: 'local', cols: 160, rows: 80 },
    expect.any(AbortSignal),
    { title: 'Local title' },
  );
  const target = parseQuickConnect('ssh://new.test?title=SSH%20title')!;
  expect(await f.actions.launch(target)).toBe(true);
  expect(f.connections.openSsh).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ terminal: { title: 'SSH title' } }),
  );
  await f.actions.close();
});

it('releases the local launch directory only after terminal admission settles, without changing cwd authority', async () => {
  const f = fixture(),
    id = crypto.randomUUID();
  const admitted = Promise.withResolvers<string>(),
    released = Promise.withResolvers<void>();
  f.terminals.open.mockImplementationOnce(() => admitted.promise);
  const revoke = vi.fn(() => released.promise);
  f.actions.attachFileGrants({
    create: vi.fn(),
    importFile: vi.fn(),
    revoke,
    revokeInGeneration: revoke,
  });
  const launch = f.actions.launch({ protocol: 'local', initialDirectoryGrantId: id });
  await vi.waitFor(() => expect(f.terminals.open).toHaveBeenCalledOnce());
  expect(f.terminals.open.mock.calls[0]![0]).toMatchObject({
    workingDirectory: { scope: 'local', grantId: id, path: '' },
  });
  expect(revoke).not.toHaveBeenCalled();
  admitted.resolve('local');
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledExactlyOnceWith(id, expect.any(String)));
  let done = false;
  void launch.then(() => {
    done = true;
  });
  expect(done).toBe(false);
  released.resolve();
  expect(await launch).toBe(true);
  await f.actions.close();
});
it('retains uncertain local directory cleanup for explicit retry, without starting another terminal', async () => {
  const f = fixture(),
    id = crypto.randomUUID();
  const revoke = vi.fn(async (): Promise<void> => {
    throw Error('lost revoke response');
  });
  f.actions.attachFileGrants({
    create: vi.fn(),
    importFile: vi.fn(),
    revoke,
    revokeInGeneration: revoke,
  });
  expect(await f.actions.launch({ protocol: 'local', initialDirectoryGrantId: id })).toBe(false);
  expect(f.actions.getSnapshot()).toMatchObject({ failed: true, cleanupPending: true });
  expect(await f.actions.launch({ protocol: 'local' })).toBe(false);
  expect(f.terminals.open).toHaveBeenCalledTimes(1);
  revoke.mockResolvedValue(undefined);
  await f.actions.retryCleanup();
  expect(revoke).toHaveBeenCalledTimes(2);
  expect(f.actions.getSnapshot().cleanupPending).toBe(false);
  expect(f.terminals.open).toHaveBeenCalledTimes(1);
  await f.actions.close();
});
it('retains directory cleanup on generation replacement without revoking through the replacement Host', async () => {
  const f = fixture(),
    id = crypto.randomUUID();
  const admitted = Promise.withResolvers<string>();
  f.terminals.open.mockImplementationOnce(() => admitted.promise);
  const revoke = vi.fn(async () => {});
  f.actions.attachFileGrants({
    create: vi.fn(),
    importFile: vi.fn(),
    revoke,
    revokeInGeneration: revoke,
  });
  const launch = f.actions.launch({ protocol: 'local', initialDirectoryGrantId: id });
  await vi.waitFor(() => expect(f.terminals.open).toHaveBeenCalledOnce());
  f.changeGeneration();
  admitted.resolve('retired');
  expect(await launch).toBe(false);
  expect(revoke).not.toHaveBeenCalled();
  expect(f.actions.getSnapshot().cleanupPending).toBe(true);
  await expect(f.actions.close()).rejects.toThrow('UNDRAINED');
});
it('rejects local directory launch without its Files owner before terminal IO', async () => {
  const f = fixture();
  expect(
    await f.actions.launch({ protocol: 'local', initialDirectoryGrantId: 'missing-owner' }),
  ).toBe(false);
  expect(f.terminals.open).not.toHaveBeenCalled();
  await f.actions.close();
});

it('hands a combined SSH/Files initial directory to Files after success, and releases it if the second view fails', async () => {
  const f = fixture(),
    id = crypto.randomUUID();
  const revoke = vi.fn(async () => {});
  f.actions.attachFileGrants({
    create: vi.fn(),
    importFile: vi.fn(),
    revoke,
    revokeInGeneration: revoke,
  });
  const target = parseQuickConnect('ssh://new.test?title=Combined') as Extract<
    QuickConnectTarget,
    { protocol: 'ssh' }
  >;
  expect(await f.actions.launch({ ...target, initialDirectoryGrantId: id })).toBe(true);
  expect(f.connections.openSsh).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      filesAfterTerminal: { title: 'Combined', initialDirectoryGrantId: id },
      terminal: { title: 'Combined' },
    }),
  );
  expect(revoke).not.toHaveBeenCalled();
  f.connections.openSsh.mockRejectedValueOnce(Error('Files view failed after terminal acceptance'));
  expect(await f.actions.launch({ ...target, initialDirectoryGrantId: id })).toBe(false);
  expect(revoke).toHaveBeenCalledExactlyOnceWith(id, expect.any(String));
  await f.actions.close();
});
it('hands advanced Quick Connect hopping and inline forwarding to Connections without writing temporary Hosts', async () => {
  const f = fixture();
  const target = parseQuickConnect(
    'ssh://operator:TARGET_TRANSIENT@new.test?opts=' +
      encodeURIComponent(
        JSON.stringify({
          connectionHoppings: [
            { host: 'jump.test', username: 'hop-user', password: 'HOP_TRANSIENT' },
          ],
          sshTunnels: [{ sshTunnel: 'dynamicForward', sshTunnelLocalPort: 1080 }],
        }),
      ),
  )!;
  expect(await f.actions.launch(target)).toBe(true);
  expect(f.connections.openSsh).toHaveBeenCalledWith(
    expect.objectContaining({
      hops: [
        {
          target: expect.objectContaining({
            hostname: 'jump.test',
            port: 22,
            username: 'hop-user',
            authType: 'password',
          }),
          temporarySecret: 'HOP_TRANSIENT',
        },
      ],
    }),
    expect.objectContaining({
      tunnels: [
        expect.objectContaining({ type: 'dynamic', bindPort: 1080, allowNonLoopback: false }),
      ],
    }),
  );
  expect(JSON.stringify(f.actions.getSnapshot())).not.toContain('TRANSIENT');
  await f.actions.close();
});
it('waits for the selected Automation owner on cold batch launch and transfers grant ownership only after synchronous admission', async () => {
  const f = fixture(),
    revoke = vi.fn(async () => {}),
    grant = crypto.randomUUID(),
    done = Promise.withResolvers<void>();
  f.actions.attachFileGrants({
    create: vi.fn(),
    importFile: vi.fn(),
    revoke,
    revokeInGeneration: revoke,
  });
  const opening = f.actions.launch({ protocol: 'local', batchOperationGrantId: grant });
  await Promise.resolve();
  expect(f.terminals.open).not.toHaveBeenCalled();
  const runBatchGrant = vi.fn(() => done.promise);
  f.actions.attachAutomation({ open: vi.fn(), runBatchGrant });
  await vi.waitFor(() =>
    expect(runBatchGrant).toHaveBeenCalledWith(grant, expect.any(String), expect.any(AbortSignal)),
  );
  done.reject(Error('accepted owner failed; it retains cleanup responsibility'));
  expect(await opening).toBe(false);
  expect(revoke).not.toHaveBeenCalled();
  await f.actions.close();
});
it('releases an unclaimed batch grant when waiting for its UI owner is canceled', async () => {
  const f = fixture(),
    revoke = vi.fn(async () => {}),
    grant = crypto.randomUUID(),
    abort = new AbortController();
  f.actions.attachFileGrants({
    create: vi.fn(),
    importFile: vi.fn(),
    revoke,
    revokeInGeneration: revoke,
  });
  const opening = f.actions.launch(
    { protocol: 'local', batchOperationGrantId: grant },
    undefined,
    abort.signal,
  );
  await Promise.resolve();
  abort.abort();
  expect(await opening).toBe(false);
  expect(revoke).toHaveBeenCalledWith(grant, expect.any(String));
  await f.actions.close();
});
