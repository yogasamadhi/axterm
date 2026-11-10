import * as Contract from '@axterm/plugin-api/terminals';
import type { TerminalProfileStore } from '../ports/facts-store.ts';
import type { NamedTerminalFacts } from './named-facts.ts';
export class TerminalProfileRepository implements TerminalProfileStore {
  constructor(private readonly facts: NamedTerminalFacts) {}
  list(): Contract.TerminalProfile[] {
    return this.facts
      .listJson<unknown>('terminal_profiles')
      .map((value) => Contract.terminalProfileSchema.parse(value));
  }
  get(id: string): Contract.TerminalProfile {
    return Contract.terminalProfileSchema.parse(
      this.facts.getJson<unknown>('terminal_profiles', id),
    );
  }
  create(input: Contract.TerminalProfileInput): Contract.TerminalProfile {
    return Contract.terminalProfileSchema.parse(
      this.facts.createJson(
        'terminal_profiles',
        Contract.terminalProfileInputSchema.parse(input),
        'terminal-profile',
      ),
    );
  }
  update(
    id: string,
    input: Contract.TerminalProfilePatch,
    ifMatch: string | undefined,
  ): Contract.TerminalProfile {
    return Contract.terminalProfileSchema.parse(
      this.facts.updateJson(
        'terminal_profiles',
        id,
        Contract.terminalProfilePatchSchema.parse(input),
        ifMatch,
        'terminal-profile',
      ),
    );
  }
  delete(id: string, ifMatch: string | undefined): void {
    this.facts.deleteJson('terminal_profiles', id, ifMatch, 'terminal-profile');
  }
}
