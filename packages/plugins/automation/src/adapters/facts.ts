import type { RelationalDomain } from '@axterm/plugin-api/storage';
import { DomainCommands } from '@axterm/infra-storage-domain';
import * as Contract from '@axterm/plugin-api/automation';
import type { QuickCommandService } from '../application/quick-commands.ts';
import type { TriggerService } from '../application/triggers.ts';
import type { AutomationStorage } from './storage.ts';
/** Compact fact receipts commit with owned SQL/outbox; live trigger effects refresh after commit. */
export class AutomationFacts {
  private readonly commands: DomainCommands;
  constructor(
    private readonly domain: RelationalDomain,
    private readonly sql: AutomationStorage,
    readonly quickCommands: QuickCommandService,
    readonly triggers: TriggerService,
  ) {
    this.commands = new DomainCommands(domain, 'axterm_automation_command_receipts');
  }
  private execute(
    key: string,
    operation: string,
    input: unknown,
    action: () => readonly string[],
  ): Contract.AutomationReceipt {
    this.sql.assertBounds();
    const receipt = this.commands.execute(key, operation, input, () => {
      const ids = action();
      this.sql.assertBounds();
      return { ids: [...ids], cursor: this.domain.cursor() };
    });
    this.triggers.refreshFromStorage();
    return receipt;
  }
  createGroup(
    key: string,
    raw: Contract.QuickCommandGroupInput,
    ifMatch: string | undefined,
  ): Contract.AutomationReceipt {
    const input = Contract.quickCommandGroupInputSchema.parse(raw);
    return this.execute(key, 'quick-command-group.create', { input, ifMatch }, () => {
      const before = new Set(this.quickCommands.snapshot().groups.map((item) => item.id));
      return this.quickCommands
        .createGroup(input, ifMatch)
        .groups.filter((item) => !before.has(item.id))
        .map((item) => item.id);
    });
  }
  updateGroup(
    key: string,
    id: string,
    raw: Contract.QuickCommandGroupPatch,
    ifMatch: string | undefined,
  ): Contract.AutomationReceipt {
    const input = Contract.quickCommandGroupPatchSchema.parse(raw);
    return this.execute(key, 'quick-command-group.update', { id, input, ifMatch }, () => {
      this.quickCommands.updateGroup(id, input, ifMatch);
      return [id];
    });
  }
  deleteGroup(key: string, id: string, ifMatch: string | undefined): Contract.AutomationReceipt {
    return this.execute(key, 'quick-command-group.delete', { id, ifMatch }, () => {
      this.quickCommands.deleteGroup(id, ifMatch);
      return [id];
    });
  }
  createCommand(
    key: string,
    raw: Contract.QuickCommandInput,
    ifMatch: string | undefined,
  ): Contract.AutomationReceipt {
    const input = Contract.quickCommandInputSchema.parse(raw);
    return this.execute(key, 'quick-command.create', { input, ifMatch }, () => {
      const before = new Set(this.quickCommands.snapshot().commands.map((item) => item.id));
      return this.quickCommands
        .createCommand(input, ifMatch)
        .commands.filter((item) => !before.has(item.id))
        .map((item) => item.id);
    });
  }
  updateCommand(
    key: string,
    id: string,
    raw: Contract.QuickCommandPatch,
    ifMatch: string | undefined,
  ): Contract.AutomationReceipt {
    const input = Contract.quickCommandPatchSchema.parse(raw);
    return this.execute(key, 'quick-command.update', { id, input, ifMatch }, () => {
      this.quickCommands.updateCommand(id, input, ifMatch);
      return [id];
    });
  }
  deleteCommand(key: string, id: string, ifMatch: string | undefined): Contract.AutomationReceipt {
    return this.execute(key, 'quick-command.delete', { id, ifMatch }, () => {
      this.quickCommands.deleteCommand(id, ifMatch);
      return [id];
    });
  }
  move(
    key: string,
    raw: Contract.MoveQuickCommandTreeNodeInput,
    ifMatch: string | undefined,
  ): Contract.AutomationReceipt {
    const input = Contract.moveQuickCommandTreeNodeSchema.parse(raw);
    return this.execute(key, 'quick-command-tree.move', { input, ifMatch }, () => {
      this.quickCommands.move(input, ifMatch);
      return [input.source.id];
    });
  }
  createTrigger(
    key: string,
    raw: Contract.TriggerRuleInput,
    ifMatch: string | undefined,
  ): Contract.AutomationReceipt {
    const input = Contract.triggerRuleInputSchema.parse(raw);
    return this.execute(key, 'trigger.create', { input, ifMatch }, () => {
      const before = new Set(this.triggers.snapshot().triggers.map((item) => item.id));
      return this.triggers
        .create(input, ifMatch)
        .triggers.filter((item) => !before.has(item.id))
        .map((item) => item.id);
    });
  }
  updateTrigger(
    key: string,
    id: string,
    raw: Contract.TriggerRulePatch,
    ifMatch: string | undefined,
  ): Contract.AutomationReceipt {
    const input = Contract.triggerRulePatchSchema.parse(raw);
    return this.execute(key, 'trigger.update', { id, input, ifMatch }, () => {
      this.triggers.update(id, input, ifMatch);
      return [id];
    });
  }
  deleteTrigger(key: string, id: string, ifMatch: string | undefined): Contract.AutomationReceipt {
    return this.execute(key, 'trigger.delete', { id, ifMatch }, () => {
      this.triggers.delete(id, ifMatch);
      return [id];
    });
  }
  replaceTriggers(
    key: string,
    raw: Contract.TriggerRuleInput[],
    ifMatch: string | undefined,
  ): Contract.AutomationReceipt {
    const input = Contract.replaceTriggersSchema.parse(raw);
    return this.execute(key, 'trigger-list.replace', { input, ifMatch }, () =>
      this.triggers.replace(input, ifMatch).triggers.map((item) => item.id),
    );
  }
}
