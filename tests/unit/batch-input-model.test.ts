import { describe, expect, it } from 'vitest';
import type { TerminalTab } from '../../apps/desktop/src/renderer/src/stores/workspace';
import {
  batchInputEligibleTabs,
  normalizedBatchInputSelection,
  orderedBatchInputTabs,
} from '../../apps/desktop/src/renderer/src/app/batch-input/batch-input-model';

const tabs: TerminalTab[] = [
  { id: 'ssh', title: 'SSH', kind: 'ssh', disconnected: false },
  { id: 'local', title: 'Local', kind: 'local', disconnected: false },
  { id: 'web', title: 'Web', kind: 'web', disconnected: false },
  { id: 'closed', title: 'Closed', kind: 'telnet', disconnected: true },
];

describe('Batch Input model', () => {
  it('keeps only connected terminal protocols', () => {
    expect(batchInputEligibleTabs(tabs).map(({ id }) => id)).toEqual(['ssh', 'local']);
  });

  it('removes closed selections and always retains one valid target', () => {
    expect([...normalizedBatchInputSelection(new Set(['web', 'closed']), tabs, 'local')]).toEqual([
      'local',
    ]);
  });

  it('places the active target first without mutating the workspace order', () => {
    expect(orderedBatchInputTabs(tabs, 'local').map(({ id }) => id)).toEqual(['local', 'ssh']);
    expect(tabs.map(({ id }) => id)).toEqual(['ssh', 'local', 'web', 'closed']);
  });
});
