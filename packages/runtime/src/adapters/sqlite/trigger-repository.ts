import { randomUUID } from 'node:crypto';
import {
  triggerRuleSchema,
  type TriggerCollection,
  type TriggerRule,
  type TriggerRuleInput,
} from '@workspace/contracts';
import { ApplicationError } from '../../application/errors';
import type { ProductDatabase } from './database';

interface TriggerRow {
  id: string;
  name: string;
  payload: string;
  position: number;
  created_at: string;
  updated_at: string;
  version: number;
}

export const triggerListEtag = (revision: number): string => `"trigger-list-v${revision}"`;

export class TriggerRepository {
  constructor(private readonly database: ProductDatabase) {}

  snapshot(): TriggerCollection {
    const revision = Number(
      this.database.get<{ value: string }>(
        "SELECT value FROM app_meta WHERE key='trigger-list:revision'",
      )?.value ?? '1',
    );
    return {
      revision,
      etag: triggerListEtag(revision),
      triggers: this.database
        .all<TriggerRow>('SELECT * FROM automation_triggers ORDER BY position, id')
        .map(fromRow),
    };
  }

  create(input: TriggerRuleInput, ifMatch: string | undefined): TriggerCollection {
    this.database.transaction(() => {
      this.requireRevision(ifMatch);
      const id = randomUUID();
      const now = new Date().toISOString();
      const position = this.database.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM automation_triggers',
      )!.count;
      this.database.run(
        `INSERT INTO automation_triggers(
          id, name, payload, position, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
        id,
        input.name,
        JSON.stringify(rulePayload(input)),
        position,
        now,
        now,
      );
      const revision = this.advanceRevision();
      this.database.appendEvent('trigger.created', id, {
        id,
        name: input.name,
        enabled: input.enabled,
        matchType: input.match.type,
        actionType: input.action.type,
        mode: input.mode,
        triggerRevision: revision,
      });
    });
    return this.snapshot();
  }

  update(id: string, input: TriggerRuleInput, ifMatch: string | undefined): TriggerCollection {
    this.database.transaction(() => {
      this.requireRevision(ifMatch);
      const current = this.require(id);
      const now = new Date().toISOString();
      const result = this.database.run(
        `UPDATE automation_triggers
         SET name=?, payload=?, updated_at=?, version=version+1
         WHERE id=? AND version=?`,
        input.name,
        JSON.stringify(rulePayload(input)),
        now,
        id,
        current.version,
      );
      if (!result.changes)
        throw new ApplicationError('PRECONDITION_FAILED', 'Trigger changed', 412);
      const revision = this.advanceRevision();
      this.database.appendEvent('trigger.updated', id, {
        id,
        name: input.name,
        enabled: input.enabled,
        matchType: input.match.type,
        actionType: input.action.type,
        mode: input.mode,
        triggerRevision: revision,
      });
    });
    return this.snapshot();
  }

  delete(id: string, ifMatch: string | undefined): TriggerCollection {
    this.database.transaction(() => {
      this.requireRevision(ifMatch);
      const current = this.require(id);
      this.database.run('DELETE FROM automation_triggers WHERE id=?', id);
      this.database.run(
        'UPDATE automation_triggers SET position=position-1 WHERE position>?',
        current.position,
      );
      const revision = this.advanceRevision();
      this.database.appendEvent('trigger.deleted', id, { id, triggerRevision: revision });
    });
    return this.snapshot();
  }

  replace(inputs: TriggerRuleInput[], ifMatch: string | undefined): TriggerCollection {
    this.database.transaction(() => {
      this.requireRevision(ifMatch);
      this.database.run('DELETE FROM automation_triggers');
      const now = new Date().toISOString();
      for (const [position, input] of inputs.entries())
        this.database.run(
          `INSERT INTO automation_triggers(
            id, name, payload, position, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
          randomUUID(),
          input.name,
          JSON.stringify(rulePayload(input)),
          position,
          now,
          now,
        );
      const revision = this.advanceRevision();
      this.database.appendEvent('trigger-list.replaced', 'trigger-list', {
        count: inputs.length,
        triggerRevision: revision,
      });
    });
    return this.snapshot();
  }

  private require(id: string): TriggerRow {
    const row = this.database.get<TriggerRow>('SELECT * FROM automation_triggers WHERE id=?', id);
    if (!row) throw new ApplicationError('NOT_FOUND', 'Trigger not found', 404);
    return row;
  }

  private requireRevision(ifMatch: string | undefined): void {
    if (!ifMatch)
      throw new ApplicationError('PRECONDITION_REQUIRED', 'Trigger If-Match is required', 428);
    const match = /^"trigger-list-v(\d+)"$/.exec(ifMatch);
    if (!match) throw new ApplicationError('PRECONDITION_FAILED', 'Invalid Trigger version', 412);
    const current = this.snapshot().revision;
    if (Number(match[1]) !== current)
      throw new ApplicationError('PRECONDITION_FAILED', 'Trigger list changed', 412);
  }

  private advanceRevision(): number {
    this.database.run(
      "UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='trigger-list:revision'",
    );
    return Number(
      this.database.get<{ value: string }>(
        "SELECT value FROM app_meta WHERE key='trigger-list:revision'",
      )!.value,
    );
  }
}

function fromRow(row: TriggerRow): TriggerRule {
  return triggerRuleSchema.parse({
    id: row.id,
    name: row.name,
    ...JSON.parse(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

function rulePayload(input: TriggerRuleInput) {
  return {
    enabled: input.enabled,
    match: input.match,
    action: input.action,
    sendEnter: input.sendEnter,
    mode: input.mode,
    cooldownMs: input.cooldownMs,
  };
}
