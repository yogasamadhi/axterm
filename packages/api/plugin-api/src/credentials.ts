// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/credentials/credentials/src/types.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * Client-safe type surface of the credential seam: the two key brands, the
 * stored-record union, the reference view crossing the Remote wire, and the
 * seam's Cordis event declarations and portable constructors. No Host provider
 * implementation is imported; Client and Host share these identities.
 *
 * @module @axterm/plugin-api/credentials
 */

import type { Branded } from './brand.ts';

/** Nominal reference to one credential: an opaque name using a POSIX-compatible identifier grammar. */
export type CredentialRef = Branded<'CredentialRef'>;

/**
 * Nominal address of one stored credential record: `<scope>/<id>`, where
 * `scope` is the registered name of the plugin that owns the record and `id`
 * is that plugin's own addressing unit (an LLM adapter uses its provider route
 * key).
 *
 * The scope is the owner rather than the domain because a record's payload is
 * written in its owner's format: two plugins serving the same provider name
 * would otherwise read each other's payload, and a record left behind by an
 * uninstalled plugin could not be told apart from a live one. The `/` also
 * keeps this grammar disjoint from {@link CredentialRef}, so the two key
 * spaces can never collide.
 */
export type CredentialKey = Branded<'CredentialKey'>;

/**
 * A credential the harness itself understands: an api key, provider
 * environment values, or both. Either field may be absent — a record carrying
 * neither is an explicit owner record. It never authorizes ambient secret discovery;
 * the provider adapter must enforce the application authentication policy.
 */
export interface ApiKeyRecord {
  /** Discriminant. */
  readonly kind: 'api-key';
  /** The non-empty secret value, when this credential is a key at all. */
  readonly key?: string;
  /** Provider environment values such as `AWS_PROFILE`; names are POSIX identifiers. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The product of one authorization grant, kept verbatim for its owner. The
 * seam never reads, validates, or reshapes {@link payload}: it is written in
 * the owning plugin's format and only that plugin can interpret it. The single
 * constraint is that it survives a JSON round trip.
 */
export interface GrantRecord {
  /** Discriminant. */
  readonly kind: 'grant';
  /** Owner-defined JSON value; opaque to the seam and to every other plugin. */
  readonly payload: unknown;
}

/** One durable credential record, tagged by what the seam may do with it. */
export type CredentialRecord = ApiKeyRecord | GrantRecord;

/**
 * Source and writability facts for one reference, safe for configuration UIs —
 * never the value. The view has no slot a value could ride in, which is what
 * lets the whole read half cross the Remote wire.
 */
export interface CredentialInfo {
  /** Whether resolving the reference would currently return a value. */
  configured: boolean;
  /** Source layer currently supplying the value; absent while unconfigured. */
  source?: string;
  /** Whether the active provider can write this reference. */
  writable: boolean;
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Committed change to a provider-managed credential source: a `set`, an
     * `unset`, or an external edit observed in storage. Ambient
     * process-environment changes are not observable and never emit. Listener
     * failures are contained and logged — a sync throw and an async rejection
     * alike — without changing the committed operation's outcome.
     * @param ref - the reference whose stored value changed.
     * @mode emit
     */
    'credentials/reference-updated'(ref: CredentialRef): void;

    /**
     * Committed change to a stored credential record: a `modifyRecord` that
     * wrote, a `deleteRecord` that removed, or an external edit observed in
     * storage. Separate from `credentials/reference-updated` because the two key
     * grammars are disjoint — a listener that received both on one event could
     * not tell which space a subject belongs to. Listener failures are
     * contained on the same terms as `credentials/reference-updated`.
     * @param key - the record whose stored value changed.
     * @mode emit
     */
    'credentials/record-updated'(key: CredentialKey): void;
  }
}

import { brandString } from './brand.ts';

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Both halves of a {@link CredentialKey}; the `/` between them is what keeps it out of {@link REF_PATTERN}. */
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Brand a raw string as a {@link CredentialRef}.
 * @param value - candidate reference; a portable identifier such as `PROVIDER_API_KEY`.
 * @returns the branded reference.
 */
export function credentialRef(value: string): CredentialRef {
  if (!isCredentialRefName(value)) {
    throw new TypeError(`credential ref must match ${String(REF_PATTERN)}`);
  }
  return brandString<CredentialRef>(value);
}

/**
 * Whether a raw string could name a reference at all. Consumers that receive
 * reference names from a configuration or hook payload ask this before resolving, because a name
 * outside the grammar has no reference to miss and should read as "not set"
 * rather than as a thrown error.
 * @param value - candidate reference.
 * @returns true when {@link credentialRef} would accept it.
 */
export function isCredentialRefName(value: string): boolean {
  return REF_PATTERN.test(value);
}

/**
 * Whether a raw string could be a {@link credentialKey} segment at all.
 * Consumers whose addressing units come from somewhere else — a settings dict
 * key, a library's own provider id — ask this before building a key, because a
 * unit outside the grammar can never have stored a record and should read as
 * "nothing stored" rather than as a thrown error.
 * @param value - candidate segment.
 * @returns true when {@link credentialKey} would accept it as either segment.
 */
