import { expect, it, vi } from 'vitest';
import { DEFAULT_TERMINAL_BACKGROUND } from '@axterm/plugin-api/terminals';
import { workspacePresentationSchema } from '@axterm/plugin-api/configuration';
import { TerminalVisualOwner } from '../../packages/plugins/terminals/src/client/visuals/owner.ts';
import { WorkspaceStore } from '../../packages/plugins/workspace/src/client/store.ts';
const visual = (text: string) => ({
  themeId: '00000000-0000-4000-8000-000000000001',
  background: { ...DEFAULT_TERMINAL_BACKGROUND, kind: 'text' as const, text },
});
it('keeps scoped preview handles from clearing another preview or writing accepted appearance', async () => {
  const store = new WorkspaceStore(),
    owner = new TerminalVisualOwner(),
    close = vi.fn(async () => {});
  const registration = store.registerTab(
    { id: 'terminal', kind: 'terminal', title: 'Local' },
    close,
  );
  owner.register('terminal', registration);
  const input = visual('accepted');
  owner.apply('terminal', input);
  input.background.text = 'mutated';
  expect(store.getSnapshot().tabs[0]?.terminalVisual?.background.text).toBe('accepted');
  const first = owner.preview('terminal', visual('first'));
  const second = owner.preview('terminal', visual('second'));
  first();
  first();
  expect(owner.getSnapshot().previews.terminal?.background.text).toBe('second');
  expect(store.getSnapshot().tabs[0]?.terminalVisual?.background.text).toBe('accepted');
  expect(Object.isFrozen(owner.getSnapshot().previews.terminal?.background)).toBe(true);
  second();
  expect(owner.getSnapshot().previews).toEqual({});
  expect(close).not.toHaveBeenCalled();
  owner.dispose();
  await store.dispose();
});
it('retires previews on registration replacement and bounds registrations/preview memory', async () => {
  const store = new WorkspaceStore(),
    owner = new TerminalVisualOwner();
  let registration = store.registerTab(
    { id: 'one', kind: 'terminal', title: 'One' },
    async () => {},
  );
  const retire = owner.register('one', registration),
    stale = owner.preview('one', visual('old'));
  retire();
  registration.dispose();
  registration = store.registerTab({ id: 'one', kind: 'terminal', title: 'New' }, async () => {});
  owner.register('one', registration);
  owner.preview('one', visual('new'));
  stale();
  retire();
  expect(owner.getSnapshot().previews.one?.background.text).toBe('new');
  expect(() => owner.preview('missing', visual('bad'))).toThrow('UNAVAILABLE');
  for (let i = 0; i < 127; i++) owner.preview('one', visual('bounded'));
  expect(() => owner.preview('one', visual('excess'))).toThrow('UNAVAILABLE');
  owner.dispose();
  expect(() => owner.apply('one', visual('closed'))).toThrow('CLOSED');
  await store.dispose();
});
it('restores pure appearance per window without reopening terminals and preserves local edits over late baselines', async () => {
  const first = new WorkspaceStore(),
    second = new WorkspaceStore(),
    close = vi.fn(async () => {});
  const registration = first.registerTab({ id: 'one', kind: 'terminal', title: 'One' }, close);
  registration.present!({ terminalVisual: visual('window one') });
  const saved = workspacePresentationSchema.parse(first.getPresentation());
  second.restorePresentation(saved);
  expect(second.getSnapshot().tabs).toEqual([]);
  const restored = second.registerTab({ id: 'one', kind: 'terminal', title: 'One' }, close);
  expect(second.getSnapshot().tabs[0]?.terminalVisual?.background.text).toBe('window one');
  restored.present!({ terminalVisual: visual('window two') });
  second.restorePresentation(saved);
  expect(second.getSnapshot().tabs[0]?.terminalVisual?.background.text).toBe('window two');
  expect(first.getSnapshot().tabs[0]?.terminalVisual?.background.text).toBe('window one');
  expect(close).not.toHaveBeenCalled();
  await first.dispose();
  await second.dispose();
});
