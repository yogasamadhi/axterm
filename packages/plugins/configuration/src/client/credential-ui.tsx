import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsLocale } from '@axterm/ui';
import {
  Button,
  Input,
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@axterm/ui/controls';
import {
  savedCredentialKindSchema,
  type CredentialCommandReceipt,
} from '@axterm/plugin-api/saved-credentials';
import type { SavedCredentialsModel } from './credentials.ts';
import styles from './ui.module.css';
/** Secret inputs live only in the current form element and its single submitted command. */
export function SavedCredentialsPanel({
  model,
  t,
}: {
  model: SavedCredentialsModel;
  t: PropsLocale<'configuration'>['t'];
}) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [kind, setKind] = useState('sshPassword');
  const [selected, setSelected] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string>();
  const [notice, setNotice] = useState<
    'credentialSaved' | 'credentialDeleted' | 'credentialUncertain' | 'credentialFailed'
  >();
  const secret = useRef<HTMLInputElement>(null);
  const label = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const input = secret.current;
    return () => {
      alive.current = false;
      if (input) input.value = '';
    };
  }, []);
  function accept(receipt: CredentialCommandReceipt) {
    if (!alive.current) return;
    if (receipt.status === 'completed') {
      setNotice(receipt.operation === 'delete' ? 'credentialDeleted' : 'credentialSaved');
      setPending(undefined);
      setSelected(undefined);
      setDeleting(undefined);
      if (label.current) label.current.value = '';
    } else if (receipt.status === 'failed' || receipt.status === 'expired') {
      setNotice('credentialFailed');
      setPending(undefined);
    } else setNotice('credentialUncertain');
  }
  async function submit(
    operation: () => { commandId: string; result: Promise<CredentialCommandReceipt> },
  ) {
    if (active.current || pending) return;
    active.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      let command;
      try {
        command = operation();
      } catch {
        setNotice('credentialFailed');
        return;
      }
      setPending(command.commandId);
      accept(await command.result);
    } catch {
      if (alive.current) setNotice('credentialUncertain');
    } finally {
      active.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function check() {
    if (!pending || active.current) return;
    active.current = true;
    setBusy(true);
    try {
      accept(await model.outcome(pending));
    } catch {
      if (alive.current) setNotice('credentialUncertain');
    } finally {
      active.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const ready = state.status === 'ready';
  return (
    <section
      className={styles.group}
      aria-labelledby="configuration-credentials"
      data-configuration-credentials=""
    >
      <h2 id="configuration-credentials">{t('credentialsTitle')}</h2>
      <p className={styles.hint}>{t('credentialsDescription')}</p>
      {ready ? (
        <ul className={styles.credentials}>
          {state.baseline.credentials.map((item) => (
            <li key={item.ref} data-credential-ref={item.ref}>
              <strong>{item.label}</strong>
              <span>{item.kind}</span>
              <span title={t('credentialCreatedAt')}>{item.createdAt}</span>
              <span title={t('credentialUpdatedAt')}>{item.updatedAt}</span>
              <div className={styles.actions}>
                <Button
                  disabled={busy || !!pending}
                  onClick={() => {
                    setSelected(item.ref);
                    setDeleting(undefined);
                    if (secret.current) secret.current.value = '';
                  }}
                >
                  {t('credentialReplace')}
                </Button>
                <Button
                  disabled={busy || !!pending}
                  onClick={() => {
                    setDeleting(item.ref);
                    setSelected(undefined);
                    if (secret.current) secret.current.value = '';
                  }}
                >
                  {t('credentialDelete')}
                </Button>
              </div>
              {deleting === item.ref && (
                <div className={styles.actions}>
                  <Button
                    disabled={busy || !!pending}
                    onClick={() => void submit(() => model.remove(item.ref))}
                  >
                    {t('credentialConfirmDelete')}
                  </Button>
                  <Button disabled={busy} onClick={() => setDeleting(undefined)}>
                    {t('credentialCancel')}
                  </Button>
                </div>
              )}
            </li>
          ))}
          {!state.baseline.credentials.length && <li>{t('credentialsEmpty')}</li>}
        </ul>
      ) : (
        <div role="alert">
          <p>{t('credentialsFailed')}</p>
          <Button disabled={busy} onClick={() => void model.retry().catch(() => {})}>
            {t('credentialsReload')}
          </Button>
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!secret.current || !ready || busy || pending) return;
          const value = secret.current.value;
          secret.current.value = '';
          void submit(() =>
            selected
              ? model.replace(selected, value)
              : model.create({
                  kind: savedCredentialKindSchema.parse(kind),
                  label: label.current?.value ?? '',
                  secret: value,
                }),
          );
        }}
      >
        {!selected && (
          <>
            <Label htmlFor="credential-label">{t('credentialLabel')}</Label>
            <Input
              id="credential-label"
              ref={label}
              required
              maxLength={100}
              disabled={!ready || busy || !!pending}
            />
            <Label htmlFor="credential-kind">{t('credentialKind')}</Label>
            <Select value={kind} onValueChange={setKind} disabled={!ready || busy || !!pending}>
              <SelectTrigger id="credential-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {savedCredentialKindSchema.options.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        <Label htmlFor="credential-secret">{t('credentialSecret')}</Label>
        <Input
          id="credential-secret"
          ref={secret}
          type="password"
          autoComplete="new-password"
          required
          maxLength={131072}
          disabled={!ready || busy || !!pending}
        />
        <div className={styles.actions}>
          <Button type="submit" disabled={!ready || busy || !!pending}>
            {t(selected ? 'credentialReplace' : 'credentialCreate')}
          </Button>
          {selected && (
            <Button
              disabled={busy || !!pending}
              onClick={() => {
                setSelected(undefined);
                if (secret.current) secret.current.value = '';
              }}
            >
              {t('credentialCancel')}
            </Button>
          )}
        </div>
      </form>
      <p
        role={
          notice === 'credentialFailed' || notice === 'credentialUncertain' ? 'alert' : 'status'
        }
      >
        {notice ? t(notice) : ''}
      </p>
      {pending && (
        <Button disabled={busy} onClick={() => void check()}>
          {t('credentialOutcome')}
        </Button>
      )}
    </section>
  );
}
