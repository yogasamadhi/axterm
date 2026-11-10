import type { Context } from '@deepseek-ai/cordis';

export type RegistrationDisposer = () => Promise<void>;

export interface RegistrationOwner {
  effect(
    execute: () => (() => unknown) | Iterable<() => unknown, void, void>,
    label?: string,
  ): RegistrationDisposer;
}

/** Pair each caller-owned registration with the provider fiber, without retaining stale effects. */
export class RegistrationLifetime {
  constructor(private readonly provider: Context) {}

  owner(caller: Context): RegistrationOwner {
    return {
      effect: (execute, label) => {
        let dataDispose: RegistrationDisposer | undefined;
        let callerDispose: RegistrationDisposer | undefined;
        let providerGone = false;
        let callerGone = false;
        // Reserve the provider effect first. Cordis rejects inactive/unloading fibers
        // before execute() can mutate a store, including through a cached service view.
        const providerDispose = this.provider.effect(
          () => async () => {
            providerGone = true;
            await dataDispose?.();
            if (!callerGone) await callerDispose?.();
          },
          label,
        );
        try {
          dataDispose = caller.effect(execute, label);
          // A synchronous observer may start provider disposal during execute().
          if (providerGone) {
            void dataDispose();
            throw new Error('Registration provider unloaded during registration');
          }
          callerDispose = caller.effect(
            () => () => {
              callerGone = true;
              return providerGone ? dataDispose!() : providerDispose();
            },
            label,
          );
          return callerDispose;
        } catch (error) {
          void providerDispose();
          throw error;
        }
      },
    };
  }
}
