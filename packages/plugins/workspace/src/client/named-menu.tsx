import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { Save, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@axterm/ui/controls';
import type { NamedWorkspace } from '@axterm/plugin-api/configuration';
import type { NamedWorkspaces } from './named-workspaces.ts';
import dictionaries from './named-locales.json' with { type: 'json' };
import styles from './workspace.module.css';
export { dictionaries as namedDictionaries };
export type NamedTranslate = (
  key: keyof typeof dictionaries.en,
  values?: Record<string, unknown>,
) => string;
declare module '@axterm/ui' {
  interface LocaleNamespaceMap {
    namedWorkspaces: keyof typeof dictionaries.en;
  }
}
const cls = (...names: string[]) =>
  names.map((name) => name + ' ' + (styles[name] ?? '')).join(' ');
export function NamedWorkspaceMenu({ owner, x }: { owner: NamedWorkspaces; x: NamedTranslate }) {
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot),
    [name, setName] = useState(''),
    [confirm, setConfirm] = useState<
      { kind: 'overwrite' | 'delete'; workspace: NamedWorkspace } | undefined
    >();
  let items: readonly NamedWorkspace[] = [],
    active: string | null = null;
  try {
    items = owner.list();
    active = owner.active();
  } catch {
    /* The existing owner exposes unavailable facts through its status. */
  }
  const perform = (operation: () => Promise<unknown>) => {
    void operation().catch(() => undefined);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    const normalized = name.trim();
    if (!normalized || state.busy) return;
    const existing = items.find(
      (item) => item.name.localeCompare(normalized, undefined, { sensitivity: 'accent' }) === 0,
    );
    if (existing) {
      setConfirm({ kind: 'overwrite', workspace: existing });
      return;
    }
    perform(async () => {
      if (await owner.save(normalized)) setName('');
    });
  };
  return (
    <div className={cls('workspace-menu')} data-named-workspaces="">
      <form onSubmit={save}>
        <input
          aria-label={x('shell.workspaceName')}
          placeholder={x('shell.workspaceName')}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          maxLength={80}
        />
        <button
          className={cls('primary')}
          type="submit"
          disabled={!name.trim() || state.busy || state.uncertain}
        >
          <Save size={13} />
          {x('common.save')}
        </button>
      </form>
      <div className={cls('workspace-list-menu')}>
        {items.map((workspace) => (
          <div className={active === workspace.id ? cls('active') : ''} key={workspace.id}>
            <button
              type="button"
              disabled={state.busy || state.uncertain}
              onClick={() => perform(() => owner.load(workspace.id))}
            >
              <span>{workspace.name}</span>
              <small>{new Date(workspace.updatedAt).toLocaleDateString()}</small>
            </button>
            <button
              type="button"
              className={cls('workspace-delete')}
              disabled={state.busy || state.uncertain}
              aria-label={x('shell.deleteWorkspace', { name: workspace.name })}
              onClick={() => setConfirm({ kind: 'delete', workspace })}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {!items.length && <p>{x('shell.noSavedWorkspaces')}</p>}
      </div>
      {state.failed && (
        <div role="alert" className={cls('toast', 'error', 'named-error')}>
          <span>{x('app.saveWorkspaceError')}</span>
          {state.uncertain && (
            <button
              type="button"
              disabled={state.busy}
              onClick={() => perform(() => owner.retry())}
            >
              {x('common.retry')}
            </button>
          )}
        </div>
      )}
      <Dialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(undefined);
        }}
      >
        <DialogContent>
          <DialogTitle>
            {confirm
              ? x(
                  confirm.kind === 'overwrite'
                    ? 'app.overwriteWorkspaceConfirm'
                    : 'app.deleteWorkspaceConfirm',
                  { name: confirm.workspace.name },
                )
              : ''}
          </DialogTitle>
          <button type="button" onClick={() => setConfirm(undefined)}>
            {x('common.cancel')}
          </button>
          <button
            type="button"
            disabled={state.busy}
            onClick={() => {
              if (!confirm) return;
              const captured = confirm;
              setConfirm(undefined);
              perform(async () => {
                if (captured.kind === 'overwrite') {
                  if (
                    await owner.save(captured.workspace.name, {
                      id: captured.workspace.id,
                      updatedAt: captured.workspace.updatedAt,
                    })
                  )
                    setName('');
                } else await owner.remove(captured.workspace.id, captured.workspace.updatedAt);
              });
            }}
          >
            {x('common.confirm')}
          </button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
