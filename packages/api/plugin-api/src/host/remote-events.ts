import type { TypertForwardableEventEntry, TypertRemoteEvent } from '../types.ts';
import type { TypertRemoteEventContext } from '../gateway-types.ts';
export type RemoteEventContextSelector = (
  receiver: unknown,
  request: object,
) => TypertRemoteEventContext | undefined;
type Registration<Entry> = Entry extends { mode: 'waterfall' }
  ? Entry & { readonly context: RemoteEventContextSelector }
  : Entry;
export type RemoteEventRegistration = Registration<
  Extract<TypertForwardableEventEntry, { event: TypertRemoteEvent }>
>;
export interface RemoteEventSelections {
  register(entry: RemoteEventRegistration): () => Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteEvents: RemoteEventSelections;
  }
}
