import {
  DEFAULT_TERMINAL_SHORTCUT_BUTTONS,
  type TerminalShortcutButton,
} from '@workspace/contracts';

export const TERMINAL_SHORTCUT_BAR_HEIGHT = 44;
export const TERMINAL_SHORTCUT_KEYBOARD_MIN = 120;
export const TERMINAL_SHORTCUT_TOUCH_GRACE_MS = 3_000;

const ESC = '\u001b';
const DEL = '\u007f';

interface TerminalShortcutKey extends TerminalShortcutButton {
  ctrlData?: string;
}

const controlButtons: TerminalShortcutButton[] = 'abcdefghijklmnopqrstuvwxyz'
  .split('')
  .map((letter) => ({
    id: `ctrl+${letter}`,
    label: `Ctrl+${letter.toUpperCase()}`,
    data: String.fromCharCode(letter.charCodeAt(0) - 96),
    custom: false,
  }));

const functionButtons: TerminalShortcutButton[] = [
  ['f1', 'F1', `${ESC}OP`],
  ['f2', 'F2', `${ESC}OQ`],
  ['f3', 'F3', `${ESC}OR`],
  ['f4', 'F4', `${ESC}OS`],
  ['f5', 'F5', `${ESC}[15~`],
  ['f6', 'F6', `${ESC}[17~`],
  ['f7', 'F7', `${ESC}[18~`],
  ['f8', 'F8', `${ESC}[19~`],
  ['f9', 'F9', `${ESC}[20~`],
  ['f10', 'F10', `${ESC}[21~`],
  ['f11', 'F11', `${ESC}[23~`],
  ['f12', 'F12', `${ESC}[24~`],
].map(([id, label, data]) => ({ id: id!, label: label!, data: data!, custom: false }));

const navigationButtons: TerminalShortcutButton[] = [
  { id: 'esc', label: 'Esc', data: ESC, custom: false },
  { id: 'tab', label: 'Tab', data: '\t', custom: false },
  { id: 'enter', label: 'Enter', data: '\r', custom: false },
  { id: 'space', label: 'Space', data: ' ', custom: false },
  { id: 'backspace', label: 'Bksp', data: DEL, custom: false },
  { id: 'arrow-up', label: '↑', data: `${ESC}[A`, custom: false },
  { id: 'arrow-down', label: '↓', data: `${ESC}[B`, custom: false },
  { id: 'arrow-right', label: '→', data: `${ESC}[C`, custom: false },
  { id: 'arrow-left', label: '←', data: `${ESC}[D`, custom: false },
  { id: 'home', label: 'Home', data: `${ESC}[H`, custom: false },
  { id: 'end', label: 'End', data: `${ESC}[F`, custom: false },
  { id: 'pageup', label: 'PgUp', data: `${ESC}[5~`, custom: false },
  { id: 'pagedown', label: 'PgDn', data: `${ESC}[6~`, custom: false },
  { id: 'insert', label: 'Ins', data: `${ESC}[2~`, custom: false },
  { id: 'delete', label: 'Del', data: `${ESC}[3~`, custom: false },
];

const punctuationButtons: TerminalShortcutButton[] = ':;/~|\\`\'".,(){}[]<>=+-_*&^%$#@!?'
  .split('')
  .map((character) => ({
    id: `char-${character.charCodeAt(0)}`,
    label: character,
    data: character,
    custom: false,
  }));

export const TERMINAL_SHORTCUT_CANDIDATES: TerminalShortcutButton[] = [
  ...navigationButtons,
  ...controlButtons,
  ...functionButtons,
  ...punctuationButtons,
].filter((button, index, all) => all.findIndex(({ id }) => id === button.id) === index);

const letterKeys: TerminalShortcutKey[] = 'abcdefghijklmnopqrstuvwxyz'.split('').map((letter) => ({
  id: `key-${letter}`,
  label: letter.toUpperCase(),
  data: letter,
  custom: false,
  ctrlData: String.fromCharCode(letter.charCodeAt(0) - 96),
}));

const digitKeys: TerminalShortcutKey[] = '0123456789'.split('').map((digit) => ({
  id: `key-${digit}`,
  label: digit,
  data: digit,
  custom: false,
}));

