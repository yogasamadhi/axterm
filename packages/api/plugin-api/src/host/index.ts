import type { NativeDesktopLifecycle } from '../desktop-lifecycle.ts';
import type { NativeWebViews } from '../native-web.ts';
import type { NativeDesktopWindows } from '../desktop-window.ts';
export type { NativeWebViews } from '../native-web.ts';
import type { NativeDesktopLaunches } from './desktop-launches.ts';
export type * from './desktop-launches.ts';
import type { StorageHub, StorageDomainFacility } from '../storage.ts';
import type { RuntimeIdentity } from '../runtime-identity.ts';
import type { TypertGateway } from '../gateway-types.ts';
export type * from '../gateway-types.ts';
declare module '@deepseek-ai/cordis' {
  interface Context {
    storage: StorageHub;
    storageDomain: StorageDomainFacility;
    readonly runtimeIdentity: RuntimeIdentity;
    typertGateway: TypertGateway;
    nativeDesktopLaunches: NativeDesktopLaunches;
    nativeWebViews: NativeWebViews;
    nativeDesktopWindows: NativeDesktopWindows;
    nativeDesktopLifecycle: NativeDesktopLifecycle;
  }
}

declare module '../types.ts' {
  interface RemoteErrorDetailsMap {
    'desktop/not-ready': object;
  }
}

export type * from './storage-bootstrap.ts';
export type * from './desktop-tasks.ts';
export type * from './remote-events.ts';
export type * from './catalog.ts';
export type * from './configuration.ts';
export type * from './terminals.ts';
export type * from './terminal-channel.ts';
export { SHELL_INTEGRATION_SENTINEL_VARIABLE } from './terminal-channel.ts';
export type * from './connections.ts';
export type * from './files.ts';
export { fileAuthoritySchema, fileIdentitySchema } from './files.ts';

export type * from './remote-files.ts';
export { RemoteFileCapabilityUnavailableError } from './remote-files.ts';
export type * from './transfers.ts';

export type * from './automation.ts';

export type * from './credentials.ts';

export type * from './saved-credentials.ts';

export type * from './subprocess.ts';

export type * from './ai.ts';
export type * from './plugins.ts';

export type * from './desktop-utilities.ts';
