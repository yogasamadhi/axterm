import type { RelationalDomain } from '@axterm/plugin-api/storage';
import {
  savedCredentialMetadataSchema,
  type SavedCredentialMetadata,
  type CredentialCommandOperation,
  type CredentialCommandFailure,
  type CredentialCommandReceipt,
} from '@axterm/plugin-api/saved-credentials';
import type { CredentialIntent, CredentialIntentStore } from '../ports/saved-credentials.ts';
import { CredentialWorkflowError } from '../application/errors.ts';
interface Row {
  command_id: string;
  generation: string;
  operation: CredentialCommandOperation;
  credential_ref: string;
  metadata_json: string;
  status: CredentialCommandReceipt['status'];
  result_json: string;
  error_reason: CredentialCommandFailure | null;
}
/** Durable one-shot reservations. Secret inputs and secret-derived hashes have no column or encoder here. */
export class CredentialIntents implements CredentialIntentStore {
  constructor(
    private readonly domain: RelationalDomain,
    private readonly profile: string,
    private readonly generation: string,
  ) {
    if (!profile || profile.length > 128) throw new CredentialWorkflowError('invalid-input');
    domain.transaction(() => {
      const stale = domain.all<{ command_id: string }>(
        "SELECT command_id FROM axterm_credential_command_intents WHERE profile_name=? AND status='running' LIMIT 65",
        profile,
      );
      if (stale.length > 64) throw new CredentialWorkflowError('capacity');
      for (const row of stale) {
        domain.run(
          "UPDATE axterm_credential_command_intents SET status='interrupted',error_reason='interrupted',updated_at=? WHERE command_id=?",
          new Date().toISOString(),
          row.command_id,
        );
        domain.appendEvent('configuration/credential-command-interrupted', { id: row.command_id });
      }
    });
  }
  reserve(
    commandId: string,
    operation: CredentialCommandOperation,
    ref: string,
    descriptor: { kind?: string; label?: string },
  ): CredentialIntent {
    return this.domain.transaction(() => {
      if (
        this.domain.get(
          'SELECT command_id FROM axterm_credential_command_intents WHERE command_id=?',
          commandId,
        )
      )
        throw new CredentialWorkflowError('already-submitted');
      const count =
        this.domain.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM axterm_credential_command_intents WHERE profile_name=? AND generation=?',
          this.profile,
          this.generation,
        )?.count ?? 0;
      if (count >= 10000) throw new CredentialWorkflowError('capacity');
      // Reconstruct rather than serializing an arbitrary caller object with a possible secret field.
      const safe = operation === 'create' ? { kind: descriptor.kind, label: descriptor.label } : {};
      const now = new Date().toISOString();
      this.domain.run(
        "INSERT INTO axterm_credential_command_intents(command_id,profile_name,generation,operation,credential_ref,metadata_json,status,result_json,error_reason,created_at,updated_at) VALUES (?,?,?,?,?,?,'running','null',NULL,?,?)",
        commandId,
        this.profile,
        this.generation,
        operation,
        ref,
        JSON.stringify(safe),
        now,
        now,
      );
      this.domain.appendEvent('configuration/credential-command-reserved', {
        id: commandId,
        operation,
        ref,
      });
      return this.get(commandId)!;
    });
  }
  get(commandId: string): CredentialIntent | undefined {
    const row = this.domain.get<Row>(
      'SELECT command_id,generation,operation,credential_ref,metadata_json,status,result_json,error_reason FROM axterm_credential_command_intents WHERE command_id=? AND profile_name=?',
      commandId,
      this.profile,
    );
    if (!row) return undefined;
    try {
      const descriptor: unknown = JSON.parse(row.metadata_json);
      if (
        !descriptor ||
        typeof descriptor !== 'object' ||
        Array.isArray(descriptor) ||
        Object.keys(descriptor).some((key) => key !== 'kind' && key !== 'label')
      )
        throw new Error();
      const metadata =
        row.status === 'completed' && row.result_json !== 'null'
          ? savedCredentialMetadataSchema.parse(JSON.parse(row.result_json))
          : undefined;
      return {
        commandId: row.command_id,
        generation: row.generation,
        operation: row.operation,
        ref: row.credential_ref,
        status: row.status,
        descriptor: descriptor as { kind?: string; label?: string },
        ...(metadata ? { metadata } : {}),
        ...(row.error_reason ? { reason: row.error_reason } : {}),
      };
    } catch {
      throw new CredentialWorkflowError('unavailable');
    }
  }
  finish(
    commandId: string,
    status: 'completed' | 'failed' | 'uncertain',
    metadata?: SavedCredentialMetadata,
    reason?: CredentialCommandFailure,
  ): CredentialCommandReceipt {
    return this.domain.transaction(() => {
      const row = this.get(commandId);
      if (!row) throw new CredentialWorkflowError('not-found');
      if (row.status === 'completed' || row.status === 'expired') {
        const { descriptor: _descriptor, ...receipt } = row;
        return receipt;
      }
      const safe = metadata ? savedCredentialMetadataSchema.parse(metadata) : undefined;
      if (status === 'completed' && row.operation !== 'delete' && (!safe || safe.ref !== row.ref))
        throw new CredentialWorkflowError('unavailable');
      if (
        status === 'completed' &&
        row.operation === 'create' &&
        (safe?.kind !== row.descriptor.kind || safe?.label !== row.descriptor.label)
      )
        throw new CredentialWorkflowError('unavailable');
      const order =
        this.domain.get<{ value: number }>(
          'SELECT COALESCE(MAX(result_order),0) AS value FROM axterm_credential_command_intents WHERE profile_name=?',
          this.profile,
        )?.value ?? 0;
      if (order >= Number.MAX_SAFE_INTEGER) throw new CredentialWorkflowError('capacity');
      this.domain.run(
        'UPDATE axterm_credential_command_intents SET status=?,result_json=?,error_reason=?,updated_at=?,result_order=? WHERE command_id=? AND profile_name=?',
        status,
        safe ? JSON.stringify(safe) : 'null',
        reason ?? null,
        new Date().toISOString(),
        order + 1,
        commandId,
        this.profile,
      );
      this.domain.appendEvent('configuration/credential-command-finished', {
        id: commandId,
        status,
        operation: row.operation,
        ref: row.ref,
      });
      const expired = this.domain.all<{ command_id: string }>(
        "SELECT command_id FROM axterm_credential_command_intents WHERE profile_name=? AND status IN ('completed','failed') ORDER BY result_order DESC LIMIT -1 OFFSET 2000",
        this.profile,
      );
      for (const entry of expired)
        this.domain.run(
          "UPDATE axterm_credential_command_intents SET status='expired',result_json='null',error_reason='receipt-expired',metadata_json='{}' WHERE command_id=?",
          entry.command_id,
        );
      const { descriptor: _descriptor, ...receipt } = this.get(commandId)!;
      return receipt;
    });
  }
}
