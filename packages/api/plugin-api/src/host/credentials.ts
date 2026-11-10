// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Selected from the pinned credentials Service contract; implementation stays private.
import type { SavedCredentialsService } from './saved-credentials.ts';
import type {
  CredentialRef,
  CredentialKey,
  CredentialInfo,
  CredentialRecord,
  CredentialRecordInfo,
  CredentialRecordEntry,
  ResolvedCredential,
} from '../credentials.ts';
export type * from '../credentials.ts';

/** Host-only access to the application-local Vault. Never expose resolution over Remote. */
export interface CredentialsService {
  /** Optional product inventory; missing means unavailable, never ambient discovery. */
  readonly saved?: SavedCredentialsService;
  /**
   * Resolve one reference to its current value. Resolution is per call:
   * consumers re-resolve at each operation and must not cache across
   * operations — that per-operation read is what makes a changed credential
   * reach the next operation without a restart.
   * @param ref - the reference to resolve.
   * @returns the value and its source, or `undefined` while unconfigured.
   */
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>;

  /**
   * Describe one reference for configuration surfaces without exposing the
   * value.
   * @param ref - the reference to describe.
   * @returns configured state, supplying source, and writability.
   */
  describe(ref: CredentialRef): Promise<CredentialInfo>;

  /**
   * Durably store one value in the provider-managed writable source. The stored
   * provider owns storage; empty values are
   * rejected (use {@link unset}).
   * @param ref - the reference to store.
   * @param value - the non-empty secret value.
   */
  set(ref: CredentialRef, value: string): Promise<void>;

  /**
   * Remove one reference from the provider-managed writable source; removing
   * an absent reference is a no-op. Removal never enables ambient fallback discovery.
   * @param ref - the reference to remove.
   */
  unset(ref: CredentialRef): Promise<void>;

  /**
   * Read one stored record. The value is returned as its owner wrote it; a
   * {@link GrantRecord} payload is not interpreted on the way out.
   * @param key - the record to read.
   * @returns the record, or `undefined` while none is stored.
   */
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>;

  /**
   * Describe one record for configuration surfaces without exposing its value.
   * @param key - the record to describe.
   * @returns presence, discriminant, and writability.
   */
  describeRecord(key: CredentialKey): Promise<CredentialRecordInfo>;

  /**
   * Enumerate every stored record's address and tag. Unlike the reference
   * half, which has no enumeration because configuration surfaces learn which
   * references exist from settings schemas, records have no such discovery
   * path: a surface that cannot list them cannot show what a user is
   * authorized for, nor find an orphan left by an uninstalled plugin.
   * @returns every stored record, values excluded.
   */
  listRecords(): Promise<readonly CredentialRecordEntry[]>;

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
  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>;

  /**
   * Remove one record; removing an absent record is a no-op.
   * @param key - the record to remove.
   */
  deleteRecord(key: CredentialKey): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    credentials: CredentialsService;
  }
}
