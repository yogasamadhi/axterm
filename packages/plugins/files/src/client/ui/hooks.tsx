import { clampFileManagerSplitPercent } from './arrangement-policy.ts';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { RemoteFileTarget } from '@axterm/plugin-api/files';
import type { FilesSessionOwner } from './session-owner.ts';
const Arrangement = createContext<
  | {
      fileManagerView: 'local' | 'remote' | 'split';
      fileManagerSplitPercent: number;
      activeFtpConnectionId: string | undefined;
      setFileManagerView: (view: 'local' | 'remote' | 'split') => void;
      setFileManagerSplitPercent: (value: number) => void;
      setActiveFtpConnection: (id: string | undefined) => void;
    }
  | undefined
>(undefined);
export function FilesArrangement({ children }: { children: ReactNode }) {
  const [fileManagerView, setFileManagerView] = useState<'local' | 'remote' | 'split'>('split'),
    [fileManagerSplitPercent, setPercent] = useState(50),
    [activeFtpConnectionId, setActiveFtpConnection] = useState<string>();
  return (
    <Arrangement.Provider
      value={{
        fileManagerView,
        fileManagerSplitPercent,
        activeFtpConnectionId,
        setFileManagerView,
        setFileManagerSplitPercent: (value) => setPercent(clampFileManagerSplitPercent(value)),
        setActiveFtpConnection,
      }}
    >
      {children}
    </Arrangement.Provider>
  );
}
export function useWorkspace<T>(
  select: (state: NonNullable<ReturnType<typeof useArrangement>>) => T,
): T {
  return select(useArrangement());
}
function useArrangement() {
  const value = useContext(Arrangement);
  if (!value) throw Error('FILES_ARRANGEMENT_UNAVAILABLE');
  return value;
}
export function useLocalDirectoryGrant(owner: FilesSessionOwner) {
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  return {
    grant: snapshot.grant,
    dropFailure: snapshot.dropFailure,
    select: owner.selectDirectory.bind(owner),
  };
}
export function useDirectory(
  owner: FilesSessionOwner,
  side: 'local' | 'remote',
  source: {
    grantId?: string | undefined;
    target?: RemoteFileTarget | undefined;
    path: string;
    enabled: boolean;
  },
) {
  const connectionId = source.target?.connectionId,
    protocol = source.target?.protocol;
  const pane = owner[side],
    state = useSyncExternalStore(pane.subscribe, pane.getSnapshot);
  useEffect(() => {
    if (!source.enabled) {
      void pane.clear().catch(() => {});
      return;
    }
    if (side === 'local' && source.grantId)
      void pane
        .navigate({ kind: 'local', grantId: source.grantId, path: source.path })
        .catch(() => {});
    else if (connectionId && protocol)
      void pane
        .navigate({ kind: 'remote', target: { connectionId, protocol }, path: source.path })
        .catch(() => {});
  }, [pane, side, source.grantId, connectionId, protocol, source.path, source.enabled]);
  return {
    data: state.status === 'ready' ? state.baseline : undefined,
    isLoading: state.status === 'connecting',
    isFetching: state.status === 'connecting',
    isError: state.status === 'error',
    error: state.status === 'error' ? Error('FILES_DIRECTORY_UNAVAILABLE') : undefined,
    refetch: () => pane.refresh(),
  };
}
export function useRemoteHome(
  owner: FilesSessionOwner,
  target: RemoteFileTarget | undefined,
  enabled: boolean,
) {
  const [state, setState] = useState<{ data?: { path: string }; isError: boolean }>({
    isError: false,
  });
  const connectionId = target?.connectionId,
    protocol = target?.protocol;
  useEffect(() => {
    if (!enabled || !connectionId || !protocol) return;
    let active = true;
    void owner
      .track((signal) => owner.files.getRemoteHome({ connectionId, protocol }, signal))
      .then(
        (data) => {
          if (active) setState({ data, isError: false });
        },
        () => {
          if (active) setState({ isError: true });
        },
      );
    return () => {
      active = false;
    };
  }, [owner, connectionId, protocol, enabled]);
  return state;
}
