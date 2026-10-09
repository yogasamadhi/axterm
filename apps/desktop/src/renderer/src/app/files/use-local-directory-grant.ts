import { useCallback, useEffect, useRef, useState } from 'react';
import type { createRuntimeClient } from '@workspace/client';
import type { FileGrant } from '@workspace/contracts/desktop';
import { LocalDirectoryGrantOwner } from './local-directory-grant-owner';

type Client = Pick<ReturnType<typeof createRuntimeClient>, 'createFileGrant' | 'revokeFileGrant'>;
type DirectoryIntent = 'home-directory' | 'open-directory' | 'directory-path';

export function useLocalDirectoryGrant(client: Client, initial?: FileGrant) {
  const [grant, setGrant] = useState(initial);
  const ownerRef = useRef<LocalDirectoryGrantOwner | undefined>(undefined);
  useEffect(() => {
    const owner = new LocalDirectoryGrantOwner(client, initial);
    ownerRef.current = owner;
    return () => {
      if (ownerRef.current === owner) ownerRef.current = undefined;
      void owner.dispose();
    };
  }, [client, initial]);

  const select = useCallback(
    async (intent: DirectoryIntent, path?: string) => {
      const owner = ownerRef.current;
      if (!owner) return;
      const ticket = owner.beginSelection();
      try {
        const next = await client.createFileGrant(intent, path);
        if (!next || !(await owner.adopt(ticket, next))) return;
        setGrant(next);
        return next;
      } catch (cause) {
        if (owner.isCurrent(ticket)) throw cause;
        return;
      }
    },
    [client],
  );
  return { grant, select };
}
