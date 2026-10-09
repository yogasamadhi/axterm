import { afterEach, describe, expect, it, vi } from 'vitest';
import { DroppedDirectories } from '../../apps/desktop/src/preload/dropped-directories';

function drop(paths: string[], options: { trusted?: boolean; directory?: boolean } = {}) {
  return {
    isTrusted: options.trusted ?? true,
    dataTransfer: {
      items: paths.map((path) => ({
        kind: 'file',
        webkitGetAsEntry: () => ({ isDirectory: options.directory ?? true }),
        getAsFile: () => ({ name: path }),
      })),
    },
  } as unknown as DragEvent;
}

afterEach(() => vi.useRealTimers());

describe('native dropped directory metadata', () => {
  it('consumes native paths once, retains spaces and unicode, and expires unclaimed metadata', () => {
    vi.useFakeTimers();
    const directories = new DroppedDirectories((file) => file.name);
    directories.capture(drop(['/tmp/中文 folder', '/tmp/a"$`b']));
    expect(directories.takePaths()).toEqual(['/tmp/中文 folder', '/tmp/a"$`b']);
    expect(directories.takePaths()).toEqual([]);
    directories.capture(drop(['/tmp/expired']));
    vi.advanceTimersByTime(1_001);
    expect(directories.takePaths()).toEqual([]);
  });

  it('rejects synthetic, mixed, missing and unsafe paths and clears previous metadata', () => {
    const directories = new DroppedDirectories((file) => file.name);
    for (const event of [
      drop(['/tmp/untrusted'], { trusted: false }),
      drop(['/tmp/file'], { directory: false }),
      drop(['']),
      drop(['/tmp/a\nwhoami']),
      drop(['/tmp/\x1bmalicious']),
      drop(['x'.repeat(4_097)]),
      drop(Array.from({ length: 33 }, (_, index) => `/tmp/${index}`)),
    ]) {
      directories.capture(drop(['/tmp/previous']));
      directories.capture(event);
      expect(directories.takePaths()).toEqual([]);
    }
    const mixed = drop(['/tmp/folder', '/tmp/file']);
    Object.assign(mixed.dataTransfer!.items[1]!, {
      webkitGetAsEntry: () => ({ isDirectory: false }),
    });
    directories.capture(mixed);
    expect(directories.takePaths()).toEqual([]);
    directories.capture(drop(['/tmp/valid']));
    directories.clear();
    expect(directories.takePaths()).toEqual([]);
  });

  it('does not leak earlier paths when native resolution fails', () => {
    const directories = new DroppedDirectories(() => {
      throw new Error('not an OS-backed File');
    });
    directories.capture(drop(['/tmp/folder']));
    expect(directories.takePaths()).toEqual([]);
  });
});
