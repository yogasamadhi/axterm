import { lstat } from 'node:fs/promises';
import type { FileGrantLease } from '@axterm/plugin-api/host';
/** Revalidate the selected capability and its pinned directory immediately before protocol IO. */
export async function assertWidgetAuthority(leases: readonly FileGrantLease[]): Promise<void> {
  if (!leases.length) throw Error('WIDGET_AUTHORITY_UNAVAILABLE');
  for (const lease of leases) lease.assert();
  const authority = leases[0]!.authority,
    stat = await lstat(authority.rootPath, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    String(stat.dev) !== authority.rootIdentity.device ||
    String(stat.ino) !== authority.rootIdentity.inode
  )
    throw Error('WIDGET_AUTHORITY_CHANGED');
  for (const lease of leases) lease.assert();
}
