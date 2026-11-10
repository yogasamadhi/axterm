import type {} from '../../packages/plugins/configuration/lib/typert.remote-client.js';
import type {} from '../../packages/plugins/configuration/src/client/locales.ts';
import { describe, expect, it } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import { syncFailurePresentation } from '../../packages/plugins/configuration/src/client/sync-errors.ts';
describe('owned sync error presentation', () => {
  it('localizes a GitHub Gist clone requirement', () => {
    const error = new RemoteError('configuration/sync-failure', 'server detail', {
      reason: 'gist-clone-required',
    });
    expect(syncFailurePresentation(error)).toEqual({
      key: 'dataSync.gistCloneRequired',
      showGistRecovery: true,
    });
  });
  it('localizes Gitee truncation without offering GitHub-specific clone instructions', () => {
    const error = new RemoteError('configuration/sync-failure', 'server detail', {
      reason: 'gitee-truncated',
    });
    expect(syncFailurePresentation(error)).toEqual({
      key: 'dataSync.giteeTruncated',
      showGistRecovery: false,
    });
  });
  it('localizes unknown and other typed failures without exposing arbitrary messages', () => {
    for (const error of [
      new Error('remote provider detail'),
      { reason: 'unknown' },
      new RemoteError('configuration/sync-failure', 'secret server detail', {
        reason: 'provider-failed',
      }),
    ]) {
      expect(syncFailurePresentation(error)).toEqual({
        key: 'dataSync.operationFailed',
        showGistRecovery: false,
      });
      expect(JSON.stringify(syncFailurePresentation(error))).not.toContain('detail');
    }
  });
});
