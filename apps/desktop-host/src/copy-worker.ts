import { homeCopyInitializeSchema as initialize, type homeCopyFailureSchema } from './protocol.ts';
import type { z } from 'zod';
import { VaultError } from '@axterm/infra-credential-vault';
import { copyGeneration2Home } from './copy/home.ts';
/** One inherited startup input and finite result; no server, plugin profile, or reusable business dispatch. */
export function startHomeCopyWorker(): void {
  if (!process.connected || !process.send) throw Error('DATA_COPY_PARENT_REQUIRED');
  const stop = () => process.exit(1);
  process.once('disconnect', stop);
  process.once('message', async (message) => {
    try {
      const input = initialize.parse(message);
      const result = await copyGeneration2Home({
        source: input.source,
        home: input.home,
        action: input.action,
      });
      process.send?.(
        { kind: 'axterm-home-copy-result', version: 1, ok: true, id: result.id },
        () => {
          process.off('disconnect', stop);
          process.disconnect?.();
        },
      );
    } catch (error) {
      process.exitCode = 1;
      process.send?.(
        {
          kind: 'axterm-home-copy-result',
          version: 1,
          ok: false,
          code: failureCode(error),
        },
        () => {
          process.off('disconnect', stop);
          process.disconnect?.();
        },
      );
    }
  });
}

export function failureCode(error: unknown): z.infer<typeof homeCopyFailureSchema> {
  if (error instanceof VaultError) return 'DATA_COPY_VAULT_INVALID';
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const sqliteFull =
    error && typeof error === 'object' && 'errcode' in error && error.errcode === 13;
  if (code === 'ENOSPC' || code === 'EDQUOT' || (code === 'ERR_SQLITE_ERROR' && sqliteFull))
    return 'DATA_COPY_NO_SPACE';
  const message = error instanceof Error ? error.message : '';
  if (message === 'DATA_COPY_NO_SPACE') return 'DATA_COPY_NO_SPACE';
  if (/^DATA_COPY_(TARGET_CONFLICT|ROOT_ALIAS|SOURCE_TARGET_ALIAS)$/.test(message))
    return 'DATA_COPY_TARGET_CONFLICT';
  if (/^DATA_COPY_(MISSING_CREDENTIAL|MISSING_BACKGROUND|MISSING_THEME)$/.test(message))
    return 'DATA_COPY_MISSING_REFERENCE';
  if (message === 'DATA_COPY_SOURCE_CHANGED') return 'DATA_COPY_SOURCE_CHANGED';
  if (
    code === 'ENOENT' ||
    /^DATA_COPY_(UNSUPPORTED_|INVALID_|VAULT_MISSING|DATABASE_INTEGRITY)/.test(message)
  )
    return 'DATA_COPY_SOURCE_INVALID';
  return 'DATA_COPY_RECOVERY_REQUIRED';
}
