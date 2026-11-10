/** Immutable observable contract used by the adapted DSH registry. */
export function createSnapshotStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(value: T) {
      state = value;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          console.warn('SHORTCUT_OBSERVER_FAILED');
        }
      }
    },
  };
}
