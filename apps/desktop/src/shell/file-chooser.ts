import { app, type BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { NativeError, type NativeFileChooser } from '@axterm/infra-desktop-native';
import { panelId, parsePanelFrame, type PanelKind } from './native-panel-protocol.ts';
interface Panel {
  readonly child: ChildProcess;
  readonly done: Promise<void>;
  readonly terminate: () => void;
  ready: boolean;
}
/** The shell owns panel processes until their actual exit, including cancellation. */
export class ElectronFileChooser implements NativeFileChooser {
  private readonly panels = new Set<Panel>();
  private active = true;
  constructor(private readonly owner: () => BrowserWindow | undefined) {}
  defaultDirectory(kind: 'home' | 'downloads'): string {
    return app.getPath(kind);
  }
  inspection(): { pending: number; ready: number } {
    return {
      pending: this.panels.size,
      ready: [...this.panels].filter((panel) => panel.ready).length,
    };
  }
  async choose(kind: PanelKind, signal: AbortSignal): Promise<string | undefined> {
    if (!this.active) throw new NativeError('CLOSED');
    signal.throwIfAborted();
    const parent = this.owner();
    if (!parent || parent.isDestroyed()) throw new NativeError('UNAVAILABLE');
    if (this.panels.size) throw new NativeError('LIMIT');
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      process.execPath,
      app.isPackaged ? ['--axterm-native-panel'] : [join(import.meta.dirname, 'native-panel.js')],
      {
        env: environment,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
      },
    );
    child.stderr?.resume();
    const exited = Promise.withResolvers<void>();
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let ending = false;
    const terminate = () => {
      if (ending) return;
      ending = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          child.kill('SIGKILL');
        }, 1000);
      }
    };
    const panel: Panel = { child, done: exited.promise, terminate, ready: false };
    this.panels.add(panel);
    let selected: string | undefined;
    let received = false;
    let failed = false;
    const id = panelId();
    const retire = () => {
      failed = true;
      terminate();
    };
    const message = (value: unknown) => {
      try {
        const frame = parsePanelFrame(value);
        if (
          frame.id !== id ||
          received ||
          frame.type === 'select' ||
          (frame.type === 'ready' && panel.ready)
        )
          throw new NativeError('PROTOCOL');
        if (frame.type === 'ready') panel.ready = true;
        else {
          if (!panel.ready) throw new NativeError('PROTOCOL');
          received = true;
          selected = frame.path ?? undefined;
          clearTimeout(deadline);
          deadline = setTimeout(retire, 1000);
        }
      } catch {
        failed = true;
        terminate();
      }
    };
    child.on('message', message);
    child.once('error', retire);
    child.once('close', (code) => {
      if (code !== 0) failed = true;
      clearTimeout(killTimer);
      exited.resolve();
    });
    child.once('disconnect', () => {
      if (!received) retire();
    });
    signal.addEventListener('abort', retire, { once: true });
    let deadline = setTimeout(retire, 300_000);
    try {
      if (signal.aborted) retire();
      if (!ending)
        child.send(
          { kind: 'axterm-native-panel', version: 1, id, type: 'select', selection: kind },
          (error) => {
            if (error) retire();
          },
        );
      await exited.promise;
      signal.throwIfAborted();
      if (!this.active) throw new NativeError('CLOSED');
      if (failed || !received) throw new NativeError('FAILED');
      return selected;
    } finally {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', retire);
      child.removeListener('message', message);
      this.panels.delete(panel);
    }
  }
  async retire(): Promise<void> {
    this.active = false;
    const pending = [...this.panels];
    for (const panel of pending) panel.terminate();
    await Promise.all(pending.map((panel) => panel.done));
  }
}
