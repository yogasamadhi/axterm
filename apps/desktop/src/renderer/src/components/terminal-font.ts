export const BUNDLED_TERMINAL_FONT_FAMILY = 'Maple Mono';
export const BUNDLED_TERMINAL_FONT_SPEC = `400 16px "${BUNDLED_TERMINAL_FONT_FAMILY}"`;
export const TERMINAL_FONT_LOAD_TIMEOUT_MS = 2_000;

interface TerminalFontSet {
  load(font: string, text?: string): PromiseLike<unknown>;
  check(font: string, text?: string): boolean;
}

export async function prepareBundledTerminalFont(
  fonts: TerminalFontSet,
  timeoutMs = TERMINAL_FONT_LOAD_TIMEOUT_MS,
): Promise<'ready' | 'fallback'> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(fonts.load(BUNDLED_TERMINAL_FONT_SPEC, 'Axterm =>')).then(() =>
        fonts.check(BUNDLED_TERMINAL_FONT_SPEC, 'Axterm =>') ? 'ready' : 'fallback',
      ),
      new Promise<'fallback'>((resolve) => {
        timeout = setTimeout(() => resolve('fallback'), Math.max(0, timeoutMs));
      }),
    ]);
  } catch {
    return 'fallback';
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
