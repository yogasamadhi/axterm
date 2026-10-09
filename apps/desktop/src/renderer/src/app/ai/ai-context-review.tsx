import type { AiContextPreview, AiContextSource } from '@workspace/contracts';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n/context';
import type { AxtermMessageKey } from '../../i18n/core';
import { Modal } from '../ui/panel-scaffold';
import { formatBytes } from '../ui/format';

const sourceKeys: Record<AiContextSource['kind'], AxtermMessageKey> = {
  system: 'ai.reviewSystem',
  prompt: 'ai.reviewPrompt',
  history: 'ai.reviewHistory',
  context: 'ai.reviewContext',
  attachment: 'ai.reviewAttachment',
};

export function AiContextReview({
  preview,
  busy,
  onClose,
  onSend,
}: {
  preview: AiContextPreview;
  busy: boolean;
  onClose(): void;
  onSend(): void;
}) {
  const { x, language } = useI18n();
  return createPortal(
    <Modal title={x('ai.reviewTitle')} onClose={onClose} className="ai-context-review">
      <p>{x('ai.reviewHint')}</p>
      <dl className="ai-review-target">
        <div>
          <dt>{x('ai.target')}</dt>
          <dd>{preview.request.terminalId ?? x('ai.reviewNoTerminal')}</dd>
        </div>
        <div>
          <dt>{x('panels.model')}</dt>
          <dd>{preview.request.modelId}</dd>
        </div>
        <div>
          <dt>
            {x('panels.expiresAt', {
              time: new Date(preview.reviewExpiresAt).toLocaleTimeString(language),
            })}
          </dt>
          <dd>{x('ai.reviewExpiryHint')}</dd>
        </div>
      </dl>
      <div className="ai-review-sources" aria-label={x('ai.reviewSources')}>
        {preview.sources.map((source, index) => (
          <div key={index}>
            <strong>{source.name ?? x(sourceKeys[source.kind])}</strong>
            <span>
              {x('ai.reviewSize', {
                included: formatBytes(source.includedBytes),
                original: formatBytes(source.originalBytes),
              })}
            </span>
            {source.availableItems !== undefined && (
              <span>
                {x('ai.reviewHistoryCount', {
                  selected: source.selectedItems ?? 0,
                  total: source.availableItems,
                })}
              </span>
            )}
            {source.redacted && <em>{x('ai.redacted')}</em>}
            {source.truncated && <em>{x('ai.truncated')}</em>}
          </div>
        ))}
      </div>
      <details open>
        <summary>{x('ai.reviewPrompt')}</summary>
        <pre>{preview.prompt}</pre>
      </details>
      <details>
        <summary>{x('ai.reviewSystem')}</summary>
        <pre>{preview.system}</pre>
      </details>
      <details>
        <summary>{x('ai.reviewContext')}</summary>
        <pre>{preview.context || x('ai.reviewEmptyContext')}</pre>
      </details>
      <div className="ai-review-actions">
        <button type="button" onClick={onClose}>
          {x('ai.reviewEdit')}
        </button>
        <button type="button" className="primary" disabled={busy} onClick={onSend}>
          {x('ai.reviewSend')}
        </button>
      </div>
    </Modal>,
    document.body,
  );
}
