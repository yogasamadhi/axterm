import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/plugin-api/host';
import { RemoteError, remoteErrorOf, StorageCommandError } from '@axterm/plugin-api';
import * as Contract from '@axterm/plugin-api/terminals';
import { productDomains } from '@axterm/data-schema';
import { DomainCommands } from '@axterm/infra-storage-domain';
import { ZodError } from 'zod';
import { TerminalFactsStorage } from './adapters/facts-storage.ts';
import { NamedTerminalFacts } from './adapters/named-facts.ts';
import { TerminalProfileRepository } from './adapters/terminal-profile-repository.ts';
import { TerminalThemeRepository } from './adapters/terminal-theme-repository.ts';
import { CommandHistoryRepository } from './adapters/command-history-repository.ts';
import { TerminalFactsApplication } from './application/terminal-facts.ts';
import { TerminalFactsObservation } from './application/facts-observation.ts';
import { ApplicationError } from './application/errors.ts';
export const inject = ['storage', 'storageDomain', 'runtimeIdentity', 'configuration'];
const unavailable = () =>
  new RemoteError('terminals/failure', 'Terminal facts are unavailable', { reason: 'unavailable' });
function failure(error: unknown): RemoteError<'terminals/failure'> {
  const marked = remoteErrorOf(error);
  if (marked?.code === 'terminals/failure') return marked as RemoteError<'terminals/failure'>;
  let reason: Contract.TerminalFailureReason = 'unavailable';
  if (error instanceof ZodError) reason = 'invalid-input';
  else if (error instanceof StorageCommandError)
    reason =
      error.code === 'conflict'
        ? 'conflict'
        : error.code === 'receipt-expired'
          ? 'receipt-expired'
          : 'invalid-input';
  else if (error instanceof ApplicationError) {
    const reasons: Record<string, Contract.TerminalFailureReason> = {
      NOT_FOUND: 'not-found',
      INVALID_STATE: 'conflict',
      PRECONDITION_REQUIRED: 'precondition-required',
      PRECONDITION_FAILED: 'precondition-failed',
      CONFLICT: 'conflict',
      VALIDATION_ERROR: 'invalid-input',
      PAYLOAD_TOO_LARGE: 'capacity',
    };
    reason = reasons[error.code] ?? 'unavailable';
  }
  return new RemoteError('terminals/failure', 'The terminal fact operation failed', { reason });
}
/** One terminal facts owner, also usable without starting a PTY backend. */
export async function apply(ctx: Context): Promise<void> {
  const opening = ctx.storage.domain.open(productDomains.terminals);
  ctx.effect(() => async () => {
    await (await opening.catch(() => undefined))?.close();
  });
  const domain = await opening;
  let open = true;
  const guarded = <T>(operation: () => T): T => {
    if (!open)
      throw new RemoteError('terminals/failure', 'Terminal facts are closed', { reason: 'closed' });
    try {
      return operation();
    } catch (error) {
      throw failure(error);
    }
  };
  const sql = new TerminalFactsStorage(domain);
  const named = new NamedTerminalFacts(sql);
  const history = new CommandHistoryRepository(sql);
  const app = new TerminalFactsApplication(
    new TerminalProfileRepository(named),
    new TerminalThemeRepository(named),
    history,
    new DomainCommands(domain, 'axterm_terminal_command_receipts'),
    {
      transaction: (configuration, operation) =>
        ctx.storage.domain.transaction(
          [domain.participant, ...(configuration ? [ctx.configuration.participant] : [])],
          operation,
        ),
      settings: () => ctx.configuration.getSettings(),
      terminal: (id) => {
        const owner = ctx.get('terminals', false);
        if (!owner) throw unavailable();
        return owner.get(id);
      },
      cursor: () => domain.cursor(),
    },
  );
  const observation = new TerminalFactsObservation(domain, ctx.runtimeIdentity.generation, () => ({
    profiles: app.listProfiles(),
    themes: app.listThemes(),
    history: app.listHistory({ limit: Contract.COMMAND_HISTORY_MAX_ITEMS }),
  }));
  ctx.effect(() => () => observation.dispose());
  const purge = () => guarded(() => app.purgeHistory());
  ctx.provide('terminalHistory', {
    participant: domain.participant,
    state: () => guarded(() => app.historyState()),
    purge,
  });
  ctx.provide('terminalFacts', {
    participant: domain.participant,
    listProfiles: () => guarded(() => app.listProfiles()),
    getProfile: (id) => guarded(() => app.getProfile(id)),
    listThemes: () => guarded(() => app.listThemes()),
    listHistory: (input) => guarded(() => app.listHistory(input)),
    createProfile: (key, input) => guarded(() => app.createProfile(key, input)),
    updateProfile: (key, id, input, ifMatch) =>
      guarded(() => app.updateProfile(key, id, input, ifMatch)),
    deleteProfile: (key, id, ifMatch) => guarded(() => app.deleteProfile(key, id, ifMatch)),
    createTheme: (key, input) => guarded(() => app.createTheme(key, input)),
    cloneTheme: (key, id, name) => guarded(() => app.cloneTheme(key, id, name)),
    updateTheme: (key, id, input, ifMatch) =>
      guarded(() => app.updateTheme(key, id, input, ifMatch)),
    deleteTheme: (key, id, ifMatch) => guarded(() => app.deleteTheme(key, id, ifMatch)),
    recordHistory: (key, input) => guarded(() => app.recordHistory(key, input)),
    deleteHistory: (key, id, ifMatch) => guarded(() => app.deleteHistory(key, id, ifMatch)),
    clearHistory: (key, ifMatch) => guarded(() => app.clearHistory(key, ifMatch)),
    watch: (signal) => guarded(() => observation.watch(signal)),
  });
  ctx.inject(['configurationHistory'], (scope) => {
    const release = scope.configurationHistory.register('command-history', {
      participant: domain.participant,
      purge,
    });
    scope.effect(() => release);
  });
  ctx.effect(() => () => {
    open = false;
  });
}
