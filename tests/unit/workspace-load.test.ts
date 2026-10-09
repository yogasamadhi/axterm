import { describe, expect, it, vi } from 'vitest';
import { reportWorkspaceLoadFailure } from '../../apps/desktop/src/main/windows/workspace-load';

describe('workspace load failure reporting', () => {
  it('does not report Chromium cancelling a document replaced by a refresh', () => {
    const report = vi.fn();
    const cancellation = Object.assign(new Error('Navigation cancelled'), {
      code: 'ERR_ABORTED',
      errno: -3,
    });
    reportWorkspaceLoadFailure(cancellation, report);
    expect(report).not.toHaveBeenCalled();
  });

  it('reports a Runtime origin that cannot be reached', () => {
    const report = vi.fn();
    reportWorkspaceLoadFailure(
      Object.assign(new Error('Connection refused'), {
        code: 'ERR_CONNECTION_REFUSED',
        errno: -102,
      }),
      report,
    );
    expect(report).toHaveBeenCalledOnce();
  });

  it.each([new Error('Workspace failed'), null, undefined, 'ERR_ABORTED', { code: 'ERR_ABORTED' }])(
    'continues reporting unclassified failures: %s',
    (error) => {
      const report = vi.fn();
      reportWorkspaceLoadFailure(error, report);
      expect(report).toHaveBeenCalledOnce();
    },
  );
});
