import { useLayoutEffect, type RefObject } from 'react';
/** Retained bounded Axterm measurement: native buttons stay in physical pixels while the document zooms. */
export function useNativeControls(root: RefObject<HTMLDivElement>): void {
  useLayoutEffect(() => {
    const shell = root.current;
    if (!shell || document.documentElement.dataset.platform !== 'darwin') return;
    let pending: number | undefined;
    const measure = () => {
      const zoom =
        window.outerWidth > 0 && window.innerWidth > 0 ? window.outerWidth / window.innerWidth : 1;
      shell.style.setProperty('--ax-native-controls-width', `${80 / zoom}px`);
      shell.style.setProperty('--ax-native-controls-height', `${38 / zoom}px`);
    };
    const update = () => {
      measure();
      if (pending !== undefined) cancelAnimationFrame(pending);
      let remaining = 30;
      const reconcile = () => {
        pending = undefined;
        measure();
        if (--remaining > 0) pending = requestAnimationFrame(reconcile);
      };
      pending = requestAnimationFrame(reconcile);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      if (pending !== undefined) cancelAnimationFrame(pending);
      shell.style.removeProperty('--ax-native-controls-width');
      shell.style.removeProperty('--ax-native-controls-height');
    };
  }, [root]);
}
