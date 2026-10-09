import { describe, expect, it } from 'vitest';
import {
  dataSyncErrorMessage,
  requiresGistCloneRecovery,
} from '../../apps/desktop/src/renderer/src/app/data-sync/data-sync-error';

describe('data sync error message', () => {
  it('localizes a GitHub Gist clone requirement', () => {
    const error = Object.assign(new Error('server detail'), {
      code: 'SYNC_GIST_CLONE_REQUIRED',
    });

    expect(dataSyncErrorMessage(error, (key) => key)).toBe('dataSync.gistCloneRequired');
    expect(requiresGistCloneRecovery(error)).toBe(true);
  });

  it('localizes Gitee truncation without offering GitHub-specific clone instructions', () => {
    const error = Object.assign(new Error('server detail'), {
      code: 'SYNC_GITEE_TRUNCATED',
    });

    expect(dataSyncErrorMessage(error, (key) => key)).toBe('dataSync.giteeTruncated');
    expect(requiresGistCloneRecovery(error)).toBe(false);
  });

  it('preserves other typed details and localizes unknown failures', () => {
    expect(requiresGistCloneRecovery(new Error('remote provider detail'))).toBe(false);
    expect(dataSyncErrorMessage(new Error('remote provider detail'), (key) => key)).toBe(
      'remote provider detail',
    );
    expect(dataSyncErrorMessage({ reason: 'unknown' }, (key) => key)).toBe(
      'dataSync.operationFailed',
    );
  });
});
