import {
  desktopWindowFullscreen,
  toggleDesktopFullscreen,
} from '../../apps/desktop/src/shell/fullscreen.ts';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';
import { initialShortcutConfig, type ShortcutCommandId } from '@axterm/plugin-api/shortcuts';
const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => void>(),
}));
vi.mock('electron', () => {
  const ipcMain = {
    handle: (name: string, handler: (event: unknown, input: unknown) => void) => {
      fixture.handlers.set(name, handler);
    },
    removeHandler: (name: string) => {
      fixture.handlers.delete(name);
    },
  };
  return { ipcMain, default: { ipcMain } };
});
import { DesktopKeyboardBridge } from '../../apps/desktop/src/shell/keyboard.ts';
beforeEach(() => fixture.handlers.clear());
const channel = {
  install: (handler: (event: IpcMainInvokeEvent, input: unknown) => void) => {
    fixture.handlers.set('desktop:keyboard', (event, input) =>
      handler(event as IpcMainInvokeEvent, input),
    );
  },
  remove: () => {
    fixture.handlers.delete('desktop:keyboard');
  },
};

function windowFixture(id: number) {
  const mainFrame = { url: 'axterm-app://app/', name: '', parent: null },
    contents = Object.assign(new EventEmitter(), {
      id,
      mainFrame,
      focusedFrame: mainFrame,
      isDestroyed: () => false,
      isFocused: () => true,
      send: vi.fn(),
      setIgnoreMenuShortcuts: vi.fn(),
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
    });
  let focused = true;
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
    isFocused: () => focused,
    isEnabled: () => true,
    close: vi.fn(),
    isFullScreen: () => false,
    setFullScreen: vi.fn(),
    isMinimized: () => false,
    isMaximized: () => false,
    isVisible: () => true,
    isMinimizable: () => true,
    isMaximizable: () => true,
    isClosable: () => true,
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
  });
  // Electron test doubles exercise the real shell owner; no platform focus or OS permission is simulated as native acceptance.
  return {
    window: window as unknown as BrowserWindow,
    contents,
    focus: (value: boolean) => {
      focused = value;
    },
    event: { sender: contents, senderFrame: mainFrame },
  };
}
const definitions = [
  {
    id: 'test.one' as ShortcutCommandId,
    defaults: {
      'desktop:macos': { code: 'KeyQ', modifiers: ['alt' as const] },
      'desktop:windows': { code: 'KeyQ', modifiers: ['alt' as const] },
      'desktop:linux': { code: 'KeyQ', modifiers: ['alt' as const] },
    },
  },
];
it('isolates native routing to the owning focused window and clears it on navigation', () => {
  const generation = crypto.randomUUID(),
    bridge = new DesktopKeyboardBridge(() => generation, channel),
    first = windowFixture(1),
    second = windowFixture(2);
  bridge.attach(first.window);
  bridge.attach(second.window);
  const request = fixture.handlers.get('desktop:keyboard')!,
    snapshot = { ...initialShortcutConfig(), status: 'ready' as const };
  request(first.event, { type: 'configure', generation, definitions, snapshot });
  const key = {
    type: 'keyDown',
    key: 'q',
    code: 'KeyQ',
    alt: true,
    control: false,
    meta: false,
    shift: false,
    isAutoRepeat: false,
    isComposing: false,
    modifiers: ['alt'],
  };
  const event = () => ({ defaultPrevented: false, preventDefault: vi.fn() });
  first.contents.emit('before-input-event', event(), key);
  second.contents.emit('before-input-event', event(), key);
  expect(second.contents.send).not.toHaveBeenCalled();
  expect(first.contents.send).toHaveBeenCalledTimes(process.platform === 'linux' ? 0 : 1);
  first.focus(false);
  first.contents.emit('before-input-event', event(), key);
  expect(first.contents.send).toHaveBeenCalledTimes(process.platform === 'linux' ? 0 : 1);
  first.focus(true);
  first.contents.emit('did-start-navigation', {}, 'axterm-app://app/', false, true);
  first.contents.emit('before-input-event', event(), key);
  expect(first.contents.send).toHaveBeenCalledTimes(process.platform === 'linux' ? 0 : 1);
  bridge.dispose();
  expect(fixture.handlers.size).toBe(0);
  expect(first.contents.listenerCount('before-input-event')).toBe(0);
  expect(second.contents.listenerCount('before-input-event')).toBe(0);
});
it('rejects foreign frames, retired generations and stale window-close revisions', () => {
  let generation = crypto.randomUUID();
  const bridge = new DesktopKeyboardBridge(() => generation, channel),
    first = windowFixture(1);
  bridge.attach(first.window);
  const request = fixture.handlers.get('desktop:keyboard')!,
    snapshot = { ...initialShortcutConfig(), status: 'ready' as const };
  expect(() =>
    request({ ...first.event, senderFrame: { url: 'axterm-app://app/' } }, { type: 'clear' }),
  ).toThrow('SENDER_FORBIDDEN');
  request(first.event, { type: 'configure', generation, definitions, snapshot });
  expect(() => request(first.event, { type: 'close', revision: crypto.randomUUID() })).toThrow(
    'STALE',
  );
  request(first.event, { type: 'close', revision: snapshot.revision });
  expect(first.window.close).toHaveBeenCalledOnce();
  const retired = generation;
  generation = crypto.randomUUID();
  expect(() =>
    request(first.event, { type: 'configure', generation: retired, definitions, snapshot }),
  ).toThrow('RETIRED');
  expect(() =>
    request(first.event, { type: 'window', generation: retired, action: 'fullscreen' }),
  ).toThrow('RETIRED');
  bridge.dispose();
});

