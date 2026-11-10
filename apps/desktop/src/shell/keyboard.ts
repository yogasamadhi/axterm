import { desktopWindowFullscreen, toggleDesktopFullscreen } from './fullscreen.ts';
// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from apps/desktop/src/keyboard.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
// Axterm owns only transient per-window physical input; Configuration persists preferences in Host.
import {
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type Input,
  type WebContents,
} from 'electron';
import { bindingKey, effectiveShortcuts, parseKeyboardRequest } from '@axterm/plugin-api/shortcuts';
import type {
  ShortcutConfigSnapshot,
  ShortcutDefinition,
  ShortcutPlatform,
  ShortcutRevision,
  NormalizedBinding,
} from '@axterm/plugin-api/shortcuts';
import { isApplicationDocument } from './window-policy.ts';
interface WindowKeys {
  window: BrowserWindow;
  generation?: string;
  snapshot?: ShortcutConfigSnapshot;
  definitions: readonly ShortcutDefinition[];
  keys: Set<string>;
  recording: boolean;
  guests: Set<() => void>;
  guestResets: Set<() => void>;
  reset(): void;
  dispose(): void;
}
export class DesktopKeyboardBridge {
  private readonly windows = new Map<number, WindowKeys>();
  private readonly platform: ShortcutPlatform =
    process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
  private closed = false;
  constructor(
    private readonly generation: () => string | undefined,
    private readonly channel: {
      install(handler: (event: IpcMainInvokeEvent, input: unknown) => unknown): void;
      remove(): void;
    } = {
      install: (handler) => ipcMain.handle('desktop:keyboard', handler),
      remove: () => ipcMain.removeHandler('desktop:keyboard'),
    },
    private readonly onRecording: (active: boolean) => void = () => {},
  ) {
    channel.install(this.request);
  }
  private readonly request = (event: IpcMainInvokeEvent, input: unknown): unknown => {
    const state = this.windows.get(event.sender.id);
    if (
      this.closed ||
      !state ||
      state.window.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame ||
      !isApplicationDocument(event.senderFrame.url)
    )
      throw Error('KEYBOARD_SENDER_FORBIDDEN');
    const request = parseKeyboardRequest(input);
    if (request.type === 'window-state') {
      if (request.generation !== this.generation()) throw Error('KEYBOARD_GENERATION_RETIRED');
      const window = state.window;
      return {
        minimized: window.isMinimized(),
        maximized: window.isMaximized(),
        fullScreen: desktopWindowFullscreen(window),
        focused: window.isFocused(),
        visible: window.isVisible(),
        canMinimize: window.isMinimizable(),
        canMaximize: window.isMaximizable(),
        canClose: window.isClosable(),
      };
    }
    if (request.type === 'clear') {
      this.clear(state);
      return;
    }
    if (request.type === 'window') {
      if (request.generation !== this.generation()) throw Error('KEYBOARD_GENERATION_RETIRED');
      if (request.action === 'fullscreen') toggleDesktopFullscreen(state.window);
      else if (request.action === 'minimize') {
        if (!state.window.isMinimizable()) throw Error('WINDOW_ACTION_UNAVAILABLE');
        state.window.minimize();
      } else {
        if (!state.window.isMaximizable()) throw Error('WINDOW_ACTION_UNAVAILABLE');
        if (state.window.isMaximized()) state.window.unmaximize();
        else state.window.maximize();
      }
      return;
    }
    if (request.type === 'configure') {
      if (request.generation !== this.generation()) throw Error('KEYBOARD_GENERATION_RETIRED');
      if (
        state.generation === request.generation &&
        state.snapshot &&
        request.snapshot.sequence < state.snapshot.sequence
      )
        throw Error('KEYBOARD_REVISION_STALE');
      state.generation = request.generation;
      state.snapshot = request.snapshot;
      state.definitions = request.definitions;
      state.keys = new Set(
        effectiveShortcuts(
          request.definitions,
          request.snapshot.document,
          'desktop',
          this.platform,
        ).flatMap((row) =>
          row.binding && row.issue === null && row.conflicts.length === 0
            ? [bindingKey(row.binding)]
            : [],
        ),
      );
      state.reset();
      return;
    }
    if (request.type === 'recording') {
      state.recording = request.active;
      this.onRecording([...this.windows.values()].some((value) => value.recording));
      state.reset();
      state.window.webContents.setIgnoreMenuShortcuts(request.active);
      return;
    }
    if (
      request.revision !== state.snapshot?.revision ||
      state.generation !== this.generation() ||
      state.recording ||
      !state.window.isFocused() ||
      !state.window.isEnabled()
    )
      throw Error('KEYBOARD_REVISION_STALE');
    if (!state.window.isClosable()) throw Error('WINDOW_ACTION_UNAVAILABLE');
    state.window.close();
  };
  attach(window: BrowserWindow): void {
    if (this.closed || this.windows.has(window.webContents.id))
      throw Error('KEYBOARD_WINDOW_OWNERSHIP');
    const state: WindowKeys = {
      window,
      definitions: [],
      keys: new Set(),
      recording: false,
      guests: new Set(),
      guestResets: new Set(),
      reset: () => {},
      dispose: () => {},
    };
    const id = window.webContents.id;
    this.windows.set(id, state);
    const off = this.attachInput(state, window.webContents);
    const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) this.clear(state);
    };
    const closed = () => {
      state.dispose();
      this.windows.delete(id);
    };
    state.dispose = () => {
      off();
      for (const dispose of [...state.guests]) dispose();
      window.webContents.off('did-start-navigation', navigation);
      window.off('closed', closed);
      this.clear(state);
    };
    window.webContents.on('did-start-navigation', navigation);
    window.once('closed', closed);
  }
  attachGuest(
    window: BrowserWindow,
    contents: WebContents,
    id: string,
    visible: () => boolean,
  ): () => void {
    const state = this.windows.get(window.webContents.id);
    if (!state || state.window !== window || state.guests.size >= 8)
      throw Error('KEYBOARD_GUEST_OWNERSHIP');
    const off = this.attachInput(state, contents, { id, visible });
    let active = true;
    const dispose = () => {
      if (!active) return;
      active = false;
      off();
      contents.off('destroyed', dispose);
      state.guests.delete(dispose);
    };
    state.guests.add(dispose);
    contents.once('destroyed', dispose);
    return dispose;
  }
  private clear(state: WindowKeys): void {
    delete state.generation;
    delete state.snapshot;
    state.definitions = [];
    state.keys.clear();
    state.recording = false;
    this.onRecording([...this.windows.values()].some((value) => value.recording));
    state.reset();
  }
  private attachInput(
    state: WindowKeys,
    contents: WebContents,
    guest?: { id: string; visible(): boolean },
  ): () => void {
    const window = state.window,
      scopedDesktop = this.platform === 'macos' || this.platform === 'windows';
    let deadKey = false,
      revision: ShortcutRevision | undefined,
      inputFrame: typeof contents.focusedFrame = null;
    const held = new Set<string>(),
      consumed = new Map<string, 'press' | 'repeat'>();
    const reset = () => {
      deadKey = false;
      held.clear();
      consumed.clear();
      inputFrame = null;
      revision = undefined;
      if (!contents.isDestroyed()) contents.setIgnoreMenuShortcuts(state.recording);
    };
    if (guest) state.guestResets.add(reset);
    else
      state.reset = () => {
        reset();
        for (const resetGuest of state.guestResets) resetGuest();
      };
    const beforeInput = (event: Electron.Event, input: Input) => {
      if (
        event.defaultPrevented ||
        (guest !== undefined && (!guest.visible() || !contents.isFocused())) ||
        state.generation !== this.generation() ||
        !state.snapshot ||
        !window.isFocused() ||
        !window.isEnabled()
      ) {
        reset();
        return;
      }
      const modifiers = (['control', 'alt', 'shift', 'meta'] as const).filter(
        (modifier) => input[modifier],
      );
      const key = bindingKey({ code: input.code, modifiers }),
        match = state.keys.has(key);
      contents.setIgnoreMenuShortcuts(state.recording || match);
      const frame = contents.focusedFrame,
        composing =
          input.isComposing || input.key === 'Dead' || deadKey || input.modifiers.includes('altgr');
      if (input.type === 'keyDown') deadKey = input.key === 'Dead';
      if (state.recording || composing || !frame) {
        held.clear();
        consumed.clear();
        return;
      }
      let binding: NormalizedBinding = { code: input.code, modifiers },
        priority = false;
      if (scopedDesktop) {
        if (frame !== inputFrame || revision !== state.snapshot.revision) {
          held.clear();
          inputFrame = frame;
          revision = state.snapshot.revision;
        }
        const modifier = /^(Control|Alt|Shift|Meta)(Left|Right)$/u.test(input.code);
        if (input.type === 'keyUp') {
          if (consumed.get(input.code) === 'press') event.preventDefault();
          consumed.delete(input.code);
          held.delete(input.code);
          if (modifier) held.clear();
          return;
        }
        if (!input.isAutoRepeat) consumed.delete(input.code);
        if (modifier) {
          held.clear();
          return;
        }
        if (input.isAutoRepeat && consumed.has(input.code) && !match) {
          event.preventDefault();
          return;
        }
        if (input.isAutoRepeat && !held.has(input.code) && !match) return;
        held.add(input.code);
        const codes = [input.code, ...[...held].filter((value) => value !== input.code)].sort();
        const pair = {
          code: codes[0]!,
          ...(codes[1] === undefined ? {} : { secondCode: codes[1] }),
          modifiers,
        };
        priority = match;
        if (codes.length === 2 && state.keys.has(bindingKey(pair))) {
          binding = pair;
          priority = true;
        }
      }
      const main = !guest && frame === contents.mainFrame;
      if (!priority && (main || !match)) return;
      event.preventDefault();
      if (input.type !== 'keyDown') return;
      if (scopedDesktop) {
        if (!input.isAutoRepeat) {
          if (binding.secondCode) {
            consumed.set(binding.code, 'repeat');
            consumed.set(binding.secondCode, 'repeat');
          }
          consumed.set(input.code, 'press');
        }
        held.clear();
      }
      let embedding = frame;
      while (!main && embedding.parent && embedding.parent !== contents.mainFrame)
        embedding = embedding.parent;
      window.webContents.send('desktop:keyboard-input', {
        kind: guest ? 'webview' : main ? 'keyboard' : 'iframe',
        revision: state.snapshot.revision,
        frameName: guest?.id ?? (main ? '' : embedding.name),
        code: binding.code,
        ...(binding.secondCode ? { secondCode: binding.secondCode } : {}),
        repeat: input.isAutoRepeat,
        control: input.control,
        alt: input.alt,
        shift: input.shift,
        meta: input.meta,
      });
    };
    contents.on('before-input-event', beforeInput);
    contents.on('blur', reset);
    window.on('blur', reset);
    return () => {
      if (guest) state.guestResets.delete(reset);
      contents.off('before-input-event', beforeInput);
      contents.off('blur', reset);
      window.off('blur', reset);
      reset();
    };
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.remove();
    for (const state of this.windows.values()) state.dispose();
    this.windows.clear();
  }
}
