/** Retained pane limits shared by pointer/keyboard updates and the visible separator contract. */
export function clampFileManagerSplitPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(75, Math.max(25, value)) : 50;
}
