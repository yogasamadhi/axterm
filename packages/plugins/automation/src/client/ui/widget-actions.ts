import type { FileGrantActions } from '@axterm/plugin-api/files';
import type { Context } from '@deepseek-ai/cordis';
import type * as C from '@axterm/plugin-api/automation';
import type { CredentialSubmission } from '@axterm/plugin-api/saved-credentials';
import { WidgetOutcomeUnknown, type WidgetModel } from '../widgets.ts';
/** Selected commands only. Form secrets stay on the stack of one admitted call. */
export class WidgetUiActions {
  private readonly lifetime = new AbortController();
  private readonly grants = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly files: FileGrantActions;
  private credential: Omit<CredentialSubmission, 'result'> | undefined;
  constructor(
    private readonly ctx: Context,
    private readonly model: WidgetModel,
  ) {
    this.files = ctx.fileGrantActions;
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  getSnapshot = () => this.credential;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    for (const listener of this.listeners) listener();
  }
  createFileGrant(kind: 'open-directory') {
    return this.track(this.chooseDirectory(kind));
  }
  private async chooseDirectory(kind: 'open-directory') {
    this.lifetime.signal.throwIfAborted();
    const generation = this.model.generation(),
      owner = this.files;
    if (!owner.createInGeneration || !owner.revokeInGeneration)
      throw Error('WIDGET_GRANTS_UNAVAILABLE');
    const grant = await owner.createInGeneration({ kind }, generation, this.lifetime.signal);
    if (grant) {
      this.grants.set(grant.grantId, generation);
      if (this.lifetime.signal.aborted || this.model.generation() !== generation) {
        await this.releaseGrant(grant.grantId, generation);
        throw Error('WIDGET_GENERATION_CHANGED');
      }
    }
    return grant;
  }
  startLocalFileServerWidget = (input: C.StartLocalFileServerInput) => this.model.startFile(input);
  startLocalFtpServerWidget = (input: C.StartLocalFtpServerInput) => this.model.startFtp(input);
  startLocalSshServerWidget = (input: C.StartLocalSshServerInput) => this.model.startSsh(input);
  renameWidgetInstance = (id: string, input: C.RenameWidgetInstanceInput) =>
    this.model.rename(id, input);
  stopWidgetInstance = (id: string) => this.model.stop(id);
  previewFileRenameWidget = (input: C.PreviewFileRenameInput) =>
    this.ctx.fileRenameModel.preview(input);
  runFileRenameWidget = (id: string) =>
    this.ctx.fileRenameModel.run(crypto.randomUUID(), id, this.lifetime.signal);
  openExternal = (url: string) => this.ctx.desktopUi.openExternal(url, this.lifetime.signal);
  startMcpWithKey(
    input: Omit<C.StartMcpServerInput, 'credentialRef' | 'ownedCredential'>,
    secret: string,
  ) {
    return this.track(this.startMcp(input, secret));
  }
  private async startMcp(
    input: Omit<C.StartMcpServerInput, 'credentialRef' | 'ownedCredential'>,
    secret: string,
  ) {
    this.lifetime.signal.throwIfAborted();
    if (this.credential || this.model.getSnapshot().uncertain)
      throw Error('WIDGET_OUTCOME_REQUIRED');
    const submission = this.ctx.savedCredentialActions.submitCreate({
      kind: 'mcpApiKey',
      label: `${input.title ?? 'MCP'} API key`,
      secret,
    });
    this.credential = { commandId: submission.commandId, generation: submission.generation };
    this.publish();
    const receipt = await submission.result;
    if (receipt.status !== 'completed') throw Error('WIDGET_CREDENTIAL_OUTCOME_REQUIRED');
    const proof = this.credential;
    this.credential = undefined;
    this.publish();
    try {
      return await this.model.startMcp({
        ...input,
        credentialRef: receipt.ref,
        ownedCredential: proof,
      });
    } catch (error) {
      if (!(error instanceof WidgetOutcomeUnknown)) {
        try {
          const result = await this.ctx.remote.automation.releaseWidgetCredential(
            crypto.randomUUID(),
            proof.generation,
            receipt.ref,
            proof,
          );
          if (!result.ok) throw result.error;
        } catch {
          this.credential = proof;
          this.publish();
        }
      }
      throw error;
    }
  }
  checkCredential() {
    return this.track(this.checkCredentialOutcome());
  }
  private async checkCredentialOutcome() {
    const proof = this.credential;
    if (!proof) return;
    const receipt = await this.ctx.savedCredentialActions.outcome(proof.commandId);
    if (
      receipt.status === 'running' ||
      receipt.status === 'uncertain' ||
      receipt.status === 'interrupted'
    )
      return;
    if (receipt.status === 'completed') {
      const result = await this.ctx.remote.automation.releaseWidgetCredential(
        crypto.randomUUID(),
        proof.generation,
        receipt.ref,
        proof,
      );
      if (!result.ok) throw result.error;
    }
    this.credential = undefined;
    this.publish();
  }
  private async releaseGrant(id: string, generation: string): Promise<void> {
    if (this.model.generation() !== generation) throw Error('WIDGET_GENERATION_CHANGED');
    if (!this.files.revokeInGeneration) throw Error('WIDGET_GRANTS_UNAVAILABLE');
    await this.files.revokeInGeneration(id, generation);
    this.grants.delete(id);
  }
  async close() {
    this.lifetime.abort();
    await Promise.allSettled([...this.pending]);
    await Promise.allSettled(
      [...this.grants].map(([id, generation]) => this.releaseGrant(id, generation)),
    );
    this.listeners.clear();
    if (this.grants.size) throw Error('WIDGET_GRANTS_UNDRAINED');
  }
}
