import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AiPanelActions } from './panel-actions.ts';
import type { AiAttachmentPreview } from '@axterm/plugin-api/ai';
import { useI18n } from './i18n.tsx';
import type { AttachmentDraftOwner } from './attachment-draft-owner';

const noSubscribe = () => () => {};
const empty: readonly AiAttachmentPreview[] = Object.freeze([]);
const noSnapshot = () => empty;

type Client = Pick<
  AiPanelActions,
  | 'createAttachmentOwner'
  | 'createFileGrant'
  | 'revokeFileGrant'
  | 'prepareAiAttachment'
  | 'discardAiAttachment'
  | 'importDroppedFile'
>;

export function useAiAttachments(client: Client) {
  const { x } = useI18n();
  const [selectedOwner, setSelectedOwner] = useState<AttachmentDraftOwner>();
  const attachments = useSyncExternalStore(
    selectedOwner?.subscribe ?? noSubscribe,
    selectedOwner?.getSnapshot ?? noSnapshot,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [previewId, setPreviewId] = useState<string>();
  const ownerRef = useRef<AttachmentDraftOwner | undefined>(undefined);
  useEffect(() => {
    let owner: AttachmentDraftOwner | undefined;
    let stopped = false;
    queueMicrotask(() => {
      if (stopped) return;
      try {
        owner = client.createAttachmentOwner();
      } catch {
        setSelectedOwner(undefined);
        return;
      }
      ownerRef.current = owner;
      setSelectedOwner(owner);
    });
    return () => {
      stopped = true;
      const current = ownerRef.current;
      ownerRef.current = undefined;
      void current?.dispose().catch(() => {});
      if (current !== owner) void owner?.dispose().catch(() => {});
    };
  }, [client]);

  async function prepare(owner: AttachmentDraftOwner, operation: AbortController, grantId: string) {
    try {
      if (!owner.isCurrent(operation)) return;
      const preview = await client.prepareAiAttachment(grantId, operation.signal);
      const outcome = await owner.admit(operation, preview);
      if (!owner.isCurrent(operation)) return;
      if (outcome === 'accepted') {
        setPreviewId(preview.id);
      } else if (outcome === 'duplicate')
        setError(x('ai.attachmentDuplicate', { name: preview.name }));
      else if (outcome === 'limit') setError(x('ai.attachmentTotalTooLarge'));
    } finally {
      await client.revokeFileGrant(grantId).catch(() => undefined);
    }
  }

  async function choose() {
    const owner = ownerRef.current;
    const operation = owner?.begin();
    if (!owner || !operation) return;
    setBusy(true);
    setError('');
    try {
      const grant = await client.createFileGrant('open-file', operation.signal);
      if (grant) await prepare(owner, operation, grant.grantId);
    } catch {
      if (owner.isCurrent(operation)) setError(x('common.operationFailed'));
    } finally {
      if (owner.finish(operation)) {
        setBusy(false);
        setDragOver(false);
      }
    }
  }

  async function importDropped(files: FileList) {
    if (!files.length) return;
    const owner = ownerRef.current;
    const operation = owner?.begin();
    if (!owner || !operation) return;
    setBusy(true);
    setError('');
    try {
      for (const file of Array.from(files).slice(0, 8)) {
        if (!owner.isCurrent(operation)) break;
        try {
          const grant = await client.importDroppedFile(file, operation.signal);
          await prepare(owner, operation, grant.grantId);
        } catch {
          if (owner.isCurrent(operation)) setError(x('common.operationFailed'));
        }
      }
    } finally {
      if (owner.finish(operation)) {
        setBusy(false);
        setDragOver(false);
      }
    }
  }

  async function remove(id: string) {
    const owner = ownerRef.current;
    if (!owner) return;
    try {
      await owner.remove(id);
    } catch {
      setError(x('common.operationFailed'));
    }
    const next = owner.list();
    setPreviewId((current) => (current === id ? next.at(-1)?.id : current));
  }

  const current = useCallback(() => ownerRef.current?.list() ?? [], []);
  const cancel = useCallback(() => {
    ownerRef.current?.cancel();
    setBusy(false);
    setDragOver(false);
  }, []);
  const consume = useCallback((ids: readonly string[]) => {
    const owner = ownerRef.current;
    if (!owner) return;
    owner.consume(ids);
    setPreviewId(undefined);
  }, []);
  const reset = useCallback(() => {
    const owner = ownerRef.current;
    if (!owner) return;
    const replacement = client.createAttachmentOwner();
    ownerRef.current = replacement;
    setSelectedOwner(replacement);
    void owner.dispose().catch(() => {});
    setPreviewId(undefined);
    setBusy(false);
    setDragOver(false);
    setError('');
  }, [client]);
  return {
    attachments,
    busy,
    dragOver,
    setDragOver,
    error,
    previewId,
    setPreviewId,
    choose,
    importDropped,
    remove,
    current,
    consume,
    reset,
    cancel,
  };
}
