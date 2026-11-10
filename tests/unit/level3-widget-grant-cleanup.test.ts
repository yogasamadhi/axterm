import { expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { FileGrantActions } from '@axterm/plugin-api/files';
import type { WidgetModel } from '../../packages/plugins/automation/src/client/widgets.ts';
import { WidgetUiActions } from '../../packages/plugins/automation/src/client/ui/widget-actions.ts';
function fixture() {
  let generation = 'original';
  const grant = {
    grantId: 'widget-directory',
    kind: 'directory' as const,
    name: 'Fixture',
    permissions: ['read' as const],
    createdAt: new Date().toISOString(),
  };
  const files = {
    createInGeneration: vi.fn(async () => grant),
    revokeInGeneration: vi.fn(async () => {}),
  } as unknown as FileGrantActions;
  const model = { generation: () => generation } as WidgetModel;
  const actions = new WidgetUiActions({ fileGrantActions: files } as Context, model);
  return {
    files,
    actions,
    grant,
    replace: () => {
      generation = 'replacement';
    },
  };
}
it('retains failed widget revocation for actual retry and never reports an early drain', async () => {
  const f = fixture();
  await f.actions.createFileGrant('open-directory');
  vi.mocked(f.files.revokeInGeneration!).mockRejectedValueOnce(Error('UNCERTAIN'));
  await expect(f.actions.close()).rejects.toThrow('UNDRAINED');
  await f.actions.close();
  expect(f.files.revokeInGeneration).toHaveBeenCalledTimes(2);
  expect(f.files.revokeInGeneration).toHaveBeenLastCalledWith(f.grant.grantId, 'original');
});
it('keeps a late old-generation widget grant and refuses replacement Host cleanup', async () => {
  const f = fixture(),
    selected = Promise.withResolvers<typeof f.grant>();
  vi.mocked(f.files.createInGeneration!).mockReturnValue(selected.promise);
  const pending = f.actions.createFileGrant('open-directory');
  f.replace();
  selected.resolve(f.grant);
  await expect(pending).rejects.toThrow('GENERATION_CHANGED');
  await expect(f.actions.close()).rejects.toThrow('UNDRAINED');
  expect(f.files.revokeInGeneration).not.toHaveBeenCalled();
});
