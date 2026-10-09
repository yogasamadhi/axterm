import { AsyncLocalStorage } from 'node:async_hooks';

export const modelFetchScope = new AsyncLocalStorage<typeof globalThis.fetch>();
export const scopedModelFetch: typeof globalThis.fetch = (input, init) => {
  const fetch = modelFetchScope.getStore();
  if (!fetch) throw new Error('Model transport scope is unavailable');
  return fetch(input, init);
};
