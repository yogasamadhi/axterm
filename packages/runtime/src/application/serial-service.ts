import { randomUUID } from 'node:crypto';
import type {
  SerialPortInfo,
  TerminalAppearance,
  TerminalBehavior,
  TerminalSession,
} from '@workspace/contracts';
import { DEFAULT_TERMINAL_APPEARANCE, DEFAULT_TERMINAL_BEHAVIOR } from '@workspace/contracts';
import type { SerialTransport } from '../ports/serial-transport';
import type { BookmarkTreeService } from './bookmark-tree-service';
import { ApplicationError } from './errors';
import type { TerminalService } from './terminal-service';

export class SerialService {
  constructor(
    private readonly bookmarks: BookmarkTreeService,
    private readonly transport: SerialTransport,
    private readonly terminals: TerminalService,
  ) {}

  async listPorts(): Promise<SerialPortInfo[]> {
    try {
      return await this.transport.list();
    } catch {
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Serial port enumeration is unavailable',
        503,
      );
    }
  }

  async open(input: {
    bookmarkId: string;
    profileId?: string;
    appearance?: TerminalAppearance;
    behavior?: TerminalBehavior;
    signal?: AbortSignal;
  }): Promise<TerminalSession> {
    const bookmark = this.bookmarks.getBookmark(input.bookmarkId);
    if (bookmark.protocol !== 'serial' || !bookmark.serial)
      throw new ApplicationError('VALIDATION_ERROR', 'Bookmark is not a Serial destination', 400);
    let channel;
    try {
      channel = await this.transport.open({
        ...bookmark.serial,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch {
      throw new ApplicationError('SERIAL_CONNECTION_FAILED', 'Serial port open failed', 503);
    }
    const metadata: TerminalSession = {
      id: randomUUID(),
      kind: 'serial',
      title: bookmark.title,
      state: 'ready',
      bookmarkId: bookmark.id,
      ...(input.profileId ? { profileId: input.profileId } : {}),
      appearance: { ...(input.appearance ?? DEFAULT_TERMINAL_APPEARANCE) },
      behavior: {
        ...(input.behavior ?? DEFAULT_TERMINAL_BEHAVIOR),
        encoding: bookmark.serial.encoding,
      },
      createdAt: new Date().toISOString(),
    };
    return this.terminals.registerExternal(metadata, channel, 'unsupported');
  }
}
