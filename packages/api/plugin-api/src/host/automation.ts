import type { RelationalParticipant } from '../storage.ts';
import type {
  QuickCommandTree,
  TriggerCollection,
  TriggerRuleInput,
  QuickCommandGroupInput,
  QuickCommandInput,
} from '../automation.ts';
/** Selected owner operations; import calls participate in the configuration workflow's shared transaction. */
export interface AutomationOwner {
  readonly participant: RelationalParticipant;
  readonly configurationImport?: AutomationConfigurationImport;
  getQuickCommands(): QuickCommandTree;
  getTriggers(): TriggerCollection;
  importQuickCommands(value: unknown, ifMatch: string | undefined): void;
  importTriggers(value: TriggerRuleInput[], ifMatch: string | undefined): void;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    automation: AutomationOwner;
  }
}

export interface AutomationConfigurationImport {
  readonly quickCommands: {
    snapshot(): QuickCommandTree;
    createGroup(input: QuickCommandGroupInput, ifMatch: string | undefined): QuickCommandTree;
    createCommand(input: QuickCommandInput, ifMatch: string | undefined): QuickCommandTree;
  };
  readonly triggers: {
    snapshot(): TriggerCollection;
    create(input: TriggerRuleInput, ifMatch: string | undefined): TriggerCollection;
  };
}
