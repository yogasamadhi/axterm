import type { TerminalTab } from '../../stores/workspace';

export function batchInputEligibleTabs(tabs: readonly TerminalTab[]): TerminalTab[] {
  return tabs.filter(
    (tab) =>
      !tab.disconnected &&
      (tab.kind === 'local' ||
        tab.kind === 'ssh' ||
        tab.kind === 'telnet' ||
        tab.kind === 'serial'),
  );
}

export function normalizedBatchInputSelection(
  selected: ReadonlySet<string>,
  tabs: readonly TerminalTab[],
  activeTerminalId: string | undefined,
): Set<string> {
  const eligible = batchInputEligibleTabs(tabs);
  const eligibleIds = new Set(eligible.map(({ id }) => id));
  const next = new Set([...selected].filter((id) => eligibleIds.has(id)));
  if (!next.size && activeTerminalId && eligibleIds.has(activeTerminalId))
    next.add(activeTerminalId);
  if (!next.size && eligible[0]) next.add(eligible[0].id);
  return next;
}

export function orderedBatchInputTabs(
  tabs: readonly TerminalTab[],
  activeTerminalId: string | undefined,
): TerminalTab[] {
  return batchInputEligibleTabs(tabs).sort((left, right) => {
    if (left.id === activeTerminalId) return -1;
    if (right.id === activeTerminalId) return 1;
    return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
  });
}
