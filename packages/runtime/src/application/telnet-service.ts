import { randomUUID } from 'node:crypto';
import type { TerminalAppearance, TerminalBehavior, TerminalSession } from '@workspace/contracts';
import { DEFAULT_TERMINAL_APPEARANCE, DEFAULT_TERMINAL_BEHAVIOR } from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type { TelnetTransport } from '../ports/telnet-transport';
import type { BookmarkTreeService } from './bookmark-tree-service';
import type { ConnectionProfileService } from './connection-profile-service';
import { ApplicationError } from './errors';
import type { TerminalService } from './terminal-service';

export class TelnetService {
  constructor(
    private readonly bookmarks: BookmarkTreeService,
    private readonly profiles: ConnectionProfileService,
    private readonly host: HostCapabilityClient | undefined,
    private readonly transport: TelnetTransport,
    private readonly terminals: TerminalService,
  ) {}

  async open(input: {
    bookmarkId: string;
    profileId?: string;
    cols: number;
    rows: number;
    appearance?: TerminalAppearance;
    behavior?: TerminalBehavior;
    signal?: AbortSignal;
  }): Promise<TerminalSession> {
    const bookmark = this.bookmarks.getBookmark(input.bookmarkId);
    if (bookmark.protocol !== 'telnet' || !bookmark.telnet)
      throw new ApplicationError('VALIDATION_ERROR', 'Bookmark is not a Telnet destination', 400);
    const profile = bookmark.connectionProfileId
      ? this.profiles.get(bookmark.connectionProfileId).telnet
      : undefined;
    const username = profile?.username ?? bookmark.telnet.username;
    const credentialRef = profile?.passwordCredentialRef ?? bookmark.telnet.credentialRef;
    const password = credentialRef
      ? await this.requireHost().resolveCredential(credentialRef)
      : undefined;
    let channel;
    try {
      channel = await this.transport.connect({
        host: bookmark.telnet.hostname,
        port: bookmark.telnet.port,
        username,
        ...(password === undefined ? {} : { password }),
        loginPrompt: parseTelnetPrompt(bookmark.telnet.loginPrompt),
        passwordPrompt: parseTelnetPrompt(bookmark.telnet.passwordPrompt),
        encoding: bookmark.telnet.encoding,
        cols: input.cols,
        rows: input.rows,
        timeoutMs: bookmark.telnet.connectionTimeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch {
      throw new ApplicationError('TELNET_CONNECTION_FAILED', 'Telnet connection failed', 503);
    }
    const metadata: TerminalSession = {
      id: randomUUID(),
      kind: 'telnet',
      title: bookmark.title,
      state: 'ready',
      bookmarkId: bookmark.id,
      ...(input.profileId ? { profileId: input.profileId } : {}),
      appearance: { ...(input.appearance ?? DEFAULT_TERMINAL_APPEARANCE) },
      behavior: {
        ...(input.behavior ?? DEFAULT_TERMINAL_BEHAVIOR),
        encoding: bookmark.telnet.encoding,
      },
      createdAt: new Date().toISOString(),
    };
    return this.terminals.registerExternal(metadata, channel, 'unsupported');
  }

  private requireHost(): HostCapabilityClient {
    if (!this.host)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Local credential storage is unavailable',
        503,
      );
    return this.host;
  }
}

function parseTelnetPrompt(value: string): RegExp {
  const delimited = value.match(/^\/(.+)\/([gimsuy]*)$/);
  return delimited ? new RegExp(delimited[1]!, delimited[2]) : new RegExp(value, 'i');
}