it('forwards only an owned visible focused guest and releases its exact input registration', () => {
  const generation = crypto.randomUUID(),
    bridge = new DesktopKeyboardBridge(() => generation, channel),
    first = windowFixture(1),
    guest = windowFixture(2);
  bridge.attach(first.window);
  fixture.handlers.get('desktop:keyboard')!(first.event, {
    type: 'configure',
    generation,
    definitions,
    snapshot: { ...initialShortcutConfig(), status: 'ready' },
  });
  let visible = true;
  const release = bridge.attachGuest(
    first.window,
    guest.contents as unknown as WebContents,
    'owned-view',
    () => visible,
  );
  const key = {
    type: 'keyDown',
    key: 'q',
    code: 'KeyQ',
    alt: true,
    control: false,
    meta: false,
    shift: false,
    isAutoRepeat: false,
    isComposing: false,
    modifiers: ['alt'],
  };
  const event = () => ({ defaultPrevented: false, preventDefault: vi.fn() });
  guest.contents.emit('before-input-event', event(), key);
  expect(first.contents.send).toHaveBeenCalledWith(
    'desktop:keyboard-input',
    expect.objectContaining({ kind: 'webview', frameName: 'owned-view' }),
  );
  visible = false;
  guest.contents.emit('before-input-event', event(), key);
  expect(first.contents.send).toHaveBeenCalledOnce();
  release();
  release();
  expect(guest.contents.listenerCount('before-input-event')).toBe(0);
  bridge.dispose();
});
it('reads and controls only its exact owning window and rejects retired presentation requests', () => {
  const generation = crypto.randomUUID(),
    bridge = new DesktopKeyboardBridge(() => generation, channel),
    first = windowFixture(11),
    second = windowFixture(12);
  bridge.attach(first.window);
  bridge.attach(second.window);
  const request = fixture.handlers.get('desktop:keyboard')!;
  expect(request(first.event, { type: 'window-state', generation })).toEqual({
    minimized: false,
    maximized: false,
    fullScreen: false,
    focused: true,
    visible: true,
    canMinimize: true,
    canMaximize: true,
    canClose: true,
  });
  request(first.event, { type: 'window', generation, action: 'minimize' });
  expect(first.window.minimize).toHaveBeenCalledOnce();
  expect(second.window.minimize).not.toHaveBeenCalled();
  request(first.event, { type: 'window', generation, action: 'toggle-maximize' });
  expect(first.window.maximize).toHaveBeenCalledOnce();
  first.window.isMaximized = () => true;
  request(first.event, { type: 'window', generation, action: 'toggle-maximize' });
  expect(first.window.unmaximize).toHaveBeenCalledOnce();
  first.window.isMinimizable = () => false;
  expect(() => request(first.event, { type: 'window', generation, action: 'minimize' })).toThrow(
    'UNAVAILABLE',
  );
  first.window.isMaximizable = () => false;
  expect(() =>
    request(first.event, { type: 'window', generation, action: 'toggle-maximize' }),
  ).toThrow('UNAVAILABLE');
  expect(() =>
    request(first.event, { type: 'window-state', generation: crypto.randomUUID() }),
  ).toThrow('RETIRED');
  bridge.dispose();
});

