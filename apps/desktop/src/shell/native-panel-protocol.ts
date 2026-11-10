import { randomUUID } from 'node:crypto';
export type PanelKind = 'open-file' | 'open-directory' | 'save-file';
export type PanelFrame =
  | { kind: 'axterm-native-panel'; version: 1; id: string; type: 'select'; selection: PanelKind }
  | { kind: 'axterm-native-panel'; version: 1; id: string; type: 'ready' }
  | { kind: 'axterm-native-panel'; version: 1; id: string; type: 'result'; path: string | null };
export function panelId(): string {
  return randomUUID();
}
/** Finite native-only exchange; reject extra keys and never carry file bodies. */
export function parsePanelFrame(value: unknown): PanelFrame {
  const fail = (): never => {
    throw new Error('NATIVE_PANEL_PROTOCOL');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const input = value as Record<string, unknown>;
  if (
    input.kind !== 'axterm-native-panel' ||
    input.version !== 1 ||
    typeof input.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id)
  )
    return fail();
  const keys =
    input.type === 'select'
      ? ['kind', 'version', 'id', 'type', 'selection']
      : input.type === 'ready'
        ? ['kind', 'version', 'id', 'type']
        : input.type === 'result'
          ? ['kind', 'version', 'id', 'type', 'path']
          : undefined;
  if (
    !keys ||
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    return fail();
  if (
    input.type === 'select' &&
    input.selection !== 'open-file' &&
    input.selection !== 'open-directory' &&
    input.selection !== 'save-file'
  )
    return fail();
  if (
    input.type === 'result' &&
    input.path !== null &&
    (typeof input.path !== 'string' ||
      !input.path.length ||
      input.path.length > 4096 ||
      input.path.includes('\0'))
  )
    return fail();
  return input as unknown as PanelFrame;
}
