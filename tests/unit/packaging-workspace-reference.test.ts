import { describe, expect, it } from 'vitest';
import { hasPackagedWorkspaceReference } from '../../scripts/packaging-workspace-reference.mjs';

describe('packaged workspace reference detection', () => {
  it('rejects source children and file URLs under a Linux container workspace', () => {
    expect(
      hasPackagedWorkspaceReference(
        'load /workspace/packages/runtime/src/entry/desktop.js',
        '/workspace',
      ),
    ).toBe(true);
    expect(
      hasPackagedWorkspaceReference(
        'load file:///workspace/apps/desktop/out/main.js',
        '/workspace',
      ),
    ).toBe(true);
  });

  it('does not confuse a generic container mount with terminal preview copy', () => {
    expect(hasPackagedWorkspaceReference('Axterm · ~/workspace', '/workspace')).toBe(false);
    expect(hasPackagedWorkspaceReference('user@host:~/workspace$ ls -la', '/workspace')).toBe(
      false,
    );
  });

  it('recognizes native and slash-normalized Windows source children', () => {
    const sourceRoot = 'C:\\source\\axterm';
    expect(hasPackagedWorkspaceReference('C:\\source\\axterm\\apps\\desktop', sourceRoot)).toBe(
      true,
    );
    expect(hasPackagedWorkspaceReference('C:/source/axterm/packages/runtime', sourceRoot)).toBe(
      true,
    );
  });
});
