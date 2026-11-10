// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/storage/storage/src/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
import { Service, type Context } from '@deepseek-ai/cordis';
import { RegistrationLifetime } from '@axterm/infra-scope';
import { StorageError, UNIT_NAME_RE } from '@axterm/plugin-api';
import type {
  StorageBackend,
  StorageBackendRegistry,
  StorageForms,
  StorageHub,
  StorageDisposer,
} from '@axterm/plugin-api';
import type {} from '@axterm/plugin-api/host';
export { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@axterm/plugin-api';
export type { StorageBackend, KvFacet, KvUnit, KvUnitDescriptor } from '@axterm/plugin-api';

/** IO-free storage hub; registrations belong to caller and provider lifetimes. */
export class Storage extends Service implements StorageHub {
  private readonly backends = new Map<string, StorageBackend>();
  private readonly forms = new Map<keyof StorageForms, unknown>();
  private readonly registrations: RegistrationLifetime;
  constructor(ctx: Context) {
    super(ctx, 'storage');
    this.registrations = new RegistrationLifetime(ctx);
  }
  get backend(): StorageBackendRegistry {
    const caller = this.ctx;
    const backends = this.backends;
    const lifetime = this.registrations;
    return {
      register(name, backend) {
        if (!UNIT_NAME_RE.test(name))
          throw new StorageError('duplicate-backend', 'Invalid backend name');
        if (backends.has(name))
          throw new StorageError(
            'duplicate-backend',
            `Storage backend '${name}' is already registered`,
          );
        return lifetime.owner(caller).effect(() => {
          backends.set(name, backend);
          return () => {
            if (backends.get(name) === backend) backends.delete(name);
          };
        }, `storage.backend.register(${name})`);
      },
      get(name) {
        const backend = backends.get(name);
        if (!backend)
          throw new StorageError(
            'backend-not-found',
            `Storage backend '${name}' is not registered`,
          );
        return backend;
      },
      names: () => [...backends.keys()],
    };
  }
  mount<K extends keyof StorageForms>(form: K, facility: StorageForms[K]): StorageDisposer {
    if (this.forms.has(form))
      throw new StorageError(
        'duplicate-mount',
        `Storage form '${String(form)}' is already mounted`,
      );
    return this.registrations.owner(this.ctx).effect(
      () => {
        this.forms.set(form, facility);
        return () => {
          if (this.forms.get(form) === facility) this.forms.delete(form);
        };
      },
      `storage.mount(${String(form)})`,
    );
  }
  form<K extends keyof StorageForms>(form: K): StorageForms[K] {
    if (!this.forms.has(form))
      throw new StorageError('form-not-mounted', `Storage form '${String(form)}' is not mounted`);
    return this.forms.get(form) as StorageForms[K];
  }
  get domain(): StorageForms['domain'] {
    return this.form('domain');
  }
}
export default Storage;
