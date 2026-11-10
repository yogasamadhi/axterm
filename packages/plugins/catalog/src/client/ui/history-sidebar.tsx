import { useState, useSyncExternalStore } from 'react';
import type { CatalogModel } from '../index.ts';
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
import type { ConnectionHistoryItem } from '@axterm/plugin-api/catalog';
import { Dialog, DialogContent, DialogTitle, Button, Input } from '@axterm/ui/controls';
import { HistoryPanel } from './history-panel.tsx';
import type { HistoryView } from './history-view.ts';
import type { HistoryActions } from './history-actions.ts';
import { historyReconnectRequirement } from './history-actions.ts';
import { connectionHistoryTarget } from './history-model.ts';
import { useI18n } from './i18n.tsx';
import styles from './history.module.css';
export function ConnectionHistorySidebar({
  model,
  settings,
  view,
  actions,
}: {
  model: CatalogModel;
  settings: ConfigurationClientActions;
  view: HistoryView;
  actions: HistoryActions;
}) {
  const { x } = useI18n();
  const selected = useSyncExternalStore(view.subscribe, view.getSnapshot);
  const operation = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
  const configuration = useSyncExternalStore(settings.subscribe, settings.getSnapshot);
  const facts = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [secretItem, setSecretItem] = useState<{
    item: ConnectionHistoryItem;
    generation: string;
  }>();
  const [notice, setNotice] = useState(false);
  const [secretError, setSecretError] = useState(false);
  const ready =
    configuration.status === 'ready' &&
    facts.status === 'ready' &&
    configuration.baseline.generation === facts.baseline.generation;
  const privacy =
    configuration.status === 'ready' ? configuration.baseline.settings.privacy : undefined;
  const currentSecret =
    secretItem && facts.status === 'ready' && facts.baseline.generation === secretItem.generation
      ? selected.page?.items.find(
          (item) => item.id === secretItem.item.id && item.version === secretItem.item.version,
        )
      : undefined;
  return (
    <>
      <div className={styles['history-container']}>
        <HistoryPanel
          page={ready ? selected.page : undefined}
          selectedSort={selected.sort}
          enabled={privacy?.connectionHistoryEnabled ?? false}
          hideAddresses={privacy?.hideAddresses ?? true}
          busy={!ready || selected.busy || operation.busy || operation.uncertain}
          error={selected.failed || configuration.status === 'error' ? x('history.loadFailed') : ''}
          notice={
            notice
              ? x('history.privateKeyMissing')
              : operation.failed
                ? x('history.actionFailed')
                : ''
          }
          onDismissNotice={() => {
            setNotice(false);
            actions.dismiss();
          }}
          onRetry={() => {
            view.retry();
            void settings.retry();
          }}
          onSort={(sort) => view.sort(sort)}
          onLoadMore={() => view.more()}
          onReconnect={(item) => {
            const requirement = historyReconnectRequirement(item);
            if (requirement === 'one-time-secret') {
              setSecretError(false);
              if (facts.status === 'ready')
                setSecretItem({ item, generation: facts.baseline.generation });
            } else if (requirement === 'configure-private-key') setNotice(true);
            else void actions.connect(item);
          }}
          onPromote={(item) => {
            void actions.promote(item);
          }}
          onDelete={(item) => {
            void actions.remove(item);
          }}
          onClear={() => {
            if (selected.page) void actions.clear(selected.page.etag);
          }}
          onSetEnabled={(enabled) => {
            void actions.enabled(enabled);
          }}
        />
        {operation.uncertain && (
          <Button
            data-history-retry
            onClick={() => {
              void actions.retry();
            }}
            disabled={operation.busy}
          >
            {x('history.retryPending')}
          </Button>
        )}
      </div>
      <Dialog
        open={!!currentSecret}
        onOpenChange={(open) => {
          if (!open && !operation.busy) setSecretItem(undefined);
        }}
      >
        <DialogContent
          className={styles['history-secret']}
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (operation.busy) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (operation.busy) event.preventDefault();
          }}
        >
          <DialogTitle>
            {x('history.reconnectNamed', { name: currentSecret?.name ?? '' })}
          </DialogTitle>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!currentSecret) return;
              const form = event.currentTarget;
              const secret = String(new FormData(form).get('secret') ?? '');
              if (!secret) {
                setSecretError(true);
                return;
              }
              void actions.connect(currentSecret, secret).then((success) => {
                form.reset();
                if (success) setSecretItem(undefined);
                else setSecretError(true);
              });
            }}
          >
            <p>
              {currentSecret &&
                connectionHistoryTarget(currentSecret, privacy?.hideAddresses ?? true)}
            </p>
            <label>
              {currentSecret?.authType === 'keyboardInteractive'
                ? x('history.interactiveResponse')
                : x('history.oneTimePassword')}
              <Input
                name="secret"
                type="password"
                autoComplete="off"
                maxLength={131072}
                disabled={operation.busy}
                onInput={() => setSecretError(false)}
              />
            </label>
            <small>{x('history.secretNotSaved')}</small>
            {secretError && <p role="alert">{x('history.reconnectFailed')}</p>}
            <footer>
              <Button
                type="button"
                disabled={operation.busy}
                onClick={() => setSecretItem(undefined)}
              >
                {x('common.cancel')}
              </Button>
              <Button type="submit" disabled={operation.busy}>
                {operation.busy ? x('history.connecting') : x('history.connect')}
              </Button>
            </footer>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
