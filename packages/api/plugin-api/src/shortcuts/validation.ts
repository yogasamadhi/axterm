import { parseShortcutDefinitions, parseShortcutDocument } from './configuration.ts';
import type { AxtermKeyboardRequest, DesktopWindowPresentationState } from './native.ts';
import type { ShortcutConfigSnapshot, ShortcutRevision } from './persistence.ts';
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
/** Reject additional fields, future documents, excessive catalogs and malformed identities at the shell boundary. */
export function parseKeyboardRequest(value: unknown): AxtermKeyboardRequest {
  if (!record(value)) throw Error('KEYBOARD_INPUT_INVALID');
  if (
    value.type === 'window' &&
    keys(value, ['type', 'generation', 'action']) &&
    uuid(value.generation) &&
    (value.action === 'fullscreen' ||
      value.action === 'minimize' ||
      value.action === 'toggle-maximize')
  )
    return { type: 'window', generation: value.generation, action: value.action };
  if (
    value.type === 'window-state' &&
    keys(value, ['type', 'generation']) &&
    uuid(value.generation)
  )
    return { type: 'window-state', generation: value.generation };
  if (value.type === 'clear' && keys(value, ['type'])) return { type: 'clear' };
  if (
    value.type === 'recording' &&
    keys(value, ['type', 'active']) &&
    typeof value.active === 'boolean'
  )
    return { type: 'recording', active: value.active };
  if (value.type === 'close' && keys(value, ['type', 'revision']) && uuid(value.revision))
    return { type: 'close', revision: value.revision as ShortcutRevision };
  if (
    value.type !== 'configure' ||
    !keys(value, ['type', 'generation', 'definitions', 'snapshot']) ||
    !uuid(value.generation) ||
    !record(value.snapshot)
  )
    throw Error('KEYBOARD_INPUT_INVALID');
  const snapshot = value.snapshot;
  if (
    !keys(snapshot, ['revision', 'sequence', 'document', 'status', 'error', 'usingDefaults']) ||
    !uuid(snapshot.revision) ||
    typeof snapshot.sequence !== 'number' ||
    !Number.isSafeInteger(snapshot.sequence) ||
    snapshot.sequence < 0 ||
    !['ready', 'unreadable'].includes(String(snapshot.status)) ||
    ![null, 'read', 'invalid', 'future'].includes(snapshot.error as null) ||
    typeof snapshot.usingDefaults !== 'boolean'
  )
    throw Error('KEYBOARD_INPUT_INVALID');
  const document = parseShortcutDocument(JSON.stringify(snapshot.document));
  if (typeof document === 'string') throw Error('KEYBOARD_INPUT_INVALID');
  return {
    type: 'configure',
    generation: value.generation,
    definitions: parseShortcutDefinitions(value.definitions),
    snapshot: {
      revision: snapshot.revision as ShortcutRevision,
      sequence: snapshot.sequence,
      document,
      status: snapshot.status === 'ready' ? 'ready' : 'unreadable',
      error: snapshot.error as ShortcutConfigSnapshot['error'],
      usingDefaults: snapshot.usingDefaults,
    },
  };
}

export function parseWindowPresentationState(value: unknown): DesktopWindowPresentationState {
  const fields = [
    'minimized',
    'maximized',
    'fullScreen',
    'focused',
    'visible',
    'canMinimize',
    'canMaximize',
    'canClose',
  ] as const;
  if (
    !record(value) ||
    !keys(value, fields) ||
    fields.some((key) => typeof value[key] !== 'boolean')
  )
    throw Error('WINDOW_PRESENTATION_INVALID');
  return Object.fromEntries(
    fields.map((key) => [key, value[key]]),
  ) as unknown as DesktopWindowPresentationState;
}
