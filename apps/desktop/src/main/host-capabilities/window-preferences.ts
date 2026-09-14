import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  desktopWindowBoundsSchema,
  desktopWindowPreferencesPatchSchema,
  desktopWindowPreferencesSchema,
  type DesktopWindowBounds,
  type DesktopWindowPreferences,
  type DesktopWindowPreferencesPatch,
} from '@workspace/contracts/desktop';

const FILE_NAME = 'window-preferences.json';
interface PersistedWindowPreferences {
  version: 1;
  preferences: DesktopWindowPreferences;
}

export const DEFAULT_DESKTOP_WINDOW_PREFERENCES: Readonly<DesktopWindowPreferences> = Object.freeze(
  {
    titleBarStyle: 'custom',
    opacity: 1,
    zoomFactor: 1,
    bounds: null,
    globalHotkey: 'Control+2',
    allowMultiInstance: false,
    confirmBeforeExit: false,
  },
);

export const DEFAULT_DESKTOP_WINDOW_SIZE = Object.freeze({ width: 1440, height: 900 });

export interface DesktopDisplay {
  workArea: DesktopWindowBounds;
}

export interface DesktopDisplayLayout {
  displays: readonly DesktopDisplay[];
  primary: DesktopDisplay;
}

export interface WindowPreferencesPort {
  get(): DesktopWindowPreferences;
  update(patch: DesktopWindowPreferencesPatch): Promise<DesktopWindowPreferences>;
}

/** Reads only the preferences needed before Electron acquires its instance lock. */
export function readWindowLaunchPreferences(directory: string): DesktopWindowPreferences {
  try {
    return clonePreferences(
      parsePersistedWindowPreferences(JSON.parse(readFileSync(join(directory, FILE_NAME), 'utf8')))
        .preferences,
    );
  } catch {
    return clonePreferences(DEFAULT_DESKTOP_WINDOW_PREFERENCES);
  }
}

/** App-local, non-secret desktop preferences with strict parsing and atomic replacement. */
export class WindowPreferencesStore implements WindowPreferencesPort {
  readonly filePath: string;
  private current: DesktopWindowPreferences = clonePreferences(DEFAULT_DESKTOP_WINDOW_PREFERENCES);
  private loaded = false;
  private opening: Promise<void> | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {
    this.filePath = join(directory, FILE_NAME);
  }

  async open(): Promise<void> {
    if (this.loaded) return;
    this.opening ??= this.load();
    await this.opening;
  }

  get(): DesktopWindowPreferences {
    if (!this.loaded) throw new Error('Window preferences are not open');
    return clonePreferences(this.current);
  }

  async update(patch: DesktopWindowPreferencesPatch): Promise<DesktopWindowPreferences> {
    const checkedPatch = desktopWindowPreferencesPatchSchema.parse(patch);
    await this.open();
    let result: DesktopWindowPreferences | undefined;
    await this.enqueueWrite(async () => {
      const next = desktopWindowPreferencesSchema.parse({ ...this.current, ...checkedPatch });
      await this.writeAtomic(next);
      this.current = next;
      result = clonePreferences(next);
    });
    return result!;
  }

