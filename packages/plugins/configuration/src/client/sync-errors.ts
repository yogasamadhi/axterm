import { remoteErrorOf } from '@axterm/plugin-api';
/** Shared by the actual settings page; remote details never become arbitrary UI text. */
export function syncFailurePresentation(error: unknown): {
  key: 'dataSync.gistCloneRequired' | 'dataSync.giteeTruncated' | 'dataSync.operationFailed';
  showGistRecovery: boolean;
} {
  const marked = remoteErrorOf(error);
  const reason = marked?.code === 'configuration/sync-failure' ? marked.details.reason : undefined;
  return {
    key:
      reason === 'gist-clone-required'
        ? 'dataSync.gistCloneRequired'
        : reason === 'gitee-truncated'
          ? 'dataSync.giteeTruncated'
          : 'dataSync.operationFailed',
    showGistRecovery: reason === 'gist-clone-required',
  };
}
