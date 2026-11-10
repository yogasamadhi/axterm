import type {
  CatalogQueries,
  TerminalApplication,
  TerminalChannel,
  OpenBookmarkTerminalInput,
} from '@axterm/plugin-api/host';
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_BEHAVIOR,
  openBookmarkTerminalSchema,
  type SerialPortInfo,
  type TerminalSession,
} from '@axterm/plugin-api/connections';
import type { CredentialAccess } from '../ports/credentials.ts';
import type { SerialTransport } from '../ports/serial-transport.ts';
import type { TelnetTransport } from '../ports/telnet-transport.ts';
import { ApplicationError } from './errors.ts';

interface OwnedTerminal {
  id: string;
  disposeExit(): void;
  closing?: Promise<void>;
}
/** Connections owns protocol opening and lifetime; Terminals alone owns bytes and sessions. */
export class PlainTerminals {
  private accepting = true;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly owned = new Map<string, OwnedTerminal>();
  private closing: Promise<void> | undefined;
  private failed = false;
  constructor(
    private readonly catalog: Pick<CatalogQueries, 'getBookmark' | 'getConnectionProfile'>,
    private readonly credentials: Pick<CredentialAccess, 'resolveCredential'>,
    private readonly serial: SerialTransport,
    private readonly telnet: TelnetTransport,
    private readonly terminals: Pick<TerminalApplication, 'registerExternal' | 'close'>,
  ) {}

  async listPorts(): Promise<SerialPortInfo[]> {
    this.assertOpen();
    try {
      const result = await this.serial.list();
      this.assertOpen();
      return result;
    } catch {
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Serial port enumeration is unavailable',
        503,
      );
    }
  }

  open(input: OpenBookmarkTerminalInput, signal?: AbortSignal): Promise<TerminalSession> {
    this.assertOpen();
    if (this.pending.size + this.owned.size >= 32)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'Protocol terminal capacity exceeded', 503);
    const lifetime = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    lifetime.throwIfAborted();
    const task = Promise.resolve().then(() =>
      this.openOwned(openBookmarkTerminalSchema.parse(input), lifetime),
    );
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  private async openOwned(
    input: OpenBookmarkTerminalInput,
    signal: AbortSignal,
  ): Promise<TerminalSession> {
    signal.throwIfAborted();
    const bookmark = this.catalog.getBookmark(input.bookmarkId);
    if (bookmark.protocol !== input.kind)
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'Bookmark protocol does not match the terminal',
        400,
      );
    let channel: TerminalChannel | undefined;
    let owned: OwnedTerminal | undefined;
    try {
      const appearance = { ...(input.appearance ?? DEFAULT_TERMINAL_APPEARANCE) };
      const behavior = { ...(input.behavior ?? DEFAULT_TERMINAL_BEHAVIOR) };
      if (input.kind === 'serial') {
        if (!bookmark.serial)
          throw new ApplicationError('VALIDATION_ERROR', 'Serial destination is missing', 400);
        behavior.encoding = bookmark.serial.encoding;
        channel = await this.serial.open({ ...bookmark.serial, signal });
      } else {
        if (!bookmark.telnet)
          throw new ApplicationError('VALIDATION_ERROR', 'Telnet destination is missing', 400);
        const profile = bookmark.connectionProfileId
          ? this.catalog.getConnectionProfile(bookmark.connectionProfileId).telnet
          : undefined;
        const ref = profile?.passwordCredentialRef ?? bookmark.telnet.credentialRef;
        const password = ref ? await this.credentials.resolveCredential(ref, signal) : undefined;
        signal.throwIfAborted();
        behavior.encoding = bookmark.telnet.encoding;
        channel = await this.telnet.connect({
          host: bookmark.telnet.hostname,
          port: bookmark.telnet.port,
          username: profile?.username ?? bookmark.telnet.username,
          ...(password === undefined ? {} : { password }),
          loginPrompt: prompt(bookmark.telnet.loginPrompt),
          passwordPrompt: prompt(bookmark.telnet.passwordPrompt),
          encoding: bookmark.telnet.encoding,
          cols: input.cols,
          rows: input.rows,
          timeoutMs: bookmark.telnet.connectionTimeoutMs,
          signal,
        });
      }
      signal.throwIfAborted();
      this.assertOpen();
      const metadata = this.terminals.registerExternal(
        {
          kind: input.kind,
          title: bookmark.title,
          state: 'ready',
          bookmarkId: bookmark.id,
          ...(input.profileId ? { profileId: input.profileId } : {}),
          appearance,
          behavior,
          createdAt: new Date().toISOString(),
        },
        channel,
        'unsupported',
      );
      owned = { id: metadata.id, disposeExit: () => {} };
      this.owned.set(metadata.id, owned);
      const current = owned;
      current.disposeExit = channel.onExit(() => {
        void this.release(current).catch(() => {});
      });
      return metadata;
    } catch (error) {
      if (owned) await this.release(owned);
      else if (channel) {
        try {
          await channel.close();
        } catch {
          this.failed = true;
        }
      }
      if (signal.aborted)
        throw new ApplicationError('REQUEST_CANCELED', 'Protocol terminal creation was canceled');
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        input.kind === 'serial' ? 'SERIAL_CONNECTION_FAILED' : 'TELNET_CONNECTION_FAILED',
        'Protocol terminal creation failed',
        503,
      );
    }
  }
  resourceCount(): number {
    return (
      this.pending.size +
      this.owned.size +
      (this.serial.resourceCount?.() ?? 0) +
      (this.failed ? 1 : 0)
    );
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.accepting = false;
    this.lifetime.abort();
    return (this.closing = (async () => {
      await Promise.allSettled([...this.pending]);
      const closed = await Promise.allSettled(
        [...this.owned.values()].map((value) => this.release(value)),
      );
      await this.serial.close?.();
      if (
        this.failed ||
        this.owned.size ||
        this.serial.resourceCount?.() ||
        closed.some((value) => value.status === 'rejected')
      )
        throw new ApplicationError('INVALID_STATE', 'Protocol terminals did not drain');
    })());
  }
  private release(value: OwnedTerminal): Promise<void> {
    return (value.closing ??= (async () => {
      await this.terminals.close(value.id);
      value.disposeExit();
      this.owned.delete(value.id);
    })());
  }
  private assertOpen(): void {
    if (!this.accepting)
      throw new ApplicationError('INVALID_STATE', 'Protocol terminals are closed');
  }
}
function prompt(value: string): RegExp {
  const delimited = value.match(/^\/(.+)\/([gimsuy]*)$/);
  return delimited ? new RegExp(delimited[1]!, delimited[2]) : new RegExp(value, 'i');
}
