import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowRight, CircleHelp, Zap, Server } from 'lucide-react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type { WorkspacePanelOwner } from '@axterm/ui/workspace';
import type { CatalogModel } from '../index.ts';
import { CatalogI18n, useI18n } from './i18n.tsx';
import { ConnectionHistorySidebar } from './history-sidebar.tsx';
import type { HistoryView } from './history-view.ts';
import type { HistoryActions } from './history-actions.ts';
import { parseQuickConnect } from './session/parser.ts';
import historyStyles from './history.module.css';
import styles, { cssText } from './empty-workspace.module.css';
const cx = (name: string) => name + ' ' + (styles[name] ?? '');

/** Only transient expansion is shared. Admissions and history retain their existing owners. */
export function installEmptyCatalogUi(
  ctx: Context,
  model: CatalogModel,
  view: HistoryView,
  actions: HistoryActions,
): void {
  let open = false,
    closed = false;
  const listeners = new Set<() => void>();
  const getOpen = () => open;
  const subscribe = (listener: () => void) => {
    if (closed) return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const setOpen = (value: boolean) => {
    if (closed || open === value) return;
    open = value;
    for (const listener of listeners) listener();
  };
  ctx.effect(() => () => {
    closed = true;
    open = false;
    listeners.clear();
  });
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = '@axterm/plugin-catalog';
    style.dataset.axtermOwner = '@axterm/plugin-catalog';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('workspace.empty.actions', function* () {
    yield ctx.slots.register(
      { name: 'workspace.empty.actions', id: 'catalog.saved', order: 20, locale: 'catalog' },
      function Saved({ t, paneIndex }: PropsLocale<'catalog'> & WorkspacePanelOwner) {
        const [failed, setFailed] = useState(false),
          live = useRef(true);
        useEffect(() => {
          live.current = true;
          return () => {
            live.current = false;
          };
        }, []);
        return (
          <>
            <button
              onClick={() => {
                if (closed) return;
                setFailed(false);
                void ctx.workspaceUi.invokeAction('new-bookmark').catch(() => {
                  if (live.current) setFailed(true);
                });
              }}
            >
              {paneIndex !== undefined && <Server size={14} />}
              {t('sessionMenu.newBookmark')}
            </button>
            {failed && <span role="alert">{t('common.operationFailed')}</span>}
          </>
        );
      },
    );
    yield ctx.slots.register(
      {
        name: 'workspace.empty.actions',
        id: 'catalog.quick-connect',
        order: 10,
        locale: 'catalog',
      },
      function Toggle({ t, paneIndex }: PropsLocale<'catalog'> & WorkspacePanelOwner) {
        const visible = useSyncExternalStore(subscribe, getOpen);
        const [failed, setFailed] = useState(false);
        return (
          <>
            <button
              aria-expanded={paneIndex === undefined ? visible : undefined}
              onClick={() => {
                if (paneIndex === undefined) setOpen(!open);
                else {
                  setFailed(false);
                  void ctx.workspaceUi
                    .invokeAction('new-session-menu')
                    .catch(() => setFailed(true));
                }
              }}
            >
              <Zap size={13} />
              {t('empty.quickConnect')}
              {paneIndex === undefined && <CircleHelp size={12} />}
            </button>
            {failed && <span role="alert">{t('common.operationFailed')}</span>}
          </>
        );
      },
    );
  });
  ctx.slots.inject('workspace.empty.content', function* () {
    yield ctx.slots.register(
      {
        name: 'workspace.empty.content',
        id: 'catalog.quick-history',
        order: 10,
        locale: 'catalog',
      },
      function Content({ t }: PropsLocale<'catalog'>) {
        const visible = useSyncExternalStore(subscribe, getOpen);
        useEffect(() => () => setOpen(false), []);
        return (
          <CatalogI18n translate={t}>
            {visible && <QuickConnect ctx={ctx} closed={() => closed} />}
            <div className={'no-session-history ' + historyStyles['no-session-history']}>
              <ConnectionHistorySidebar
                model={model}
                settings={ctx.configurationActions}
                view={view}
                actions={actions}
              />
            </div>
          </CatalogI18n>
        );
      },
    );
  });
}
function QuickConnect({ ctx, closed }: { ctx: Context; closed(): boolean }) {
  const { x } = useI18n(),
    input = useRef<HTMLInputElement>(null),
    live = useRef(true);
  const [invalid, setInvalid] = useState(false),
    [failed, setFailed] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    live.current = true;
    const element = input.current;
    return () => {
      live.current = false;
      if (element) element.value = '';
    };
  }, []);
  const submit = () => {
    if (busy || closed()) return;
    const source = input.current?.value ?? '';
    if (!parseQuickConnect(source)) {
      setInvalid(true);
      return;
    }
    if (input.current) input.current.value = '';
    setInvalid(false);
    setFailed(false);
    setBusy(true);
    // sessionLaunchUi owns the one captured admission and joins it on plugin unload.
    void ctx.sessionLaunchUi
      .launch(source)
      .then(
        (accepted) => {
          if (live.current && !accepted) setFailed(true);
        },
        () => {
          if (live.current) setFailed(true);
        },
      )
      .finally(() => {
        if (live.current) setBusy(false);
      });
  };
  return (
    <div className={cx('no-session-quick')}>
      <label htmlFor="empty-quick-connect">Quick Connect</label>
      <div>
        <Zap size={14} />
        <input
          ref={input}
          id="empty-quick-connect"
          placeholder="ssh://user@example.com:22"
          autoFocus
          disabled={busy}
          onChange={() => {
            setInvalid(false);
            setFailed(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
        <button disabled={busy} onClick={submit}>
          {x('sessionMenu.connect')}
          <ArrowRight size={13} />
        </button>
      </div>
      {invalid && <small role="alert">{x('shell.quickConnectFormat')}</small>}
      {failed && <small role="alert">{x('sessionMenu.failed')}</small>}
    </div>
  );
}
