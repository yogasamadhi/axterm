import { z } from 'zod';
import {
  credentialMutationMarkerSchema,
  savedCredentialRefSchema,
} from '@axterm/plugin-api/saved-credentials';
import type { CredentialMutationMarker } from '@axterm/plugin-api/saved-credentials';
import type { SavedCredentialsService, TemporaryCredentials } from '@axterm/plugin-api/host';
import type { SavedCredentialWorkflow } from './saved-credentials.ts';
import { CredentialWorkflowError } from './errors.ts';
/** Configuration retains mutation ownership; changed or unowned references are never deleted. */
export class TemporaryCredentialCleanup implements TemporaryCredentials {
  private closed = false;
  private readonly pending = new Set<Promise<void>>();
  constructor(
    private readonly generation: string,
    private readonly workflow: SavedCredentialWorkflow | undefined,
    private readonly provider: () => SavedCredentialsService | undefined,
  ) {}
  removeOwned(
    key: string,
    generation: string,
    ref: string,
    createdBy: CredentialMutationMarker,
  ): Promise<void> {
    if (this.closed || this.pending.size >= 32)
      return Promise.reject(new CredentialWorkflowError('closed'));
    const request = {
      key: z.uuid().parse(key),
      generation: z.uuid().parse(generation),
      ref: savedCredentialRefSchema.parse(ref),
      proof: credentialMutationMarkerSchema.parse(createdBy),
    };
    const task = (async () => {
      if (request.generation !== this.generation || request.proof.generation !== this.generation)
        throw new CredentialWorkflowError('stale-generation');
      const workflow = this.workflow,
        provider = this.provider();
      if (!workflow || !provider) throw new CredentialWorkflowError('unavailable');
      const created = await workflow.outcome(request.proof.commandId);
      if (
        created.operation !== 'create' ||
        created.ref !== request.ref ||
        created.generation !== request.proof.generation ||
        created.status !== 'completed'
      )
        throw new CredentialWorkflowError('conflict');
      let existing;
      try {
        existing = await workflow.outcome(request.key);
      } catch (error) {
        if (!(error instanceof CredentialWorkflowError) || error.reason !== 'not-found')
          throw error;
      }
      if (existing) {
        if (
          existing.operation !== 'delete' ||
          existing.ref !== request.ref ||
          existing.generation !== request.generation
        )
          throw new CredentialWorkflowError('conflict');
        if (existing.status === 'completed') return;
        if (await workflow.confirmOwnedRemoval(request.key, request.generation, request.ref))
          return;
        throw new CredentialWorkflowError('uncertain');
      }
      const removed = await workflow.removeOwned(
        request.key,
        request.generation,
        request.ref,
        request.proof,
      );
      if (
        removed.status !== 'completed' &&
        !(await workflow.confirmOwnedRemoval(request.key, request.generation, request.ref))
      )
        throw new CredentialWorkflowError('uncertain');
    })();
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
  }
}
