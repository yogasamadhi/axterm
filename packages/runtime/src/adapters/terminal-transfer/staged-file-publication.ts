import { link } from 'node:fs/promises';
import { publishFileExclusive } from '@openclaw/fs-safe/durability';

type AsyncPublicationOperations = {
  linkFile?: typeof link;
  nativePublish?: typeof publishFileExclusive;
};

function supportsNativeNoReplaceFallback(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  return ['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EINVAL'].includes(
    String(error.code),
  );
}

// Hard links provide an atomic no-overwrite publish within the granted
// destination directory. A hard-link-limited filesystem must use a native
// atomic no-replace rename of the already complete staging file; never expose
// partial destination bytes through COPYFILE_EXCL. The native rename consumes
// the source name, unlike link(). Missing native support fails closed.
export async function publishStagedFile(
  source: string,
  destination: string,
  operations: AsyncPublicationOperations = {},
): Promise<void> {
  try {
    await (operations.linkFile ?? link)(source, destination);
  } catch (error) {
    if (!supportsNativeNoReplaceFallback(error)) throw error;
    await (operations.nativePublish ?? publishFileExclusive)({
      sourcePath: source,
      targetPath: destination,
      strategy: 'rename-noreplace',
    });
  }
}

export function destinationCreatedBeforePublicationFailure(error: unknown): boolean {
  if (!(error instanceof Error) || !('details' in error)) return false;
  const details = (error as Error & { details?: Record<string, unknown> }).details;
  return details?.targetCreated === true && details.cleanup === 'preserved';
}

export function destinationDoesNotSupportAtomicPublication(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  return ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(String(error.code));
}
