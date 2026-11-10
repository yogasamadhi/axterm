import type {
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionProfilePatch,
} from '@axterm/plugin-api/catalog';
export interface ConnectionProfileStore {
  list(): ConnectionProfile[];
  get(id: string): ConnectionProfile;
  create(input: ConnectionProfileInput): ConnectionProfile;
  update(id: string, input: ConnectionProfilePatch, ifMatch: string | undefined): ConnectionProfile;
  delete(id: string, ifMatch: string | undefined): ConnectionProfile;
}
