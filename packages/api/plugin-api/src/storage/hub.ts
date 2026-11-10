import type {
  RelationalDomain,
  RelationalDomainSpec,
  RelationalParticipant,
} from './relational.ts';
import type { StorageBackend } from './backend.ts';
import type { DomainSpec } from './spec.ts';
import type { Domain } from './domain-types.ts';

export type StorageDisposer = () => Promise<void>;
export interface StorageBackendRegistry {
  register(name: string, backend: StorageBackend): StorageDisposer;
  get(name: string): StorageBackend;
  names(): string[];
}
export interface StorageDomainFacility {
  open<S extends RelationalDomainSpec>(spec: S): Promise<RelationalDomain>;
  open<S extends DomainSpec>(spec: S): Promise<Domain<S>>;
  /** The owning services retain their handles; all participants must use the same routed medium. */
  transaction<T>(participants: readonly RelationalParticipant[], operation: () => T): T;
}
export interface StorageForms {
  domain: StorageDomainFacility;
}
export interface StorageHub {
  readonly backend: StorageBackendRegistry;
  mount<K extends keyof StorageForms>(form: K, facility: StorageForms[K]): StorageDisposer;
  form<K extends keyof StorageForms>(form: K): StorageForms[K];
  readonly domain: StorageForms['domain'];
}
/** Lifecycle service paired with one backend registry entry. */
export function storageBackendServiceKey(name: string): string {
  return `storage.backend.${name}`;
}
