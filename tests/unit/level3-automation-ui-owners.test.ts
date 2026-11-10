import { randomUUID } from 'node:crypto';
import { expect, it, vi, afterEach } from 'vitest';
import type {
  AutomationBaseline,
  QuickCommandGroupInput,
  CreateBatchOperationInput,
} from '@axterm/plugin-api/automation';
import { terminalSessionSchema, type TerminalSessionsView } from '@axterm/plugin-api/terminals';
import type { FileGrantActions } from '@axterm/plugin-api/files';
import { AutomationUiCommands } from '../../packages/plugins/automation/src/client/ui/commands.ts';
import { QuickCommandRunner } from '../../packages/plugins/automation/src/client/ui/quick-run.ts';
import type {
  AutomationModel,
  AutomationState,
} from '../../packages/plugins/automation/src/client/index.ts';
import { WorkspaceStore } from '../../packages/plugins/workspace/src/client/store.ts';
afterEach(() => vi.useRealTimers());
function factsFixture() {
  const generation = randomUUID(),
    baseline: AutomationBaseline = {
      generation,
      cursor: 0,
      quickCommands: { revision: 1, etag: '"quick-command-tree-v1"', groups: [], commands: [] },
      triggers: { revision: 1, etag: '"trigger-list-v1"', triggers: [] },
      batches: [],
    };
  let state: AutomationState = { status: 'ready', baseline };
  const listeners = new Set<() => void>();
  const model = {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    createQuickCommandGroup: vi.fn(
      async (_key: string, _input: QuickCommandGroupInput, _etag: string | undefined) => ({
        ids: [],
        cursor: 0,
      }),
    ),
    createBatchOperation: vi.fn(async (_key: string, _input: CreateBatchOperationInput) => ({
      ids: [],
      cursor: 0,
    })),
  };
  const files: FileGrantActions = {
      create: vi.fn(),
      importFile: vi.fn(),
      revoke: vi.fn(),
      readInGeneration: vi.fn(),
      revokeInGeneration: vi.fn(async () => {}),
    },
    workspace = new WorkspaceStore(),
    owner = new AutomationUiCommands(model as unknown as AutomationModel, workspace, files);
  workspace.registerNavigation({
    id: 'commands',
    label: { en: 'Commands' },
    icon: null,
    view: 'section',
  });
  const publish = (value: AutomationState) => {
    state = value;
    for (const listener of listeners) listener();
  };
  return { generation, baseline, model, owner, files, workspace, publish, listeners };
}
it('retains an immutable fact key/input/etag for explicit retry and never repeats a prior intent after generation replacement', async () => {
  const f = factsFixture(),
    input = { parentId: null, name: 'Original' };
  f.model.createQuickCommandGroup.mockRejectedValueOnce(Error('response lost'));
  const task = f.owner.createQuickCommandGroup(f.baseline.quickCommands, input);
  input.name = 'Changed';
  await expect(task).rejects.toThrow();
  expect(f.owner.getSnapshot().uncertain).toBe(true);
  const [key, value, etag] = f.model.createQuickCommandGroup.mock.calls[0]!;
  expect(value).toEqual({ parentId: null, name: 'Original' });
  expect(etag).toBe(f.baseline.quickCommands.etag);
  await f.owner.retry();
  expect(f.model.createQuickCommandGroup.mock.calls[1]).toEqual([key, value, etag]);
  f.model.createQuickCommandGroup.mockRejectedValueOnce(Error('lost again'));
  await expect(f.owner.createQuickCommandGroup(f.baseline.quickCommands, input)).rejects.toThrow();
  f.publish({ status: 'ready', baseline: { ...f.baseline, generation: randomUUID() } });
  expect(() => f.owner.retry()).toThrow('GENERATION_RETIRED');
  expect(f.model.createQuickCommandGroup).toHaveBeenCalledTimes(3);
  await f.owner.close();
  await f.workspace.dispose();
});
it('joins a canceled cold batch-file admission and retains failed exact-generation grant cleanup for retry', async () => {
  const f = factsFixture(),
    abort = new AbortController(),
    grant = randomUUID();
  f.publish({ status: 'connecting' });
  vi.mocked(f.files.revokeInGeneration!).mockRejectedValueOnce(Error('revocation unknown'));
  const task = f.owner.runBatchGrant(grant, f.generation, abort.signal);
  await Promise.resolve();
  abort.abort();
  await expect(task).rejects.toThrow();
  expect(f.model.createBatchOperation).not.toHaveBeenCalled();
  expect(f.owner.getSnapshot().cleanup).toBe(true);
  await f.owner.retryCleanup();
  expect(f.files.revokeInGeneration).toHaveBeenLastCalledWith(grant, f.generation);
  expect(f.listeners.size).toBe(0);
  await f.owner.close();
  await f.workspace.dispose();
});
it('releases batch-file authority before the single command submission and never re-reads it for an uncertain result', async () => {
  const f = factsFixture(),
    grant = randomUUID(),
    request = {
      name: 'Batch',
      bookmarkIds: [randomUUID()],
      steps: [
        {
          id: randomUUID(),
          name: 'One',
          command: 'printf BATCH',
          delayMs: 0,
          continueOnError: false,
        },
      ],
      concurrency: 1,
      connectionTimeoutMs: 1000,
    };
  vi.mocked(f.files.readInGeneration!).mockResolvedValue({
    name: 'batch.json',
    content: '\uFEFF' + JSON.stringify(request),
  });
  f.model.createBatchOperation.mockImplementation(async () => {
    expect(f.files.revokeInGeneration).toHaveBeenCalledWith(grant, f.generation);
    throw Error('lost batch receipt');
  });
  await expect(f.owner.runBatchGrant(grant, f.generation)).rejects.toThrow();
  await expect(f.owner.retry()).rejects.toThrow();
  expect(f.files.readInGeneration).toHaveBeenCalledOnce();
  expect(f.model.createBatchOperation.mock.calls[0]).toEqual(
    f.model.createBatchOperation.mock.calls[1],
  );
  await f.owner.close();
  await f.workspace.dispose();
});
function runnerFixture(clipboard = async () => 'CLIP') {
  const id = randomUUID(),
    generation = randomUUID(),
    listeners = new Set<() => void>(),
    workspace = new WorkspaceStore();
  workspace.registerTab({ id, kind: 'terminal', title: 'Terminal' }, async () => {}).activate();
  let state: ReturnType<TerminalSessionsView['getSnapshot']> = {
    status: 'ready',
    baseline: {
      type: 'baseline',
      generation,
      revision: 0,
      sessions: [
        terminalSessionSchema.parse({
          id,
          kind: 'local',
          title: 'Terminal',
          state: 'ready',
          createdAt: new Date().toISOString(),
        }),
      ],
    },
  };
  const sessions: TerminalSessionsView = {
      getSnapshot: () => state,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      retry: async () => {},
    },
    input = { sendInput: vi.fn(async () => {}) },
    drafts = { insertDraft: vi.fn(async () => {}) },
    runner = new QuickCommandRunner(sessions, workspace, input, drafts, clipboard);
  return {
    id,
    runner,
    workspace,
    input,
    drafts,
    listeners,
    retire: () => {
      state = {
        status: 'ready',
        baseline: { type: 'baseline', generation: randomUUID(), revision: 0, sessions: [] },
      };
      for (const listener of listeners) listener();
    },
  };
}
it('sends only to the captured live terminal and cancels remaining steps when the target changes', async () => {
  vi.useFakeTimers();
  const f = runnerFixture(),
    task = f.runner.run(f.id, {
      inputOnly: false,
      steps: [
        { command: 'FIRST', delayMs: 1 },
        { command: 'SECOND', delayMs: 100 },
      ],
    });
  const rejected = expect(task).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.input.sendInput).toHaveBeenCalledWith(f.id, 'FIRST\r', expect.any(AbortSignal));
  f.workspace
    .registerTab({ id: randomUUID(), kind: 'terminal', title: 'Other' }, async () => {})
    .activate();
  await rejected;
  await vi.advanceTimersByTimeAsync(200);
  expect(f.input.sendInput).toHaveBeenCalledOnce();
  await f.runner.close();
  await f.workspace.dispose();
  expect(f.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
it('joins late clipboard expansion on withdrawal and never executes it in a replacement generation', async () => {
  const clipboard = Promise.withResolvers<string>(),
    f = runnerFixture(() => clipboard.promise),
    task = f.runner.run(f.id, {
      inputOnly: false,
      steps: [{ command: '{{clipboard}}', delayMs: 1 }],
    });
  const rejected = expect(task).rejects.toThrow();
  f.retire();
  let stopped = false;
  const close = f.runner.close().then(() => {
    stopped = true;
  });
  expect(stopped).toBe(false);
  clipboard.resolve('DO_NOT_SEND');
  await rejected;
  await close;
  expect(f.input.sendInput).not.toHaveBeenCalled();
  await f.workspace.dispose();
});
it('inserts expanded command text through the selected draft owner without sending Enter', async () => {
  const f = runnerFixture();
  await f.runner.insert(f.id, {
    inputOnly: false,
    steps: [{ command: 'echo {{clipboard}}', delayMs: 1 }],
  });
  expect(f.input.sendInput).not.toHaveBeenCalled();
  expect(f.drafts.insertDraft).toHaveBeenCalledWith(f.id, 'echo CLIP', expect.any(AbortSignal));
  await f.runner.close();
  await f.workspace.dispose();
});

it('reports only localized batch-file validation codes, releases authority and admits no invalid document', async () => {
  for (const [content, key] of [
    ['{', 'batchCli.invalidJson'],
    [JSON.stringify({ name: 'Foreign prototype', commands: ['whoami'] }), 'batchCli.invalidFormat'],
    ['x'.repeat(2 * 1024 * 1024 + 1), 'batchCli.fileTooLarge'],
  ] as const) {
    const f = factsFixture(),
      grant = randomUUID();
    vi.mocked(f.files.readInGeneration!).mockResolvedValue({ name: 'batch.json', content });
    await expect(f.owner.runBatchGrant(grant, f.generation)).rejects.toMatchObject({ key });
    expect(f.files.readInGeneration).toHaveBeenCalledWith(
      grant,
      2 * 1024 * 1024,
      f.generation,
      expect.any(AbortSignal),
    );
    expect(f.files.revokeInGeneration).toHaveBeenCalledExactlyOnceWith(grant, f.generation);
    expect(f.model.createBatchOperation).not.toHaveBeenCalled();
    expect(f.owner.getSnapshot()).toMatchObject({
      fileError: key,
      uncertain: false,
      cleanup: false,
    });
    f.owner.dismissNotice();
    expect(f.owner.getSnapshot().fileError).toBeUndefined();
    await f.owner.close();
    await f.workspace.dispose();
  }
});
