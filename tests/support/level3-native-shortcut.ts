import { expect, type ElectronApplication, type Page } from '@playwright/test';
/** CDP key dispatch can bypass Electron before-input-event; use the real owned window's input carrier. */
export async function pressLevel3NativeShortcut(
  app: ElectronApplication,
  page: Page,
  keyCode: string,
  modifiers: ('alt' | 'meta' | 'control' | 'shift')[],
): Promise<void> {
  const window = await app.browserWindow(page);
  try {
    await app.evaluate(({ app }) => app.focus({ steal: true }));
    await window.evaluate((target) => {
      target.show();
      target.focus();
      target.webContents.focus();
    });
    await expect
      .poll(() => window.evaluate((target) => target.isFocused() && target.webContents.isFocused()))
      .toBe(true);
    await window.evaluate(
      (target, input) => {
        target.webContents.sendInputEvent({ type: 'keyDown', ...input });
        target.webContents.sendInputEvent({ type: 'keyUp', ...input });
      },
      { keyCode, modifiers },
    );
  } finally {
    await window.dispose();
  }
}
