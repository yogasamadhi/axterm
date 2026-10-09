import type { AxtermMessageKey } from '../../i18n/core';

type Translate = (key: AxtermMessageKey) => string;

export function requiresGistCloneRecovery(value: unknown): boolean {
  return value instanceof Error && 'code' in value && value.code === 'SYNC_GIST_CLONE_REQUIRED';
}

export function dataSyncErrorMessage(value: unknown, x: Translate): string {
  if (requiresGistCloneRecovery(value)) return x('dataSync.gistCloneRequired');
  if (value instanceof Error && 'code' in value && value.code === 'SYNC_GITEE_TRUNCATED')
    return x('dataSync.giteeTruncated');

  return value instanceof Error ? value.message : x('dataSync.operationFailed');
}
