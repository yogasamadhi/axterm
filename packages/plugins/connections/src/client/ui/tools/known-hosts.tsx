import { useState, useSyncExternalStore } from 'react';
import { ShieldAlert, RefreshCw } from 'lucide-react';
import type { KnownHostKey } from '@axterm/plugin-api/connections';
import type { ConnectionsModel } from '../../index.ts';
import type { TunnelOperations } from './operations.ts';
import { useI18n } from './i18n.tsx';
import { cx } from './styles.ts';
import { ErrorBanner } from './scaffold.tsx';
export function KnownHostKeysPanel({
  model,
  operations,
}: {
  model: ConnectionsModel;
  operations: TunnelOperations;
}) {
  const { language, x } = useI18n();
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const command = useSyncExternalStore(operations.subscribe, operations.getSnapshot);
  const knownHostKeys = state.status === 'ready' ? state.baseline.knownHosts : [];
  const [revoking, setRevoking] = useState<string>();
  const [message, setMessage] = useState('');

  async function revoke(key: KnownHostKey) {
    if (!window.confirm(x('knownHosts.revokeConfirm', { host: key.host, port: key.port }))) return;
    setRevoking(key.id);
    setMessage('');
    try {
      await operations.fact((id) => model.deleteKnownHostKey(id, key.id, '"v' + key.version + '"'));

      setMessage(x('knownHosts.revokeSuccess', { host: key.host, port: key.port }));
    } catch {
      setMessage(x('common.operationFailed'));
    } finally {
      setRevoking(undefined);
    }
  }

  return (
    <section className={cx('surface known-host-keys-panel')} aria-label={x('knownHosts.title')}>
      <header>
        <div>
          <h3>
            <ShieldAlert size={15} aria-hidden="true" /> {x('knownHosts.title')}
          </h3>
          <p>{x('knownHosts.description')}</p>
        </div>
        <button
          type="button"
          onClick={() => void model.retry().catch(() => setMessage(x('common.operationFailed')))}
        >
          <RefreshCw size={13} aria-hidden="true" /> {x('knownHosts.refresh')}
        </button>
      </header>
      {state.status === 'connecting' ? (
        <p className={cx('hint')}>{x('knownHosts.loading')}</p>
      ) : null}
      {state.status === 'error' ? <ErrorBanner text={x('common.operationFailed')} /> : null}
      {knownHostKeys.length ? (
        <div className={cx('known-host-key-list')} role="list">
          {knownHostKeys.map((key) => (
            <article key={key.id} role="listitem">
              <div className={cx('known-host-key-target')}>
                <strong>
                  {key.host}:{key.port}
                </strong>
                <span>{key.algorithm}</span>
              </div>
              <code title={key.fingerprint}>{key.fingerprint}</code>
              <small>
                {x('knownHosts.seenDates', {
                  first: new Date(key.firstSeenAt).toLocaleString(language),
                  last: new Date(key.lastSeenAt).toLocaleString(language),
                })}
              </small>
              <button
                className={cx('danger')}
                disabled={!!revoking || command.busy || command.uncertain}
                onClick={() => void revoke(key)}
                type="button"
              >
                {revoking === key.id ? x('knownHosts.revoking') : x('knownHosts.revokeTrust')}
              </button>
            </article>
          ))}
        </div>
      ) : state.status === 'ready' ? (
        <p className={cx('known-host-key-empty')}>{x('knownHosts.empty')}</p>
      ) : null}
      {message ? (
        <p className={cx('hint')} role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
