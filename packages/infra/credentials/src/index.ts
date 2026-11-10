// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/credentials/credentials/src/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * Service Definition for the credential-reference capability seam (`ctx.credentials`). Settings and composition files carry
 * *references* to secrets — opaque names in a portable grammar — while providers own
 * the actual values and their storage. Consumers resolve a reference once per
 * operation, so a changed credential reaches the next operation without any
 * plugin restart, and configuration surfaces describe a reference without
 * ever seeing its value.
 * @module @axterm/infra-credentials
 */

import type { Context } from '@deepseek-ai/cordis';
import { Service } from '@deepseek-ai/cordis';
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRef,
  CredentialRecordInfo,
  CredentialRecordEntry,
  ResolvedCredential,
} from '@axterm/plugin-api/credentials';
import type { CredentialsService } from '@axterm/plugin-api/host';
export {
  credentialRef,
  isCredentialRefName,
  credentialKey,
  isCredentialKeySegment,
  parseCredentialKey,
  credentialKeyScope,
  credentialKeyId,
} from '@axterm/plugin-api/credentials';
export type {
  CredentialRecordInfo,
  CredentialRecordEntry,
  ResolvedCredential,
} from '@axterm/plugin-api/credentials';

export {
  encodeOpaqueCredentialRef,
  decodeOpaqueCredentialRef,
  MAX_OPAQUE_REFERENCE_BYTES,
} from './opaque-reference.ts';

export type {
  ApiKeyRecord,
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRef,
  GrantRecord,
} from './types.ts';

/**
 * Abstract credential service over two key spaces that answer two questions.
 *
 * A {@link CredentialRef} identifies a provider-managed secret. Reference syntax
 * does not authorize reading process environment or dotenv files. The application
 * installs its local encrypted Vault provider. One seam-wide rule binds this half: an
 * empty stored value is absent everywhere — `resolve` skips it, `describe`
 * reports it unconfigured — so a blank never masquerades as a configured
 * secret.
 *
 * A {@link CredentialKey} answers "what credential does this plugin hold for
 * this id". Nothing can layer here — an authorization grant has no
 * environment to be read from — so presence of the record is the whole fact,
 * and {@link modifyRecord} is the only write path because a correct write
 * depends on the current value (a token refresh is read-decide-replace under
 * one lock).
 */
export abstract class CredentialProvider extends Service implements CredentialsService {
  constructor(ctx: Context) {
    super(ctx, 'credentials');
  }

  /**
   * Resolve one reference to its current value. Resolution is per call:
   * consumers re-resolve at each operation and must not cache across
   * operations — that per-operation read is what makes a changed credential
   * reach the next operation without a restart.
   * @param ref - the reference to resolve.
   * @returns the value and its source, or `undefined` while unconfigured.
   */
  abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>;

  /**
   * Describe one reference for configuration surfaces without exposing the
   * value.
   * @param ref - the reference to describe.
   * @returns configured state, supplying source, and writability.
   */
  abstract describe(ref: CredentialRef): Promise<CredentialInfo>;

  /**
   * Durably store one value in the provider-managed writable source. The stored
   * provider owns storage; empty values are
   * rejected (use {@link unset}).
   * @param ref - the reference to store.
   * @param value - the non-empty secret value.
   */
  abstract set(ref: CredentialRef, value: string): Promise<void>;

  /**
   * Remove one reference from the provider-managed writable source; removing
   * an absent reference is a no-op. Removal never enables ambient fallback discovery.
   * @param ref - the reference to remove.
   */
  abstract unset(ref: CredentialRef): Promise<void>;

  /**
   * Read one stored record. The value is returned as its owner wrote it; a
   * {@link GrantRecord} payload is not interpreted on the way out.
   * @param key - the record to read.
   * @returns the record, or `undefined` while none is stored.
   */
  abstract readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>;

  /**
   * Describe one record for configuration surfaces without exposing its value.
   * @param key - the record to describe.
   * @returns presence, discriminant, and writability.
   */
  abstract describeRecord(key: CredentialKey): Promise<CredentialRecordInfo>;

  /**
   * Enumerate every stored record's address and tag. Unlike the reference
   * half, which has no enumeration because configuration surfaces learn which
   * references exist from settings schemas, records have no such discovery
   * path: a surface that cannot list them cannot show what a user is
   * authorized for, nor find an orphan left by an uninstalled plugin.
   * @returns every stored record, values excluded.
   */
  abstract listRecords(): Promise<readonly CredentialRecordEntry[]>;

  /**
   * Serialized read-modify-write over one record — the only write path.
   * `mutate` sees the record as it stands at the moment the write is
   * exclusive, and returning `undefined` leaves the entry untouched. Exclusion
   * holds across processes where the backing store supports it, which is what
   * makes a token refresh safe: two processes rotating one refresh token
   * concurrently would otherwise lose whichever wrote first.
   * @param key - the record to modify.
   * @param mutate - receives the current record and returns its replacement, or `undefined` to leave it.
   * @returns the record after the write, or the current one when `mutate` declined.
   */
  abstract modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>;

  /**
   * Remove one record; removing an absent record is a no-op.
   * @param key - the record to remove.
   */
  abstract deleteRecord(key: CredentialKey): Promise<void>;

  /**
   * Fan `credentials/reference-updated` out with contained listener failures: every
   * listener runs, and a sync throw or async rejection is logged without
   * changing the committed operation's outcome. Providers call this only after the write or
   * reload actually committed, so a broken observer can never make a durable
   * change look failed.
   * @param ref - the reference whose stored value changed.
   */
  protected notifyUpdated(ref: CredentialRef): void {
    this.fanOut('credentials/reference-updated', ref);
  }

  /**
   * Fan `credentials/record-updated` out on exactly the terms
   * {@link notifyUpdated} documents, for the record half of the seam.
   * @param key - the record whose stored value changed.
   */
  protected notifyRecordUpdated(key: CredentialKey): void {
    this.fanOut('credentials/record-updated', key);
  }

  /* jscpd:ignore-start -- deliberate symmetry with the settings seam's commit
     fan-out: the contained-dispatch shape is the reviewed listener-lifecycle
     contract, and extracting it would couple the two seams' event semantics. */
  /** The contained dispatch both notifications run through; see {@link notifyUpdated}. */
  private fanOut(
    event: 'credentials/reference-updated' | 'credentials/record-updated',
    subject: string,
  ): void {
    const args = [event, subject];
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<
      (...listenerArgs: unknown[]) => unknown
    >) {
      try {
        const returned = listener(subject);
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(
            undefined,
            (_error: unknown) => {
              this.warnListenerFailure(event);
            },
          );
        }
      } catch {
        // A failed observer must not roll back a committed write or expose secret-bearing errors.
        this.warnListenerFailure(event);
      }
    }
  }
  /* jscpd:ignore-end */

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnListenerFailure(event: string): void {
    // An observer may throw secret-bearing data; keep the diagnostic structured and bounded.
    this.ctx.logger.warn('CREDENTIAL_LISTENER_FAILED: %s observer failed after commit', event);
  }
}

export default CredentialProvider;
