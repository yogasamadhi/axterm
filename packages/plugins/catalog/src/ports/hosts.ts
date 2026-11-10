import type { Host, HostGroup, CreateHostInput, UpdateHostInput } from '@axterm/plugin-api/catalog';
export interface HostStore {
  listHostGroups(): HostGroup[];
  createHostGroup(input: { name: string; sortOrder: number }): HostGroup;
  updateHostGroup(
    id: string,
    input: { name?: string | undefined; sortOrder?: number | undefined },
    ifMatch: string | undefined,
  ): HostGroup;
  deleteHostGroup(id: string, ifMatch: string | undefined): void;
  listHosts(): Host[];
  getHost(id: string): Host;
  assertHostVersion(id: string, ifMatch: string | undefined): Host;
  hostRetentionReasons(id: string): Array<'bookmark' | 'jumpHost' | 'history' | 'tunnel'>;
  createHost(input: CreateHostInput): Host;
  updateHost(id: string, input: UpdateHostInput, ifMatch: string | undefined): Host;
  deleteHost(id: string, ifMatch: string | undefined): void;
}
