import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { TranslateNS, PropsLocale } from '@axterm/ui';
import { Dialog, DialogContent, DialogTitle } from '@axterm/ui/controls';
import type { Interaction } from '@axterm/plugin-api/connections';
import type { ConnectionsModel } from '../index.ts';
import type { InteractionResponses } from './response-owner.ts';
import styles from './ui.module.css';
const cx = (...names: (string | undefined)[]) =>
  names
    .filter(Boolean)
    .join(' ')
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');
export function ConnectionInteractions({
  model,
  responses,
  t,
}: { model: ConnectionsModel; responses: InteractionResponses } & PropsLocale<'connections'>) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  if (state.status !== 'ready') return null;
  const current = state.baseline.interactions[0];
  return current ? (
    <InteractionForm
      key={state.baseline.generation + ':' + current.id}
      current={current}
      generation={state.baseline.generation}
      responses={responses}
      x={t}
    />
  ) : null;
}
function Modal({
  title,
  onClose,
  children,
  className,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  className: string;
}) {
  const modal = useRef<HTMLDivElement>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        ref={modal}
        className={cx('modal', className)}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          const target = modal.current?.querySelector<HTMLElement>(
            '[data-autofocus]:not(:disabled)',
          );
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <header className={cx('modal-heading')}>
          <DialogTitle asChild>
            <h2>{title}</h2>
          </DialogTitle>
        </header>
        {children}
      </DialogContent>
    </Dialog>
  );
}
function InteractionForm({
  current,
  generation,
  responses,
  x,
}: {
  current: Interaction;
  generation: string;
  responses: InteractionResponses;
  x: TranslateNS<'connections'>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [missingHostKeyConfirmationId, setMissingHostKeyConfirmationId] = useState<string>();
  const hostKeyInteraction = current.kind === 'unknownHostKey' || current.kind === 'changedHostKey';
  const hostKeyPresentation =
    current.presentation?.kind === 'sshHostKey' ? current.presentation : undefined;
  const keyboardPresentation =
    current.presentation?.kind === 'keyboardInteractive' ? current.presentation : undefined;
  const interactionTitle = hostKeyPresentation
    ? x(
        current.kind === 'changedHostKey'
          ? 'interaction.changedHostKeyTitle'
          : 'interaction.unknownHostKeyTitle',
      )
    : keyboardPresentation
      ? x('interaction.keyboardTitle', {
          name: keyboardPresentation.challengeName || x('interaction.keyboardDefaultName'),
          attempt: keyboardPresentation.attempt,
        })
      : current.title;
  const target = hostKeyPresentation ?? keyboardPresentation;
  const targetLabel = target ? `${target.username}@${target.hostname}:${target.port}` : undefined;
  async function respond(accepted: boolean, remember = false, values: Record<string, string> = {}) {
    if (locked.current) return;
    locked.current = true;
    setFailed(false);
    setSubmitting(true);
    try {
      await responses.respond(generation, current.id, { accepted, remember, values });
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      locked.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }
  return (
    <Modal
      className={cx(
        hostKeyPresentation
          ? `interaction-modal host-key-interaction-modal ${current.kind === 'changedHostKey' ? 'changed' : 'unknown'}`
          : keyboardPresentation
            ? 'interaction-modal keyboard-interaction-modal'
            : 'interaction-modal',
      )}
      title={interactionTitle}
      onClose={() => void respond(false)}
    >
      <form
        key={current.id}
        className={cx('stack')}
        data-interaction-kind={current.kind}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const remember = data.get('remember') === 'on';
          if (current.kind === 'changedHostKey' && !remember) {
            setMissingHostKeyConfirmationId(current.id);
            return;
          }
          setMissingHostKeyConfirmationId(undefined);
          const values = Object.fromEntries(
            current.fields.map((field) => [field.id, String(data.get(field.id) ?? '')]),
          );
          void respond(true, remember, values);
        }}
      >
        {hostKeyPresentation ? (
          <section
            className={cx('host-key-interaction-detail')}
            role={current.kind === 'changedHostKey' ? 'alert' : 'status'}
            aria-label={
              current.kind === 'changedHostKey'
                ? x('interaction.hostKeyChangedSummary')
                : x('interaction.hostKeyUnknownSummary')
            }
          >
            <div className={cx('host-key-interaction-summary')}>
              <ShieldAlert aria-hidden="true" size={18} />
              <strong>
                {current.kind === 'changedHostKey'
                  ? x('interaction.hostKeyChangedSummary')
                  : x('interaction.hostKeyUnknownSummary')}
              </strong>
              {current.kind === 'changedHostKey' ? (
                <span>{x('interaction.hostKeyHighRisk')}</span>
              ) : null}
            </div>
            <dl>
              <div>
                <dt>{x('interaction.hostKeyTarget')}</dt>
                <dd>
                  <code dir="ltr">{targetLabel}</code>
                </dd>
              </div>
              <div>
                <dt>{x('interaction.hostKeyAlgorithm')}</dt>
                <dd>
                  <code dir="ltr">{hostKeyPresentation.algorithm}</code>
                </dd>
              </div>
              {hostKeyPresentation.previousFingerprint ? (
                <div>
                  <dt>{x('interaction.hostKeySavedFingerprint')}</dt>
                  <dd>
                    <code dir="ltr">{hostKeyPresentation.previousFingerprint}</code>
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>
                  {x(
                    hostKeyPresentation.previousFingerprint
                      ? 'interaction.hostKeyPresentedFingerprint'
                      : 'interaction.hostKeyFingerprint',
                  )}
                </dt>
                <dd>
                  <code dir="ltr">{hostKeyPresentation.fingerprint}</code>
                </dd>
              </div>
            </dl>
            <p>
              {x(
                current.kind === 'changedHostKey'
                  ? 'interaction.hostKeyChangedGuidance'
                  : 'interaction.hostKeyVerifyGuidance',
              )}
            </p>
          </section>
        ) : keyboardPresentation ? (
          <section className={cx('keyboard-interaction-detail')}>
            <code dir="ltr">{targetLabel}</code>
            {keyboardPresentation.instructions ? <p>{keyboardPresentation.instructions}</p> : null}
            <p>{x('interaction.keyboardSummary', { count: keyboardPresentation.promptCount })}</p>
          </section>
        ) : (
          <p className={cx(current.severity === 'high' ? 'danger-text' : '')}>{current.detail}</p>
        )}
        {current.fields.map((field) => (
          <label key={field.id}>
            {field.label}
            <input
              name={field.id}
              type={field.secret ? 'password' : 'text'}
              autoComplete="off"
              maxLength={131072}
              required
              autoFocus={field.id === current.fields[0]?.id}
            />
          </label>
        ))}
        {hostKeyInteraction && (
          <label className={cx('check')}>
            <input
              defaultChecked={current.kind !== 'changedHostKey'}
              type="checkbox"
              name="remember"
              aria-invalid={missingHostKeyConfirmationId === current.id ? 'true' : undefined}
              aria-describedby={
                missingHostKeyConfirmationId === current.id
                  ? `host-key-confirmation-error-${current.id}`
                  : undefined
              }
              onChange={(event) => {
                if (event.currentTarget.checked) setMissingHostKeyConfirmationId(undefined);
              }}
            />{' '}
            {current.kind === 'changedHostKey'
              ? x('interaction.confirmChangedHostKey')
              : x('interaction.rememberHostKey')}
          </label>
        )}
        {current.kind === 'changedHostKey' && missingHostKeyConfirmationId === current.id ? (
          <p
            className={cx('host-key-confirmation-error')}
            id={`host-key-confirmation-error-${current.id}`}
            role="alert"
          >
            {x('interaction.confirmChangedHostKeyRequired')}
          </p>
        ) : null}
        {failed && (
          <p role="alert" className={cx('form-error')}>
            {x('common.operationFailed')}
          </p>
        )}
        <div className={cx('modal-actions')}>
          <button
            data-autofocus={hostKeyInteraction ? '' : undefined}
            type="button"
            disabled={submitting}
            onClick={() => void respond(false)}
          >
            {x('panels.reject')}
          </button>
          <button
            className={cx(current.severity === 'high' ? 'danger' : 'primary')}
            disabled={submitting}
          >
            {submitting
              ? x('interaction.submitting')
              : current.kind === 'changedHostKey'
                ? x('interaction.replaceAndConnect')
                : current.kind === 'unknownHostKey'
                  ? x('interaction.trustAndConnect')
                  : x('interaction.confirm')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
