import { createHash } from 'node:crypto';
import type { StorageCommandJournal } from '@axterm/plugin-api';
import * as Contract from '@axterm/plugin-api/terminals';
import type { TerminalSession } from '@axterm/plugin-api/terminals';
import type { Settings } from '@axterm/plugin-api/configuration';
import type { TerminalThemeStore } from '../ports/theme-store.ts';
import type { TerminalProfileStore, CommandHistoryStore } from '../ports/facts-store.ts';
import { TerminalThemeService } from './terminal-theme-service.ts';
import { isSensitiveCommandLine } from './command-history-policy.ts';
import { ApplicationError } from './errors.ts';

export interface TerminalFactsWork {
  transaction<T>(configuration: boolean, operation: () => T): T;
  settings(): Settings;
  terminal(id: string): TerminalSession;
  cursor(): number;
}
/** Terminal facts and receipts commit together; raw command text has one durable owner. */
export class TerminalFactsApplication {
  private readonly themes: TerminalThemeService;
  constructor(
    private readonly profiles: TerminalProfileStore,
    themes: TerminalThemeStore,
    private readonly history: CommandHistoryStore,
    private readonly journal: StorageCommandJournal,
    private readonly work: TerminalFactsWork,
  ) {
    this.themes = new TerminalThemeService(themes);
  }
  listProfiles(): Contract.TerminalProfile[] {
    return this.profiles.list();
  }
  getProfile(id: string): Contract.TerminalProfile {
    return this.profiles.get(id);
  }
  listThemes(): Contract.TerminalTheme[] {
    return this.themes.list();
  }
  listHistory(input: Contract.CommandHistoryPageQuery = {}): Contract.CommandHistoryPage {
    return this.work.transaction(false, () =>
      this.history.list(Contract.commandHistoryPageQuerySchema.parse(input)),
    );
  }
  historyState(): Contract.CommandHistoryState {
    return this.history.state();
  }
  createProfile(key: string, input: Contract.TerminalProfileInput): Contract.TerminalFactsReceipt {
    const command = Contract.terminalProfileInputSchema.parse(input);
    return this.write(key, 'terminal-profile.create', command, () => this.profiles.create(command));
  }
  updateProfile(
    key: string,
    id: string,
    input: Contract.TerminalProfilePatch,
    ifMatch: string | undefined,
  ): Contract.TerminalFactsReceipt {
    const command = Contract.terminalProfilePatchSchema.parse(input);
    return this.write(key, 'terminal-profile.update', { id, input: command, ifMatch }, () =>
      this.profiles.update(id, command, ifMatch),
    );
  }
  deleteProfile(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Contract.TerminalFactsReceipt {
    return this.write(key, 'terminal-profile.delete', { id, ifMatch }, () => {
      this.profiles.delete(id, ifMatch);
      return { id };
    });
  }
  createTheme(key: string, input: Contract.TerminalThemeInput): Contract.TerminalFactsReceipt {
    const command = Contract.terminalThemeInputSchema.parse(input);
    return this.write(key, 'terminal-theme.create', command, () => this.themes.create(command));
  }
  cloneTheme(key: string, id: string, name?: string): Contract.TerminalFactsReceipt {
    return this.write(key, 'terminal-theme.clone', { id, name }, () => this.themes.clone(id, name));
  }
  updateTheme(
    key: string,
    id: string,
    input: Contract.TerminalThemePatch,
    ifMatch: string | undefined,
  ): Contract.TerminalFactsReceipt {
    const command = Contract.terminalThemePatchSchema.parse(input);
    return this.write(key, 'terminal-theme.update', { id, input: command, ifMatch }, () =>
      this.themes.update(id, command, ifMatch),
    );
  }
  deleteTheme(key: string, id: string, ifMatch: string | undefined): Contract.TerminalFactsReceipt {
    return this.write(
      key,
      'terminal-theme.delete',
      { id, ifMatch },
      () => {
        if (JSON.stringify(this.work.settings()).includes('"themeId":"' + id + '"'))
          throw new ApplicationError('CONFLICT', 'Theme is referenced by saved settings');
        this.themes.delete(id, ifMatch);
        return { id };
      },
      true,
    );
  }
  recordHistory(
    key: string,
    input: Contract.RecordCommandHistoryInput,
  ): Contract.RecordCommandHistoryResult {
    const command = Contract.recordCommandHistorySchema.parse(input);
    const request = {
      terminalId: command.terminalId,
      source: command.source,
      commandHash: createHash('sha256').update(command.command).digest('hex'),
    };
    return this.work.transaction(true, () =>
      this.journal.execute(key, 'command-history.record', request, () => {
        if (this.work.terminal(command.terminalId).state !== 'ready')
          throw new ApplicationError('INVALID_STATE', 'Terminal is not ready', 409);
        const state = this.history.state();
        if (!this.work.settings().privacy.commandHistoryEnabled)
          return Contract.recordCommandHistoryResultSchema.parse({
            recorded: false,
            reason: 'disabled',
            ...state,
          });
        if (isSensitiveCommandLine(command.command))
          return Contract.recordCommandHistoryResultSchema.parse({
            recorded: false,
            reason: 'sensitive',
            ...state,
          });
        const item = this.history.record(command.command);
        return Contract.recordCommandHistoryResultSchema.parse({
          recorded: true,
          id: item.id,
          count: item.count,
          ...this.history.state(),
        });
      }),
    );
  }
  deleteHistory(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Contract.DeleteCommandHistoryResult {
    return this.work.transaction(false, () =>
      this.journal.execute(key, 'command-history.delete', { id, ifMatch }, () =>
        this.history.delete(id, ifMatch),
      ),
    );
  }
  clearHistory(key: string, ifMatch: string | undefined): Contract.ClearCommandHistoryResult {
    return this.work.transaction(false, () =>
      this.journal.execute(key, 'command-history.clear', { ifMatch }, () =>
        this.history.clear(ifMatch),
      ),
    );
  }
  purgeHistory(): { deletedCount: number } {
    const result = this.history.clear(this.history.state().etag, 'disabled-by-setting');
    return { deletedCount: result.deletedCount };
  }
  private write(
    key: string,
    operation: string,
    input: unknown,
    apply: () => { id: string; version?: number },
    configuration = false,
  ): Contract.TerminalFactsReceipt {
    return this.work.transaction(configuration, () =>
      this.journal.execute(key, operation, input, () => {
        const value = apply();
        return {
          ids: [value.id],
          ...(value.version === undefined ? {} : { version: value.version }),
          cursor: this.work.cursor(),
        };
      }),
    );
  }
}
