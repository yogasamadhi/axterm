import { ContextReviewOwner } from '../../packages/plugins/ai/src/client/ui/context-review-owner.ts';
import type { AiContextPreview, AiContextPreviewInput, AiRun } from '@axterm/plugin-api/ai';
import { expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { AttachmentDraftOwner } from '../../packages/plugins/ai/src/client/ui/attachment-draft-owner.ts';
import { TerminalDraftOwner } from '../../packages/plugins/terminals/src/client/draft-owner.ts';
import type { AiAttachmentPreview } from '@axterm/plugin-api/ai';
const preview = (id = 'preview', size = 4) =>
  ({
    id,
    name: 'file.txt',
    size,
    includedBytes: size,
    preview: 'safe',
    redacted: false,
    truncated: false,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  }) satisfies AiAttachmentPreview;
it('retires a composer only after a canceled late preparation actually returns and its authority drains', async () => {
  const discards = vi.fn(async () => {}),
    retired = vi.fn();
  const owner = new AttachmentDraftOwner({ discardAiAttachment: discards }, retired);
  const operation = owner.begin()!;
  const close = owner.dispose();
  let closed = false;
  void close.then(() => {
    closed = true;
  });
  expect(owner.dispose()).toBe(close);
  expect(operation.signal.aborted).toBe(true);
  await setImmediate();
  expect(closed).toBe(false);
  expect(await owner.admit(operation, preview())).toBe('stale');
  expect(owner.finish(operation)).toBe(false);
  await close;
  expect(discards).toHaveBeenCalledExactlyOnceWith('preview');
  expect(retired).toHaveBeenCalledOnce();
  expect(owner.resourceCount()).toBe(0);
});
it('keeps a failed release owned, preserves immutable accepted facts and repeats the same close failure', async () => {
  const owner = new AttachmentDraftOwner({
    discardAiAttachment: async () => {
      throw new Error('controlled');
    },
  });
  const operation = owner.begin()!;
  await owner.admit(operation, preview());
  owner.finish(operation);
  const state = owner.getSnapshot();
  expect(Object.isFrozen(state)).toBe(true);
  expect(Object.isFrozen(state[0])).toBe(true);
  await expect(owner.remove('preview')).rejects.toThrow('controlled');
  expect(owner.getSnapshot()).toBe(state);
  const close = owner.dispose();
  await expect(close).rejects.toThrow('RELEASE_FAILED');
  const retry = owner.dispose();
  expect(retry).not.toBe(close);
  await expect(retry).rejects.toThrow('RELEASE_FAILED');
  expect(owner.resourceCount()).toBeGreaterThan(0);
});
it('does not insert after canceled readiness and rejects controls or unprotected newlines before sending bytes', async () => {
  const activate = vi.fn(),
    paste = vi.fn(() => true),
    focus = vi.fn();
  const owner = new TerminalDraftOwner(activate);
  const abort = new AbortController();
  const task = owner.insertDraft('terminal', 'echo safe', abort.signal);
  const failed = expect(task).rejects.toThrow('UNAVAILABLE');
  await setImmediate();
  abort.abort();
  await failed;
  const unregister = owner.register('terminal', () => ({ bracketedPaste: false, paste, focus }));
  await expect(owner.insertDraft('terminal', 'echo first\necho second')).rejects.toThrow('UNSAFE');
  expect(() => owner.insertDraft('terminal', '\u001b[200~evil')).toThrow('UNSAFE');
  expect(paste).not.toHaveBeenCalled();
  await owner.insertDraft('terminal', 'echo safe');
  expect(paste).toHaveBeenCalledExactlyOnceWith('echo safe');
  expect(focus).toHaveBeenCalledOnce();
  unregister();
  await owner.dispose();
  expect(owner.resourceCount()).toBe(0);
});
it('waits for a live sink and reports actual queue rejection instead of successful insertion', async () => {
  const owner = new TerminalDraftOwner(() => {});
  const paste = vi.fn(() => false);
  const task = owner.insertDraft('terminal', 'echo safe');
  const failed = expect(task).rejects.toThrow('UNAVAILABLE');
  await setImmediate();
  const unregister = owner.register('terminal', () => ({
    bracketedPaste: true,
    paste,
    focus: () => {
      throw new Error('must not focus');
    },
  }));
  await failed;
  expect(paste).toHaveBeenCalledOnce();
  unregister();
  await owner.dispose();
  expect(owner.resourceCount()).toBe(0);
});

it('joins late accepted Run identity and cancels it once without publishing a disposed review', async () => {
  const accepted = Promise.withResolvers<AiRun>(),
    retired = vi.fn(),
    cancel = vi.fn(async () => {});
  const owner = new ContextReviewOwner(
    {
      previewAiContext: async () => {
        throw new Error('unused');
      },
      startAi: () => accepted.promise,
      cancelAi: cancel,
    },
    retired,
  );
  const request = { prompt: 'safe', modelId: 'model', useCase: 'chat' } as AiContextPreviewInput;
  const task = owner.sendDirect(
    async () => request,
    async () => {
      throw new Error('must not commit UI');
    },
  );
  await setImmediate();
  const close = owner.dispose();
  let closed = false;
  void close.then(() => {
    closed = true;
  });
  await setImmediate();
  expect(closed).toBe(false);
  expect(owner.dispose()).toBe(close);
  accepted.resolve({ id: 'late-run' } as AiRun);
  await task;
  await close;
  expect(cancel).toHaveBeenCalledExactlyOnceWith('late-run');
  expect(retired).toHaveBeenCalledOnce();
  expect(owner.resourceCount()).toBe(0);
  expect(owner.getSnapshot().preview).toBeUndefined();
});
it('owns frozen review facts and retains a failed late Run cancellation as a close failure', async () => {
  const accepted = Promise.withResolvers<AiRun>();
  const request = { prompt: 'safe', modelId: 'model', useCase: 'chat' } as AiContextPreviewInput;
  const reviewed = {
    request,
    reviewReceipt: 'receipt',
    reviewExpiresAt: new Date(Date.now() + 60000).toISOString(),
  } as AiContextPreview;
  const owner = new ContextReviewOwner({
    previewAiContext: async () => reviewed,
    startAi: () => accepted.promise,
    cancelAi: async () => {
      throw new Error('controlled');
    },
  });
  await owner.prepare(async () => request);
  expect(Object.isFrozen(owner.getSnapshot().preview?.request)).toBe(true);
  const task = owner.send(async () => {
    throw new Error('must not publish');
  });
  await setImmediate();
  const close = owner.dispose();
  const failed = expect(close).rejects.toThrow('CANCELLATION_FAILED');
  accepted.resolve({ id: 'late-run' } as AiRun);
  await task;
  await failed;
  expect(owner.resourceCount()).toBe(1);
  expect(owner.dispose()).toBe(close);
});