  private async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let input: string;
    try {
      input = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.current = clonePreferences(DEFAULT_DESKTOP_WINDOW_PREFERENCES);
      this.loaded = true;
      return;
    }
    try {
      this.current = parsePersistedWindowPreferences(JSON.parse(input)).preferences;
    } catch {
      await this.quarantineCorruptFile();
      this.current = clonePreferences(DEFAULT_DESKTOP_WINDOW_PREFERENCES);
    }
    this.loaded = true;
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const result = this.writes.then(operation, operation);
    this.writes = result.catch(() => undefined);
    return result;
  }

  private async writeAtomic(preferences: DesktopWindowPreferences): Promise<void> {
    const temporary = join(
      this.directory,
      `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(
          `${JSON.stringify({ version: 1, preferences } satisfies PersistedWindowPreferences)}\n`,
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.filePath);
      await syncDirectory(this.directory);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async quarantineCorruptFile(): Promise<void> {
    const quarantine = `${this.filePath}.corrupt-${Date.now()}-${randomUUID()}`;
    await rename(this.filePath, quarantine).catch(() => undefined);
  }
}

/** Keeps restored bounds wholly inside a current display, centering disconnected displays. */
export function correctWindowBounds(
  saved: DesktopWindowBounds,
  layout: DesktopDisplayLayout,
  minimum = { width: 800, height: 580 },
): DesktopWindowBounds {
  const checked = desktopWindowBoundsSchema.parse(saved);
  const displays = layout.displays.length > 0 ? layout.displays : [layout.primary];
  const center = {
    x: checked.x + Math.floor(checked.width / 2),
    y: checked.y + Math.floor(checked.height / 2),
  };
  const centerDisplay = displays.find((display) => contains(display.workArea, center));
  const intersectingDisplay = displays
    .map((display) => ({ display, area: intersectionArea(checked, display.workArea) }))
    .sort((left, right) => right.area - left.area)[0];
  const target =
    centerDisplay ??
    (intersectingDisplay && intersectingDisplay.area > 0
      ? intersectingDisplay.display
      : layout.primary);
  const area = desktopWindowBoundsSchema.parse(target.workArea);
  const width = Math.min(Math.max(checked.width, Math.min(minimum.width, area.width)), area.width);
  const height = Math.min(
    Math.max(checked.height, Math.min(minimum.height, area.height)),
    area.height,
  );
  const wasDisconnected =
    !centerDisplay && (!intersectingDisplay || intersectingDisplay.area === 0);
  const x = wasDisconnected
    ? area.x + Math.floor((area.width - width) / 2)
    : clamp(checked.x, area.x, area.x + area.width - width);
  const y = wasDisconnected
    ? area.y + Math.floor((area.height - height) / 2)
    : clamp(checked.y, area.y, area.y + area.height - height);
  return desktopWindowBoundsSchema.parse({ x, y, width, height });
}

interface BoundsWindow {
  getNormalBounds(): DesktopWindowBounds;
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  isMaximized(): boolean;
  on(event: 'move' | 'resize', listener: () => void): unknown;
  off(event: 'move' | 'resize', listener: () => void): unknown;
}

/** Leading/trailing throttle for move/resize persistence with deterministic cleanup. */
export class WindowBoundsPersistence {
  private pending: DesktopWindowBounds | undefined;
  private lastQueued: DesktopWindowBounds | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastWriteStartedAt = Number.NEGATIVE_INFINITY;
  private writes: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly capture = () => this.captureCurrentBounds();

  constructor(
    private readonly target: BoundsWindow,
    private readonly persist: (bounds: DesktopWindowBounds) => Promise<unknown>,
    private readonly throttleMs = 250,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    target.on('move', this.capture);
    target.on('resize', this.capture);
  }

  async flush(): Promise<void> {
    if (!this.disposed) this.readCurrentBounds();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending) this.startWrite();
    await this.writes;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return this.writes;
    this.target.off('move', this.capture);
    this.target.off('resize', this.capture);
    if (!this.target.isDestroyed()) this.readCurrentBounds();
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending) this.startWrite();
    await this.writes;
  }

  private captureCurrentBounds(): void {
    if (this.disposed || !this.readCurrentBounds()) return;
    const remaining = this.lastWriteStartedAt + this.throttleMs - Date.now();
    if (remaining <= 0) {
      this.startWrite();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.pending) this.startWrite();
      }, remaining);
    }
  }

  private readCurrentBounds(): boolean {
    if (this.target.isDestroyed() || this.target.isMaximized() || this.target.isFullScreen())
      return false;
    this.pending = desktopWindowBoundsSchema.parse(this.target.getNormalBounds());
    return true;
  }

  private startWrite(): void {
    const bounds = this.pending;
    if (!bounds) return;
    this.pending = undefined;
    if (this.lastQueued && sameBounds(this.lastQueued, bounds)) return;
    this.lastQueued = bounds;
    this.lastWriteStartedAt = Date.now();
    this.writes = this.writes
      .then(() => this.persist(bounds))
      .then(
        () => undefined,
        (error) => {
          if (this.lastQueued && sameBounds(this.lastQueued, bounds)) this.lastQueued = undefined;
          this.onError(error);
        },
      );
  }
}

function clonePreferences(value: Readonly<DesktopWindowPreferences>): DesktopWindowPreferences {
  return {
    ...value,
    bounds: value.bounds ? { ...value.bounds } : null,
  };
}

function contains(bounds: DesktopWindowBounds, point: { x: number; y: number }): boolean {
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  );
}

function intersectionArea(left: DesktopWindowBounds, right: DesktopWindowBounds): number {
  return (
    Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)) *
    Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function sameBounds(left: DesktopWindowBounds, right: DesktopWindowBounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function parsePersistedWindowPreferences(input: unknown): PersistedWindowPreferences {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 2 ||
    !('version' in input) ||
    input.version !== 1 ||
    !('preferences' in input)
  )
    throw new SyntaxError('Invalid window preferences document');
  return {
    version: 1,
    preferences: desktopWindowPreferencesSchema.parse(input.preferences),
  };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r').catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
}
