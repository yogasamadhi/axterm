/** Retained Axterm snapshot limits; output stays private to the live renderer. */
export const NORMAL_BUFFER_MAX_LINES = 2000;
export const NORMAL_BUFFER_MAX_CHARACTERS = 256 * 1024;
interface NormalBuffer {
  readonly length: number;
  getLine(index: number): { translateToString(trimRight: boolean): string } | undefined;
}
export function readNormalBuffer(buffer: NormalBuffer): string | undefined {
  const lines: string[] = [];
  let remaining = NORMAL_BUFFER_MAX_CHARACTERS;
  for (
    let index = buffer.length - 1;
    index >= 0 && lines.length < NORMAL_BUFFER_MAX_LINES;
    index--
  ) {
    const line = buffer.getLine(index)?.translateToString(true) ?? '';
    if (!line && !lines.length) continue;
    const bounded = line.slice(-remaining);
    lines.unshift(bounded);
    remaining -= bounded.length;
    if (remaining <= 0) break;
  }
  return lines.length ? lines.join('\n') : undefined;
}
