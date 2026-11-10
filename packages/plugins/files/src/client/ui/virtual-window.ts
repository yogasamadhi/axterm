export interface VirtualWindowInput {
  itemCount: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan: number;
}

export interface VirtualWindow {
  start: number;
  end: number;
  visibleCount: number;
}

export function calculateVirtualWindow(input: VirtualWindowInput): VirtualWindow {
  const itemCount = Math.max(0, Math.floor(input.itemCount));
  const rowHeight = Math.max(1, input.rowHeight);
  const scrollTop = Math.max(0, input.scrollTop);
  const viewportHeight = Math.max(0, input.viewportHeight);
  const overscan = Math.max(0, Math.floor(input.overscan));
  const start = Math.min(itemCount, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const end = Math.min(itemCount, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { start, end, visibleCount: Math.max(0, end - start) };
}
