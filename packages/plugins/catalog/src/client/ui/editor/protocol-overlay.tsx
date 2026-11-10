import { useSyncExternalStore } from 'react';
import type { CatalogEditorOwner } from './owner.ts';
import {
  FtpBookmarkDialog,
  TelnetBookmarkDialog,
  SerialBookmarkDialog,
  RdpBookmarkDialog,
  VncBookmarkDialog,
  SpiceBookmarkDialog,
  WebBookmarkDialog,
} from './protocol-editors.tsx';
import { useI18n } from '../i18n.tsx';
const editors = {
  ftp: FtpBookmarkDialog,
  telnet: TelnetBookmarkDialog,
  serial: SerialBookmarkDialog,
  rdp: RdpBookmarkDialog,
  vnc: VncBookmarkDialog,
  spice: SpiceBookmarkDialog,
  web: WebBookmarkDialog,
};
export function CatalogProtocolOverlay({ owner }: { owner: CatalogEditorOwner }) {
  const { x } = useI18n();
  const selected = useSyncExternalStore(owner.subscribe, owner.getSnapshot),
    facts = useSyncExternalStore(
      owner.services.catalog.subscribe,
      owner.services.catalog.getSnapshot,
    ),
    terminals = useSyncExternalStore(
      owner.services.terminals.subscribe,
      owner.services.terminals.getSnapshot,
    );
  if (
    !selected.session ||
    selected.session.protocol === 'ssh' ||
    facts.status !== 'ready' ||
    terminals.status !== 'ready'
  )
    return null;
  const session = selected.session,
    Editor = editors[session.protocol];
  return (
    <Editor
      key={session.id}
      initialTarget={owner.initialTarget(session.id)}
      bookmarkTree={facts.baseline.bookmarks}
      {...(session.bookmark ? { bookmark: session.bookmark } : {})}
      defaultGroupId={session.bookmark?.groupId ?? null}
      hosts={[...facts.baseline.hosts]}
      profiles={facts.baseline.connectionProfiles}
      terminalProfiles={terminals.baseline.profiles}
      ports={[...selected.ports]}
      portsError={selected.portsFailed ? x('common.operationFailed') : undefined}
      onRefreshPorts={() => {
        void owner.refreshPorts();
      }}
      workflow={session.workflow}
      onClose={() => {
        void owner.close();
      }}
      onSaved={(receipt, connect) => owner.savedProtocol(receipt, connect)}
    />
  );
}
