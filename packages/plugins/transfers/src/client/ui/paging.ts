/** Rows the transfer center renders before the user asks for more. */
export const TRANSFER_PAGE_SIZE = 20;

/**
 * Bounded number of transfer rows the panel may render. The Transfers owner keeps up
 * to 500 rows, so the panel pages through them instead of rebuilding the whole
 * list on every transfer update.
 */
export function visibleTransferCount(total: number, expandedRows: number): number {
  const rows = Math.max(0, Math.trunc(total));
  const expanded = Math.max(0, Math.trunc(expandedRows));
  return Math.min(rows, TRANSFER_PAGE_SIZE + expanded);
}
