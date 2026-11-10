import { EditorCompletion } from './editor-completion.ts';
import type { PropsLocale } from '@axterm/ui';
import { CatalogI18n } from '../i18n.tsx';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowRight, ChevronDown, Pin, Server, Terminal, Zap } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogTitle, DialogTrigger } from '@axterm/ui/controls';
import type { Context } from '@deepseek-ai/cordis';
import type { CatalogModel } from '../../index.ts';
import type { CatalogEditorOwner } from '../editor/owner.ts';
import { useI18n } from '../i18n.tsx';
import { maskHostAddress } from '../privacy.ts';
import { NewSessionActions } from './actions.ts';
import { parseQuickConnect } from './parser.ts';
import { createShortcutDefaults, type ShortcutCommandId } from '@axterm/plugin-api/shortcuts';
import type {} from '@axterm/ui/shortcuts';
import styles, { cssText } from './session.module.css';
const classes = (value: string) =>
  value
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');
export function installNewSessionUi(
  ctx: Context,
  model: CatalogModel,
  editor: CatalogEditorOwner,
): void {
  const actions = new NewSessionActions(
    model,
    ctx.connectionWorkspaceUi,
    ctx.terminalWorkspaceUi,
    editor,
  );
  ctx.inject(['automationWorkspaceUi'], (scope) => {
    scope.effect(() => actions.attachAutomation(scope.automationWorkspaceUi));
  });
  ctx.inject(['fileGrantActions'], (scope) => {
    scope.effect(() => actions.attachFileGrants(scope.fileGrantActions));
  });
  const completion = new EditorCompletion(editor),
    launchLifetime = new AbortController();
  ctx.effect(() => async () => {
    launchLifetime.abort();
    await completion.close();
  });
  ctx.provide('sessionLaunchUi', {
    launch: async (source, signal) => {
      signal?.throwIfAborted();
      const target = parseQuickConnect(source);
      if (!target) return false;
      const owned = AbortSignal.any([launchLifetime.signal, ...(signal ? [signal] : [])]);
      const needsEditor = target.protocol !== 'ssh' && target.protocol !== 'local';
      if (needsEditor) await completion.idle(owned);
      const accepted = await actions.launch(target, undefined, owned);
      owned.throwIfAborted();
      if (accepted && needsEditor) {
        const id = editor.getSnapshot().session?.id;
        if (!id) return false;
        await completion.closed(id, owned);
      }
      return accepted;
    },
  });
  ctx.effect(() => () => actions.close());
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-catalog';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('workspace.toolbar', function* () {
    yield ctx.slots.register(
      { name: 'workspace.toolbar', id: 'catalog.pane-new-session', locale: 'catalog', order: 12 },
      function PaneMenuTrigger({ t }: PropsLocale<'catalog'>) {
        const [failed, setFailed] = useState(false);
        const live = useRef(true);
        useEffect(() => {
          live.current = true;
          return () => {
            live.current = false;
          };
        }, []);
        return (
          <>
            <Button
              variant="ghost"
              data-catalog-pane-new-session
              aria-label={t('app.newSessionMenu')}
              onClick={() => {
                setFailed(false);
                void ctx.workspaceUi.invokeAction('new-session-menu').catch(() => {
                  if (live.current) setFailed(true);
                });
              }}
            >
              <ChevronDown size={14} />
            </Button>
            {failed && <span role="alert">{t('common.operationFailed')}</span>}
          </>
        );
      },
    );
    yield ctx.slots.register(
      { name: 'workspace.toolbar', id: 'catalog.new-session', locale: 'catalog', order: 11 },
      ({ t }: PropsLocale<'catalog'>) => (
        <CatalogI18n translate={t}>
          <SessionMenu ctx={ctx} model={model} actions={actions} />
        </CatalogI18n>
      ),
    );
  });
}
function SessionMenu({
  ctx,
  model,
  actions,
}: {
  ctx: Context;
  model: CatalogModel;
  actions: NewSessionActions;
}) {
  const { x } = useI18n();
  const [open, setOpen] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const catalog = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const terminals = useSyncExternalStore(
    ctx.terminalFactsView.subscribe,
    ctx.terminalFactsView.getSnapshot,
  );
  const configuration = useSyncExternalStore(
    ctx.configurationActions.subscribe,
    ctx.configurationActions.getSnapshot,
  );
  const command = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
  const profiles = terminals.status === 'ready' ? terminals.baseline.profiles : [];
  const hosts = catalog.status === 'ready' ? catalog.baseline.hosts : [];
  const settings = configuration.status === 'ready' ? configuration.baseline.settings : undefined;
  const hideAddresses = settings?.privacy.hideAddresses ?? true;
  const defaultProfile = profiles.find(
    (profile) => profile.id === settings?.terminal.defaultProfileId,
  );
  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const recentHosts = [...hosts]
    .sort(
      (left, right) =>
        Number(right.favorite) - Number(left.favorite) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, 6);
  useEffect(
    () => ctx.workspaceUi.registerAction('new-session-menu', () => setOpen((value) => !value)),
    [ctx],
  );
  useEffect(() => {
    const t = ctx.locale.bind('shortcuts');
    const disposers = [
      [
        'app.toggleAddBtn',
        'shortcuts.action.openNewSession',
        { code: 'KeyN', modifiers: ['alt'] },
        undefined,
      ],
      [
        'app.newBookmark',
        'shortcuts.action.newBookmark',
        { code: 'KeyN', modifiers: ['control'] },
        { code: 'KeyN', modifiers: ['meta'] },
      ],
    ] as const;
    const off = disposers.flatMap(([id, label, other, mac]) =>
      [false, true].map((alternate) =>
        ctx.shortcuts.register({
          id: (id + (alternate ? '.alternate' : '')) as ShortcutCommandId,
          label: () => t(label),
          messageKey: label,
          aliases: [],
          defaults: alternate ? {} : createShortcutDefaults(other, mac ?? other),
          regions: ['page', 'editable', 'terminal'],
          modals: id === 'app.toggleAddBtn' ? ['catalog-new-session'] : [],
          resolve: () => ({
            status: 'handled',
            run: () => {
              if (id === 'app.toggleAddBtn') setOpen((value) => !value);
              else {
                setOpen(false);
                void ctx.workspaceUi.invokeAction('new-bookmark').catch(() => setInvalid(true));
              }
            },
          }),
        }),
      ),
    );
    return () => {
      for (const dispose of off.reverse()) dispose();
    };
  }, [ctx]);

  function submit() {
    const target = parseQuickConnect(input.current?.value ?? '');
    if (!target) {
      setInvalid(true);
      return;
    }
    if (input.current) input.current.value = '';
    setOpen(false);
    setInvalid(false);
    void actions.launch(target, profileId || undefined);
  }
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen} modal={false}>
        <DialogTrigger asChild>
          <Button
            data-catalog-new-session
            aria-label={x('app.newSessionMenu')}
            title={x('app.newSessionMenu')}
            disabled={command.busy}
          >
            <ChevronDown size={14} />
          </Button>
        </DialogTrigger>
        <DialogContent asChild aria-describedby={undefined}>
          <section
            className={classes('session-menu popover-surface')}
            data-catalog-session-menu
            data-shortcut-modal="catalog-new-session"
          >
            <header>
              <DialogTitle asChild>
                <strong>{x('sessionMenu.newSession')}</strong>
              </DialogTitle>
              <small>LOCAL &amp; REMOTE</small>
            </header>
            <button
              className={classes('menu-primary-row')}
              onClick={() => {
                setOpen(false);
                void actions.launch({ protocol: 'local' }, profileId || undefined);
              }}
            >
              <Terminal size={15} />
              <span>
                <strong>{x('shell.localTerminal')}</strong>
                <small>
                  {selectedProfile?.name ??
                    (defaultProfile
                      ? x('shell.defaultProfile', { name: defaultProfile.name })
                      : x('shell.platformDefaultShell'))}
                </small>
              </span>
              <kbd>⌘T</kbd>
            </button>
            <div className={classes('quick-connect-box')}>
              <label htmlFor="terminal-profile">{x('shell.terminalProfile')}</label>
              <div className={classes('session-profile-row')}>
                <Terminal size={13} />
                <select
                  id="terminal-profile"
                  value={profileId}
                  onChange={(event) => setProfileId(event.target.value)}
                >
                  <option value="">
                    {defaultProfile
                      ? x('shell.globalDefault', { name: defaultProfile.name })
                      : x('shell.platformDefault')}
                  </option>
                  {profileId && !profiles.some((profile) => profile.id === profileId) && (
                    <option value={profileId} disabled>
                      {x('terminalRecovery.deletedProfile')}
                    </option>
                  )}
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </div>
              <label htmlFor="quick-connect">Quick Connect</label>
              <div>
                <Zap size={14} />
                <input
                  id="quick-connect"
                  ref={input}
                  autoFocus
                  maxLength={16384}
                  placeholder="user@host:22"
                  autoComplete="off"
                  onChange={() => setInvalid(false)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                />
                <button type="button" onClick={submit} aria-label={x('sessionMenu.connect')}>
                  <ArrowRight size={14} />
                </button>
              </div>
              {invalid && (
                <small role="alert" className={classes('menu-error')}>
                  {x('shell.quickConnectInput')}
                </small>
              )}
            </div>
            <div className={classes('menu-section-label')}>
              <span>{x('app.bookmarks')}</span>
              <button
                type="button"
                data-session-action="new-bookmark"
                onClick={() => {
                  setOpen(false);
                  void ctx.workspaceUi.invokeAction('new-bookmark').catch(() => setInvalid(true));
                }}
              >
                {x('sessionMenu.newBookmark')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  void ctx.workspaceUi
                    .invokeAction('manage-bookmarks')
                    .catch(() => setInvalid(true));
                }}
              >
                {x('shell.manage')}
              </button>
            </div>
            <div className={classes('session-menu-hosts')}>
              {recentHosts.map((host) => (
                <button
                  key={host.id}
                  onClick={() => {
                    setOpen(false);
                    void actions.host(host, profileId || undefined);
                  }}
                >
                  <span className={classes('host-protocol')}>SSH</span>
                  <span>
                    <strong>{host.name}</strong>
                    <small>
                      {host.username}@
                      {hideAddresses ? maskHostAddress(host.hostname) : host.hostname}:{host.port}
                    </small>
                  </span>
                  {host.favorite && <Pin size={12} fill="currentColor" />}
                </button>
              ))}
              {!recentHosts.length && (
                <button
                  className={classes('empty-bookmark-row')}
                  onClick={() => {
                    setOpen(false);
                    void ctx.workspaceUi
                      .invokeAction('manage-bookmarks')
                      .catch(() => setInvalid(true));
                  }}
                >
                  <Server size={14} />
                  {x('shell.createFirstSshBookmark')}
                </button>
              )}
            </div>
          </section>
        </DialogContent>
      </Dialog>
      {command.failed && <span role="alert">{x('sessionMenu.failed')}</span>}
      {command.cleanupPending && (
        <Button
          onClick={() => {
            void actions.retryCleanup().catch(() => {});
          }}
        >
          {x('history.retry')}
        </Button>
      )}
    </>
  );
}