export function isCredentialKeySegment(value: string): boolean {
  return KEY_SEGMENT_PATTERN.test(value);
}

/**
 * Brand a scope and an id as a {@link CredentialKey}.
 * @param scope - the owning plugin's registered name, such as `llm-pi-ai`.
 * @param id - that plugin's own addressing unit, such as a provider route key.
 * @returns the branded key.
 * @throws TypeError when either segment is not a lowercase hyphenated identifier.
 */
export function credentialKey(scope: string, id: string): CredentialKey {
  for (const segment of [scope, id]) {
    if (!KEY_SEGMENT_PATTERN.test(segment)) {
      throw new TypeError(`credential key segment must match ${String(KEY_SEGMENT_PATTERN)}`);
    }
  }
  return brandString<CredentialKey>(`${scope}/${id}`);
}

/**
 * Brand a stored `<scope>/<id>` string as a {@link CredentialKey}. This is the
 * read half of {@link credentialKey}, for a provider admitting keys off disk.
 * @param value - candidate key in its joined form.
 * @returns the branded key.
 * @throws TypeError when the value is not exactly two valid segments.
 */
export function parseCredentialKey(value: string): CredentialKey {
  const segments = value.split('/');
  const [scope, id] = segments;
  if (segments.length !== 2 || scope === undefined || id === undefined) {
    throw new TypeError('credential key must be "<scope>/<id>"');
  }
  return credentialKey(scope, id);
}

/**
 * The owning plugin's name for one key. A record whose scope names no
 * currently registered owner is an orphan, which a configuration surface must
 * report as such rather than as a working credential.
 * @param key - the key to read.
 * @returns the scope segment.
 */
export function credentialKeyScope(key: CredentialKey): string {
  // The brand's only constructors both validate two segments, so the split
  // cannot come back short here.
  return key.slice(0, key.indexOf('/'));
}

/**
 * The owning plugin's own addressing unit for one key — the half that plugin
 * chose, such as a provider route.
 * @param key - the key to read.
 * @returns the id segment.
 */
export function credentialKeyId(key: CredentialKey): string {
  return key.slice(key.indexOf('/') + 1);
}

/** One resolved credential value and the source layer that supplied it. */
export interface ResolvedCredential {
  /** The non-empty secret value. */
  value: string;
  /** Provider-owned source identifier, for example `application-vault`. */
  source: string;
}

/** Presence and writability facts for one record, safe for configuration UIs — never the value. */
export interface CredentialRecordInfo {
  /**
   * Whether a record is stored. Unlike a reference, presence alone answers
   * this: an {@link ApiKeyRecord} carrying neither a key nor environment
   * values is an explicit owner record; it never authorizes ambient secret discovery.
   */
  configured: boolean;
  /** Discriminant of the stored record; absent while none is stored. */
  kind?: CredentialRecord['kind'];
  /** Whether `modifyRecord` would currently succeed. */
  writable: boolean;
}

/** One stored record's address and tag, for enumeration — never its value. */
export interface CredentialRecordEntry {
  /** The record's address. */
  key: CredentialKey;
  /** Discriminant of the stored record. */
  kind: CredentialRecord['kind'];
}

const PREFIX = 'CREF1_';
/** Wire-format bound for an opaque source identifier, not a secret payload. */
export const MAX_OPAQUE_REFERENCE_BYTES = 512;

/** Adapt an opaque existing identifier without renaming its backing record or ciphertext AAD. */
export function encodeOpaqueCredentialRef(identifier: string): CredentialRef {
  const bytes = new TextEncoder().encode(identifier);
  if (
    bytes.length === 0 ||
    bytes.length > MAX_OPAQUE_REFERENCE_BYTES ||
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) !== identifier
  )
    throw new TypeError('Credential identifier is empty, too long or not valid Unicode');
  return brandString<CredentialRef>(
    PREFIX + [...bytes].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(''),
  );
}

/** Recover the exact source identifier; reject noncanonical or malformed references. */
export function decodeOpaqueCredentialRef(reference: CredentialRef): string {
  if (!reference.startsWith(PREFIX)) throw new TypeError('Unsupported opaque credential reference');
  const hex = reference.slice(PREFIX.length);
  if (!/^(?:[0-9A-F]{2})+$/.test(hex) || hex.length > MAX_OPAQUE_REFERENCE_BYTES * 2)
    throw new TypeError('Invalid opaque credential reference');
  const bytes = Uint8Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
  let identifier: string;
  try {
    identifier = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw invalidUnicode();
  }
  if (encodeOpaqueCredentialRef(identifier) !== reference)
    throw new TypeError('Noncanonical opaque credential reference');
  return identifier;
}

function invalidUnicode(): TypeError {
  // Decoder causes are intentionally omitted: diagnostics must not contain input bytes.
  return new TypeError('Invalid Unicode in opaque credential reference');
}
