import type { ShortcutBindings } from '@axterm/plugin-api/configuration';
import type { ShortcutPlatform } from '@axterm/plugin-api/shortcuts';
import { wheelAction } from './model.ts';
/** Current-view presentation input only; no terminal bytes, application keyboard registry or business state. */
export function installTerminalGestures(
  element: HTMLElement,
  ports: {
    platform: ShortcutPlatform;
    current(): ShortcutBindings | undefined;
    run(action: 'zoom-in' | 'zoom-out'): Promise<void>;
  },
): () => void {
  const wheel = (event: WheelEvent) => {
    if (event.defaultPrevented) return;
    const bindings = ports.current();
    if (!bindings) return;
    const action = wheelAction(event, bindings, ports.platform);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    void ports.run(action === 'terminal_zoominTerminal' ? 'zoom-in' : 'zoom-out').catch(() => {});
  };
  element.addEventListener('wheel', wheel, { capture: true, passive: false });
  return () => element.removeEventListener('wheel', wheel, { capture: true });
}
