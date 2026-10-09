import { useCallback, useEffect, useRef, useState } from 'react';
import type { createRuntimeClient } from '@workspace/client';
import type { AiAttachmentPreview } from '@workspace/contracts';
import { useI18n } from '../../i18n/context';
import { AttachmentDraftOwner } from './attachment-draft-owner';

type Client = Pick<
  ReturnType<typeof createRuntimeClient>,
  | 'createFileGrant'
  | 'revokeFileGrant'
  | 'prepareAiAttachment'
  | 'discardAiAttachment'
  | 'importDroppedFile'
>;

export function useAiAttachments(client: Client) {
  const { x } = useI18n();
  const [attachments, setAttachments] = useState<AiAttachmentPreview[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [previewId, setPreviewId] = useState<string>();
  const ownerRef = useRef<AttachmentDraftOwner | undefined>(undefined);
  useEffect(() => {
    const owner = new AttachmentDraftOwner(client);
    ownerRef.current = owner;
    return () => {
      if (ownerRef.current === owner) ownerRef.current = undefined;
      void owner.dispose();
    };
  }, [client]);

  async function prepare(owner: AttachmentDraftOwner, operation: AbortController, grantId: string) {
    try {
      if (!owner.isCurrent(operation)) return;
      const preview = await client.prepareAiAttachment(grantId, operation.signal);
      const outcome = await owner.admit(operation, preview);
      if (!owner.isCurrent(operation)) return;
      if (outcome === 'accepted') {
        setAttachments(owner.list());
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
      const grant = await client.createFileGrant('open-file');
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
    const removed = owner.remove(id);
    const next = owner.list();
    setAttachments(next);
    setPreviewId((current) => (current === id ? next.at(-1)?.id : current));
    await removed;
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
    setAttachments(owner.list());
    setPreviewId(undefined);
  }, []);
  const reset = useCallback(() => {
    const owner = ownerRef.current;
    if (!owner) return;
    void owner.clear();
    setAttachments([]);
    setPreviewId(undefined);
    setBusy(false);
    setDragOver(false);
    setError('');
  }, []);
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
