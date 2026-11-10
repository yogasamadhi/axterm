import type * as Contract from '@axterm/plugin-api/terminals';
export interface TerminalProfileStore {
  list(): Contract.TerminalProfile[];
  get(id: string): Contract.TerminalProfile;
  create(input: Contract.TerminalProfileInput): Contract.TerminalProfile;
  update(
    id: string,
    input: Contract.TerminalProfilePatch,
    ifMatch: string | undefined,
  ): Contract.TerminalProfile;
  delete(id: string, ifMatch: string | undefined): void;
}
export interface CommandHistoryStore {
  list(input?: Contract.CommandHistoryPageQuery): Contract.CommandHistoryPage;
  state(): Contract.CommandHistoryState;
  record(command: string): Contract.CommandHistoryItem;
  delete(id: string, ifMatch: string | undefined): Contract.DeleteCommandHistoryResult;
  clear(
    ifMatch: string | undefined,
    reason?: 'disabled-by-setting',
  ): Contract.ClearCommandHistoryResult;
}
