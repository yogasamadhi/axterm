import { describe, expect, it } from 'vitest';
import {
  createFileSelection,
  moveFileSelection,
  selectAllFilePaths,
  selectFilePath,
  singleSelectedFilePath,
} from '../../apps/desktop/src/renderer/src/app/file-selection-model';

const paths = ['/a', '/b', '/c', '/d', '/e'];

function selected(selection: ReturnType<typeof createFileSelection>): string[] {
  return [...selection.paths];
}

describe('file selection model', () => {
  it('replaces, adds, toggles and keeps a pane-local selection', () => {
    let selection = selectFilePath({
      orderedPaths: paths,
      selection: createFileSelection(),
      targetPath: '/b',
    });
    expect(selected(selection)).toEqual(['/b']);
    expect(singleSelectedFilePath(selection)).toBe('/b');

    selection = selectFilePath({
      orderedPaths: paths,
      selection,
      targetPath: '/d',
      additive: true,
    });
    expect(selected(selection)).toEqual(['/b', '/d']);
    expect(singleSelectedFilePath(selection)).toBeUndefined();

    selection = selectFilePath({
      orderedPaths: paths,
      selection,
      targetPath: '/b',
      additive: true,
    });
    expect(selected(selection)).toEqual(['/d']);
    expect(selection.anchorPath).toBe('/b');
  });

  it('matches Electerm range expansion and shrinking behavior', () => {
    let selection = selectFilePath({
      orderedPaths: paths,
      selection: createFileSelection(),
      targetPath: '/b',
    });
    selection = selectFilePath({
      orderedPaths: paths,
      selection,
      targetPath: '/d',
      range: true,
    });
    expect(selected(selection)).toEqual(['/b', '/c', '/d']);

    selection = selectFilePath({
      orderedPaths: paths,
      selection,
      targetPath: '/c',
      range: true,
    });
    expect(selected(selection)).toEqual(['/b', '/c']);
  });

  it('selects the current ordered view and supports wrapping keyboard focus', () => {
    let selection = selectAllFilePaths(paths, '/c');
    expect(selected(selection)).toEqual(paths);

    selection = moveFileSelection({ orderedPaths: paths, selection, direction: 1 });
    expect(selected(selection)).toEqual(['/d']);
    selection = moveFileSelection({ orderedPaths: paths, selection, direction: 1, extend: true });
    expect(selected(selection)).toEqual(['/d', '/e']);
    selection = moveFileSelection({ orderedPaths: paths, selection, direction: 1 });
    expect(selected(selection)).toEqual(['/a']);
  });

  it('ignores paths outside the current pane view', () => {
    const selection = createFileSelection();
    expect(selectFilePath({ orderedPaths: paths, selection, targetPath: '/outside' })).toBe(
      selection,
    );
  });
});
