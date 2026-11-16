import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CredentialsService } from '@axterm/plugin-api/host';
import { credentialKey } from '@axterm/plugin-api/credentials';
import type { PiCredential, PiCredentialStore } from '@axterm/engine-pi-core';
import { EngineError } from '@axterm/engine-api';

const credentialSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('api_key'),
      key: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z.looseObject({
    type: z.literal('oauth'),
    access: z.string(),
    refresh: z.string(),
    expires: z.number().finite(),
  }),
]);
/** A Pi grant lives in the existing Vault record space; refresh holds its cross-process lock. */
export class PiVaultCredentials implements PiCredentialStore {
  private readonly key;
  constructor(
    private readonly vault: CredentialsService,
    private readonly provider: string,
    reference: string,
    private readonly observe: (value: PiCredential) => void = () => {},
  ) {
    this.key = credentialKey(
      'engine-pi',
      'grant-' + createHash('sha256').update(reference).digest('hex'),
    );
  }
  private decode(
    record: Awaited<ReturnType<CredentialsService['readRecord']>>,
  ): PiCredential | undefined {
    if (!record) return undefined;
    if (record.kind !== 'grant') throw new EngineError('invalid');
    const value = z
      .object({ provider: z.literal(this.provider), credential: credentialSchema })
      .strict()
      .parse(record.payload);
    this.observe(value.credential);
    return value.credential;
  }
  async read(provider: string) {
    if (provider !== this.provider) return undefined;
    return this.decode(await this.vault.readRecord(this.key));
  }
  async list() {
    const value = await this.read(this.provider);
    return value ? [{ providerId: this.provider, type: value.type }] : [];
  }
  async modify(
    provider: string,
    mutate: (current: PiCredential | undefined) => Promise<PiCredential | undefined>,
  ) {
    if (provider !== this.provider) throw new EngineError('invalid');
    const record = await this.vault.modifyRecord(this.key, async (current) => {
      const next = await mutate(this.decode(current));
      if (!next) return undefined;
      const credential = credentialSchema.parse(next);
      if (JSON.stringify(credential).length > 131072) throw new EngineError('capacity');
      return { kind: 'grant', payload: { provider, credential } };
    });
    return this.decode(record);
  }
  async delete(provider: string) {
    if (provider !== this.provider) throw new EngineError('invalid');
    await this.vault.deleteRecord(this.key);
  }
}
