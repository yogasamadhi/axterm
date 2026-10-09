import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { createRuntimeClient } from '@workspace/client';
import type { AiContextPreview, AiContextPreviewInput, AiRun } from '@workspace/contracts';
import { useI18n } from '../../i18n/context';

type Client = Pick<
  ReturnType<typeof createRuntimeClient>,
  'previewAiContext' | 'startAi' | 'cancelAi'
>;
interface ReviewOwner {
  disposed: boolean;
  busy: boolean;
  controller?: AbortController | undefined;
  preview?: AiContextPreview | undefined;
}

/** A single review belongs to this mounted panel and its current terminal target. */
export function useAiContextReview(client: Client, terminalId: string | undefined) {
  const { x } = useI18n();
  const [preview, setPreview] = useState<AiContextPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ownerRef = useRef<ReviewOwner | undefined>(undefined);
  useEffect(() => {
    const owner: ReviewOwner = { disposed: false, busy: false };
    ownerRef.current = owner;
    return () => {
      owner.disposed = true;
      owner.preview = undefined;
      owner.controller?.abort();
      if (ownerRef.current === owner) ownerRef.current = undefined;
    };
  }, [client]);
  const dismiss = useCallback(() => {
    const owner = ownerRef.current;
    if (!owner) return;
    owner.preview = undefined;
    owner.controller?.abort();
    setPreview(undefined);
    setError('');
  }, []);
  useLayoutEffect(() => dismiss(), [terminalId, dismiss]);

  async function prepare(
    input: (signal: AbortSignal, current: () => boolean) => Promise<AiContextPreviewInput>,
  ) {
    const owner = ownerRef.current;
    if (!owner || owner.disposed || owner.busy) return;
    const controller = new AbortController();
    owner.controller = controller;
    owner.busy = true;
    owner.preview = undefined;
    setBusy(true);
    setError('');
    setPreview(undefined);
    const current = () => !owner.disposed && !controller.signal.aborted;
    try {
      const request = await input(controller.signal, current);
      if (!current()) return;
      const next = await client.previewAiContext(request, controller.signal);
      if (!current()) return;
      owner.preview = next;
      setPreview(next);
    } catch {
      if (current()) setError(x('ai.reviewFailed'));
    } finally {
      owner.busy = false;
      if (owner.controller === controller) owner.controller = undefined;
      if (!owner.disposed) setBusy(false);
    }
  }

  async function send(committed: (run: AiRun, reviewed: AiContextPreview) => Promise<void>) {
    const owner = ownerRef.current;
    const reviewed = owner?.preview;
    if (!owner || owner.disposed || owner.busy || !reviewed) return;
    if (Date.parse(reviewed.reviewExpiresAt) <= Date.now()) {
      owner.preview = undefined;
      setPreview(undefined);
      setError(x('ai.reviewChanged'));
      return;
    }
    owner.busy = true;
    const controller = new AbortController();
    owner.controller = controller;
    setBusy(true);
    setError('');
    try {
      // Receive the run ID even after panel disposal so a late-created run can be canceled.
      const run = await client.startAi({
        ...reviewed.request,
        reviewReceipt: reviewed.reviewReceipt,
        reviewExpiresAt: reviewed.reviewExpiresAt,
      });
      if (owner.disposed || controller.signal.aborted) {
        await client.cancelAi(run.id).catch(() => undefined);
        return;
      }
      owner.preview = undefined;
      setPreview(undefined);
      await committed(run, reviewed);
    } catch {
      if (!owner.disposed && !controller.signal.aborted) {
        owner.preview = undefined;
        setPreview(undefined);
        setError(x('ai.reviewChanged'));
      }
    } finally {
      owner.busy = false;
      if (owner.controller === controller) owner.controller = undefined;
      if (!owner.disposed) setBusy(false);
    }
  }
  async function sendDirect(
    prepareRequest: (signal: AbortSignal) => Promise<AiContextPreviewInput>,
    committed: () => Promise<void>,
  ) {
    const owner = ownerRef.current;
    if (!owner || owner.disposed || owner.busy) return;
    const controller = new AbortController();
    owner.controller = controller;
    owner.busy = true;
    setBusy(true);
    setError('');
    try {
      const request = await prepareRequest(controller.signal);
      if (owner.disposed || controller.signal.aborted) return;
      const run = await client.startAi(request);
      if (owner.disposed || controller.signal.aborted) {
        await client.cancelAi(run.id).catch(() => undefined);
        return;
      }
      await committed();
    } catch {
      if (!owner.disposed && !controller.signal.aborted) setError(x('common.operationFailed'));
    } finally {
      owner.busy = false;
      if (owner.controller === controller) owner.controller = undefined;
      if (!owner.disposed) setBusy(false);
    }
  }
  return { preview, busy, error, dismiss, prepare, send, sendDirect };
}
