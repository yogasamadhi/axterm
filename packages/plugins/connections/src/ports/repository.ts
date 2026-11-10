import type {
  Host,
  KnownHostKey,
  Settings,
  ConnectionProfile,
} from '@axterm/plugin-api/connections';
export interface ConnectionRepository {
  getHost(id: string): Host;
  getSettings(): Settings;
  getKnownHostKey(host: string, port: number): KnownHostKey | undefined;
  saveKnownHostKey(
    input: Omit<
      KnownHostKey,
      'id' | 'firstSeenAt' | 'lastSeenAt' | 'createdAt' | 'updatedAt' | 'version'
    >,
    expected?: { readonly version: number } | null,
  ): KnownHostKey;
}
export interface ConnectionProfiles {
  get(id: string): ConnectionProfile;
}
