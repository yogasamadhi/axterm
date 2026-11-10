import type { RemoteFilesystem, RemoteFileLease } from '@axterm/plugin-api/host';
export type RemoteFileLeaseFactory = (
  filesystem: RemoteFilesystem,
  signal: AbortSignal,
  released: () => void,
) => RemoteFileLease;