it('retains visible simple-fullscreen state for an unfocused macOS window and exits each native mode safely', () => {
  let native = false,
    simple = false;
  const target = {
    isDestroyed: () => false,
    isFocused: () => false,
    isFullScreen: () => native,
    isSimpleFullScreen: () => simple,
    setFullScreen: vi.fn((value: boolean) => {
      native = value;
    }),
    setSimpleFullScreen: vi.fn((value: boolean) => {
      simple = value;
    }),
  };
  toggleDesktopFullscreen(target, 'darwin');
  expect(desktopWindowFullscreen(target)).toBe(true);
  expect(target.setSimpleFullScreen).toHaveBeenCalledWith(true);
  expect(target.setFullScreen).not.toHaveBeenCalled();
  toggleDesktopFullscreen(target, 'darwin');
  expect(desktopWindowFullscreen(target)).toBe(false);
  expect(target.setSimpleFullScreen).toHaveBeenLastCalledWith(false);
  native = true;
  toggleDesktopFullscreen(target, 'darwin');
  expect(native).toBe(false);
  expect(target.setFullScreen).toHaveBeenCalledWith(false);
  toggleDesktopFullscreen(target, 'linux');
  expect(native).toBe(true);
  expect(simple).toBe(false);
});
it('exposes actual simple-fullscreen through the owned bridge and refuses native-unclosable windows', () => {
  const generation = crypto.randomUUID(),
    bridge = new DesktopKeyboardBridge(() => generation, channel),
    first = windowFixture(3),
    snapshot = { ...initialShortcutConfig(), status: 'ready' as const };
  first.window.isSimpleFullScreen = () => true;
  bridge.attach(first.window);
  const request = fixture.handlers.get('desktop:keyboard')!;
  expect(request(first.event, { type: 'window-state', generation })).toMatchObject({
    fullScreen: true,
  });
  request(first.event, { type: 'configure', generation, definitions, snapshot });
  first.window.isClosable = () => false;
  expect(() => request(first.event, { type: 'close', revision: snapshot.revision })).toThrow(
    'UNAVAILABLE',
  );
  expect(first.window.close).not.toHaveBeenCalled();
  bridge.dispose();
});

it('refuses absent, destroyed and withdrawn window targets before performing native work', () => {
  const generation = crypto.randomUUID(),
    bridge = new DesktopKeyboardBridge(() => generation, channel),
    first = windowFixture(5);
  bridge.attach(first.window);
  const request = fixture.handlers.get('desktop:keyboard')!;
  expect(() =>
    request(
      { ...first.event, sender: { ...first.contents, id: 999 } },
      { type: 'window', generation, action: 'minimize' },
    ),
  ).toThrow('FORBIDDEN');
  first.window.isDestroyed = () => true;
  expect(() => request(first.event, { type: 'window-state', generation })).toThrow('FORBIDDEN');
  expect(() => request(first.event, { type: 'window', generation, action: 'minimize' })).toThrow(
    'FORBIDDEN',
  );
  expect(first.window.minimize).not.toHaveBeenCalled();
  bridge.dispose();
  expect(() => request(first.event, { type: 'window-state', generation })).toThrow('FORBIDDEN');
});
