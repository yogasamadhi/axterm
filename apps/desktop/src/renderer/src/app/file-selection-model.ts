export interface FileSelectionState {
  paths: ReadonlySet<string>;
  anchorPath: string | null;
  focusedPath: string | null;
}

export function createFileSelection(): FileSelectionState {
  return {
    paths: new Set(),
    anchorPath: null,
    focusedPath: null,
  };
}

export function selectFilePath(input: {
  orderedPaths: readonly string[];
  selection: FileSelectionState;
  targetPath: string;
  additive?: boolean;
  range?: boolean;
}): FileSelectionState {
  const { orderedPaths, selection, targetPath } = input;
  if (!orderedPaths.includes(targetPath)) return selection;

  if (input.additive) {
    const paths = new Set(selection.paths);
    if (paths.has(targetPath)) paths.delete(targetPath);
    else paths.add(targetPath);
    return { paths, anchorPath: targetPath, focusedPath: targetPath };
  }

  if (input.range && selection.paths.size) {
    const targetIndex = orderedPaths.indexOf(targetPath);
    const selectedIndices = orderedPaths
      .map((path, index) => (selection.paths.has(path) ? index : -1))
      .filter((index) => index >= 0);
    if (selectedIndices.length) {
      const firstIndex = Math.min(...selectedIndices);
      const lastIndex = Math.max(...selectedIndices);
      let start = Math.min(firstIndex, targetIndex);
      let end = Math.max(lastIndex, targetIndex);

      // Electerm shrinks a selected range from the opposite edge when the
      // shift-click target is already selected.
      if (selection.paths.has(targetPath)) {
        const anchorIndex = selection.anchorPath ? orderedPaths.indexOf(selection.anchorPath) : -1;
        const oppositeIndex = anchorIndex > targetIndex ? firstIndex : lastIndex;
        start = Math.min(oppositeIndex, targetIndex);
        end = Math.max(oppositeIndex, targetIndex);
      }

      return {
        paths: new Set(orderedPaths.slice(start, end + 1)),
        anchorPath: targetPath,
        focusedPath: targetPath,
      };
    }
  }

  return {
    paths: new Set([targetPath]),
    anchorPath: targetPath,
    focusedPath: targetPath,
  };
}

export function selectAllFilePaths(
  orderedPaths: readonly string[],
  focusedPath: string | null = null,
): FileSelectionState {
  return {
    paths: new Set(orderedPaths),
    anchorPath: focusedPath && orderedPaths.includes(focusedPath) ? focusedPath : null,
    focusedPath: focusedPath && orderedPaths.includes(focusedPath) ? focusedPath : null,
  };
}

export function moveFileSelection(input: {
  orderedPaths: readonly string[];
  selection: FileSelectionState;
  direction: -1 | 1;
  extend?: boolean;
}): FileSelectionState {
  const { orderedPaths, selection, direction } = input;
  if (!orderedPaths.length) return createFileSelection();

  const selectedIndices = orderedPaths
    .map((path, index) => (selection.paths.has(path) ? index : -1))
    .filter((index) => index >= 0);
  const focusedIndex = selection.focusedPath ? orderedPaths.indexOf(selection.focusedPath) : -1;
  const edgeIndex = direction === 1 ? Math.max(...selectedIndices) : Math.min(...selectedIndices);
  const currentIndex =
    focusedIndex >= 0 ? focusedIndex : Number.isFinite(edgeIndex) ? edgeIndex : -1;
  const targetIndex =
    currentIndex < 0 ? 0 : (currentIndex + direction + orderedPaths.length) % orderedPaths.length;
  const targetPath = orderedPaths[targetIndex]!;

  if (input.extend && currentIndex >= 0) {
    const anchorPath =
      selection.anchorPath && orderedPaths.includes(selection.anchorPath)
        ? selection.anchorPath
        : orderedPaths[currentIndex]!;
    const anchorIndex = orderedPaths.indexOf(anchorPath);
    return {
      paths: new Set(
        orderedPaths.slice(
          Math.min(anchorIndex, targetIndex),
          Math.max(anchorIndex, targetIndex) + 1,
        ),
      ),
      anchorPath,
      focusedPath: targetPath,
    };
  }

  return {
    paths: new Set([targetPath]),
    anchorPath: targetPath,
    focusedPath: targetPath,
  };
}

export function singleSelectedFilePath(selection: FileSelectionState): string | undefined {
  if (selection.paths.size !== 1) return undefined;
  return selection.paths.values().next().value;
}