export const TERMINAL_SHORTCUT_KEY_OPTIONS: TerminalShortcutKey[] = [
  ...navigationButtons,
  ...letterKeys,
  ...digitKeys,
  ...functionButtons,
  ...punctuationButtons,
];

export const TERMINAL_SHORTCUT_MODIFIERS = [
  { id: 'ctrl', label: 'Ctrl' },
  { id: 'alt', label: 'Alt' },
  { id: 'shift', label: 'Shift' },
  { id: 'meta', label: 'Meta' },
] as const;

export type TerminalShortcutModifier = (typeof TERMINAL_SHORTCUT_MODIFIERS)[number]['id'];

export function defaultTerminalShortcutButtons(): TerminalShortcutButton[] {
  return DEFAULT_TERMINAL_SHORTCUT_BUTTONS.map((button) => ({ ...button }));
}

export function buildTerminalShortcutCombo(
  modifiers: TerminalShortcutModifier[],
  keyId: string,
  id = `custom-${crypto.randomUUID()}`,
): TerminalShortcutButton | undefined {
  const key = TERMINAL_SHORTCUT_KEY_OPTIONS.find(({ id: candidateId }) => candidateId === keyId);
  if (!key) return undefined;
  const normalized = [...new Set(modifiers)].slice(0, 2);
  const control = normalized.includes('ctrl');
  const alternate = normalized.includes('alt');
  const shift = normalized.includes('shift');
  let data = control && key.ctrlData ? key.ctrlData : key.data;
  if (!control && shift && /^[a-z]$/u.test(data)) data = data.toUpperCase();
  if (alternate) data = `${ESC}${data}`;
  const labels = new Map(TERMINAL_SHORTCUT_MODIFIERS.map(({ id, label }) => [id, label]));
  return {
    id,
    label: [...normalized.map((modifier) => labels.get(modifier) ?? modifier), key.label].join('+'),
    data,
    custom: true,
  };
}

const APPLICATION_CURSOR_SEQUENCES = new Map([
  [`${ESC}[A`, `${ESC}OA`],
  [`${ESC}[B`, `${ESC}OB`],
  [`${ESC}[C`, `${ESC}OC`],
  [`${ESC}[D`, `${ESC}OD`],
  [`${ESC}[H`, `${ESC}OH`],
  [`${ESC}[F`, `${ESC}OF`],
]);

export function resolveTerminalShortcutCursorMode(
  data: string,
  applicationCursorKeysMode: boolean,
): string {
  return applicationCursorKeysMode ? (APPLICATION_CURSOR_SEQUENCES.get(data) ?? data) : data;
}

export function moveTerminalShortcutButton(
  buttons: TerminalShortcutButton[],
  sourceId: string,
  targetId: string,
  after: boolean,
): TerminalShortcutButton[] {
  if (sourceId === targetId) return buttons;
  const source = buttons.find(({ id }) => id === sourceId);
  const targetIndex = buttons.findIndex(({ id }) => id === targetId);
  if (!source || targetIndex < 0) return buttons;
  const without = buttons.filter(({ id }) => id !== sourceId);
  const correctedTarget = without.findIndex(({ id }) => id === targetId);
  without.splice(correctedTarget + Number(after), 0, source);
  return without;
}

export function shortcutKeyboardDetected(input: {
  baselineHeight: number;
  baselineWidth: number;
  visualHeight: number;
  visualWidth: number;
  layoutHeight: number;
  recentTouch: boolean;
}): boolean {
  const sameWidth = Math.abs(input.visualWidth - input.baselineWidth) < 20;
  const heightLoss = input.baselineHeight - input.visualHeight;
  if (!sameWidth || heightLoss <= TERMINAL_SHORTCUT_KEYBOARD_MIN) return false;
  const layoutShrunk = input.layoutHeight < input.baselineHeight - TERMINAL_SHORTCUT_KEYBOARD_MIN;
  return !layoutShrunk || input.recentTouch;
}

export function shortcutKeyboardOffset(input: {
  baselineHeight: number;
  baselineWidth: number;
  visualHeight: number;
  visualWidth: number;
  offsetTop: number;
}): number {
  if (Math.abs(input.visualWidth - input.baselineWidth) >= 20) return 0;
  const covered = input.baselineHeight - input.visualHeight - input.offsetTop;
  return covered > TERMINAL_SHORTCUT_KEYBOARD_MIN ? Math.ceil(covered) : 0;
}
