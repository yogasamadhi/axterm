import type * as Contract from '@axterm/plugin-api/automation';
export interface QuickCommandRepository {
  snapshot(): Contract.QuickCommandTree;
  createGroup(
    input: Contract.QuickCommandGroupInput,
    ifMatch: string | undefined,
  ): Contract.QuickCommandTree;
  updateGroup(
    id: string,
    input: Contract.QuickCommandGroupPatch,
    ifMatch: string | undefined,
  ): Contract.QuickCommandTree;
  deleteGroup(id: string, ifMatch: string | undefined): Contract.QuickCommandTree;
  createCommand(
    input: Contract.QuickCommandInput,
    ifMatch: string | undefined,
  ): Contract.QuickCommandTree;
  updateCommand(
    id: string,
    input: Contract.QuickCommandPatch,
    ifMatch: string | undefined,
  ): Contract.QuickCommandTree;
  deleteCommand(id: string, ifMatch: string | undefined): Contract.QuickCommandTree;
  move(
    input: Contract.MoveQuickCommandTreeNodeInput,
    ifMatch: string | undefined,
  ): Contract.QuickCommandTree;
  replacePortable(
    groups: Contract.QuickCommandGroup[],
    commands: Contract.QuickCommand[],
    ifMatch: string | undefined,
  ): Contract.QuickCommandTree;
}

export interface TriggerRepository {
  revision(): number;
  snapshot(): Contract.TriggerCollection;
  create(input: Contract.TriggerRuleInput, ifMatch: string | undefined): Contract.TriggerCollection;
  update(
    id: string,
    input: Contract.TriggerRuleInput,
    ifMatch: string | undefined,
  ): Contract.TriggerCollection;
  delete(id: string, ifMatch: string | undefined): Contract.TriggerCollection;
  replace(
    input: Contract.TriggerRuleInput[],
    ifMatch: string | undefined,
  ): Contract.TriggerCollection;
}
