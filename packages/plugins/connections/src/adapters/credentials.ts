import type { Context } from '@deepseek-ai/cordis';
import { encodeOpaqueCredentialRef } from '@axterm/infra-credentials';
import type { CredentialAccess } from '../ports/credentials.ts';
import { ApplicationError } from '../application/errors.ts';
/** Resolves only explicit saved references; never probes ambient or system credential stores. */
export class ConnectionCredentials implements CredentialAccess {
  constructor(
    private readonly ctx: Context,
    private readonly grants?: Pick<CredentialAccess, 'readGrantedText' | 'revokeGrant'>,
  ) {}
  async resolveCredential(ref: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const resolved = await this.ctx.credentials.resolve(encodeOpaqueCredentialRef(ref));
    signal?.throwIfAborted();
    if (!resolved)
      throw new ApplicationError(
        'AUTHENTICATION_FAILED',
        'The saved credential is unavailable',
        503,
      );
    return resolved.value;
  }
  readGrantedText(id: string, signal?: AbortSignal): Promise<{ content: string }> {
    const files = this.ctx.get('fileGrants');
    if (files) return files.readText(id, 2 * 1024 * 1024, signal);
    if (!this.grants)
      return Promise.reject(
        new ApplicationError('CAPABILITY_UNAVAILABLE', 'File grants are unavailable', 503),
      );
    return this.grants.readGrantedText(id, signal);
  }
  revokeGrant(id: string): Promise<void> {
    const files = this.ctx.get('fileGrants');
    if (files) return files.revoke(id);
    if (!this.grants)
      return Promise.reject(
        new ApplicationError('CAPABILITY_UNAVAILABLE', 'File grants are unavailable', 503),
      );
    return this.grants.revokeGrant(id);
  }
}
