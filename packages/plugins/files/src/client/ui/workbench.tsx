import type {} from '@axterm/ui/shortcuts';
import type {} from '@axterm/plugin-api/terminals';
import { createShortcutDefaults, type ShortcutCommandId } from '@axterm/plugin-api/shortcuts';
import { InitialDirectories } from './initial-directories.ts';
import { FtpFilesAdmissions } from './ftp-admission.ts';
import { useSyncExternalStore } from 'react';
import { Files, Plus } from 'lucide-react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import { Button } from '@axterm/ui/controls';
import type {
  FilesWorkspaceUi,
  WorkspaceSessionOwner,
  WorkspaceTabRegistration,
} from '@axterm/ui/workspace';
import type { FileGrantsModel } from '../index.ts';
import { TransferGrantHandoffs } from './transfer-grants.ts';
import { FilesSessionOwner } from './session-owner.ts';
import { FilesPanel } from './panel.tsx';
import { FilesI18n } from './i18n.tsx';
import { FilesArrangement } from './hooks.tsx';
import { dictionaries } from './locales.ts';
import { cx, cssText } from './styles.ts';
/** Only this owner creates file tabs; all business facts come from selected owner services. */
export function installFilesWorkbench(ctx: Context, model: FileGrantsModel) {
  const sessions = new Map<
    string,
    {
      owner: FilesSessionOwner;
      tab: WorkspaceTabRegistration;
      input?: Parameters<FilesWorkspaceUi['open']>[0];
    }
  >();
  const embedded = new Map<
    string,
    {
      owner: FilesSessionOwner;
      generation: string;
      session: { kind: 'local' } | { kind: 'ssh'; connectionId: string };
      retiring?: Promise<void>;
    }
  >();
  const orphans = new Set<FilesSessionOwner>();
  const initialGrants = new Map<FilesSessionOwner, string>();
  const initialDirectories = new InitialDirectories(model);
  let closing = false;
  const handoffs = new TransferGrantHandoffs(model, ctx.transferActions);
  ctx.provide('fileTransferActions', {
    create: (generation, key, input) => {
      if (closing) throw Error('FILES_WORKBENCH_CLOSED');
      const state = model.getSnapshot();
      if (state.status !== 'ready' || state.baseline.generation !== generation)
        throw Error('FILES_HANDOFF_GENERATION_CHANGED');
      return handoffs.create(key, input);
    },
    release: (grantId, generation) => handoffs.release(grantId, generation),
  });
  ctx.effect(() => ctx.locale.register('files', dictionaries));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-files';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  const open: FilesWorkspaceUi['open'] = async (input, signal) => {
    signal?.throwIfAborted();
    if (closing) throw Error('FILES_WORKBENCH_CLOSED');
    input = input ? structuredClone(input) : undefined;
    if (
      input?.title !== undefined &&
      (!input.title.trim() || input.title.length > 256 || /[\r\n\0]/u.test(input.title))
    )
      throw Error('FILES_TITLE_INVALID');
    if (sessions.size + embedded.size + orphans.size + initialDirectories.resourceCount() >= 4)
      throw Error('FILES_WORKBENCH_CAPACITY');
    const facts = model.getSnapshot();
    if (facts.status !== 'ready') throw Error('FILES_NOT_READY');
    const initialDirectory = input?.initialDirectoryGrantId
      ? await initialDirectories.take(
          input.initialDirectoryGrantId,
          facts.baseline.generation,
          signal,
        )
      : undefined;
    signal?.throwIfAborted();
    const current = model.getSnapshot();
    if (
      closing ||
      current.status !== 'ready' ||
      current.baseline.generation !== facts.baseline.generation
    )
      throw Error('FILES_WORKBENCH_RETIRED');
    if (sessions.size + embedded.size + orphans.size >= 4) throw Error('FILES_WORKBENCH_CAPACITY');
    if (
      input?.initialDirectoryGrantId &&
      [...initialGrants.values()].includes(input.initialDirectoryGrantId)
    )
      throw Error('FILES_INITIAL_DIRECTORY_OWNED');
    const id = 'files:' + crypto.randomUUID(),
      owner = new FilesSessionOwner(ctx, model, handoffs, initialDirectory);
    orphans.add(owner);
    if (initialDirectory) initialGrants.set(owner, initialDirectory.grantId);
    let tab: WorkspaceTabRegistration;
    try {
      tab = ctx.workspaceUi.registerTab(
        {
          id,
          kind: 'files',
          title:
            input?.title ??
            ctx.locale.resolveText({
              en: 'Files',
              ja: 'ファイル',
              'zh-CN': '文件',
              'zh-TW': '檔案',
            }),
          icon: 'files',
        },
        async () => {
          await owner.dispose();
          initialGrants.delete(owner);
          sessions.delete(id);
        },
      );
    } catch (error) {
      await owner.dispose();
      initialGrants.delete(owner);
      orphans.delete(owner);
      throw error;
    }
    orphans.delete(owner);
    sessions.set(id, { owner, tab, ...(input ? { input } : {}) });
    tab.activate();
    if (ctx.workspaceUi.getSnapshot().navigation.some((item) => item.id === 'files'))
      ctx.workspaceUi.selectSection('files');
    return id;
  };
  for (const alternate of [false, true])
    ctx.effect(() =>
      ctx.shortcuts.register({
        id: ('terminal.syncSftpPath' + (alternate ? '.alternate' : '')) as ShortcutCommandId,
        label: () => ctx.locale.bind('shortcuts')('shortcuts.action.syncSftpPath'),
        messageKey: 'shortcuts.action.syncSftpPath',
        aliases: [],
        defaults: alternate
          ? {}
          : createShortcutDefaults({ code: 'F11', modifiers: ['alt', 'shift'] }),
        regions: ['terminal'],
        modals: [],
        resolve: () => {
          const target = ctx.terminalWorkspaceUi.getActiveDirectory?.(),
            facts = model.getSnapshot();
          if (closing || !target || facts.status !== 'ready')
            return { status: 'blocked', reason: 'no-directory' };
          const generation = facts.baseline.generation;
          return {
            status: 'handled',
            run: () => {
              const current = model.getSnapshot(),
                connections = ctx.connectionActions.getSnapshot();
              if (
                closing ||
                current.status !== 'ready' ||
                current.baseline.generation !== generation ||
                connections.status !== 'ready' ||
                connections.baseline.generation !== generation ||
                !connections.baseline.connections.some(
                  (value) => value.id === target.connectionId && value.state === 'ready',
                )
              )
                return;
              const existing = [...sessions.values()].find(
                (entry) => entry.input?.kind !== 'local' && entry.owner.followTerminalDirectory,
              );
              if (existing) {
                existing.owner.followTerminalDirectory!(target);
                existing.tab.activate();
              } else
                void open({
                  kind: 'remote',
                  target: { protocol: 'sftp', connectionId: target.connectionId },
                  path: target.path,
                }).catch(() => {});
            },
          };
        },
      }),
    );
  const ftp = new FtpFilesAdmissions(ctx.connectionActions, open, () => {
    const local = model.getSnapshot(),
      remote = ctx.connectionActions.getSnapshot();
    return (
      !closing &&
      sessions.size + embedded.size + orphans.size + initialDirectories.resourceCount() < 4 &&
      local.status === 'ready' &&
      remote.status === 'ready' &&
      local.baseline.generation === remote.baseline.generation
    );
  });
  const releaseTerminalPane: NonNullable<FilesWorkspaceUi['releaseTerminalPane']> = async (
    id,
    generation,
  ) => {
    const entry = embedded.get(id);
    if (!entry) return;
    if (entry.generation !== generation) throw Error('FILES_EMBEDDED_GENERATION_CHANGED');
    entry.retiring ??= entry.owner.dispose().then(() => {
      if (embedded.get(id) === entry) embedded.delete(id);
    });
    await entry.retiring;
  };
  const prepareTerminalPane: NonNullable<FilesWorkspaceUi['prepareTerminalPane']> = async (
    id,
    generation,
  ) => {
    if (closing) throw Error('FILES_WORKBENCH_CLOSED');
    const files = model.getSnapshot(),
      terminals = ctx.terminalSessionsView.getSnapshot();
    if (
      files.status !== 'ready' ||
      terminals.status !== 'ready' ||
      files.baseline.generation !== generation ||
      terminals.baseline.generation !== generation
    )
      throw Error('FILES_EMBEDDED_GENERATION_CHANGED');
    const terminal = terminals.baseline.sessions.find((entry) => entry.id === id);
    if (
      !terminal ||
      (terminal.kind !== 'local' && terminal.kind !== 'ssh') ||
      (terminal.kind === 'ssh' && !terminal.connectionId)
    )
      throw Error('FILES_EMBEDDED_TERMINAL_UNAVAILABLE');
    const existing = embedded.get(id);
    if (existing) {
      if (existing.generation !== generation || existing.retiring)
        throw Error('FILES_EMBEDDED_RETIRED');
      return;
    }
    if (sessions.size + embedded.size + orphans.size + initialDirectories.resourceCount() >= 4)
      throw Error('FILES_WORKBENCH_CAPACITY');
    const owner = new FilesSessionOwner(ctx, model, handoffs);
    embedded.set(id, {
      owner,
      generation,
      session:
        terminal.kind === 'ssh'
          ? { kind: 'ssh', connectionId: terminal.connectionId! }
          : { kind: 'local' },
    });
  };
  ctx.provide('filesWorkspaceUi', {
    open,
    openFtp: (input, options) => ftp.open(input, options),
    prepareTerminalPane,
    releaseTerminalPane,
  });
  ctx.slots.inject('terminal.files', function* () {
    yield ctx.slots.register(
      { name: 'terminal.files', locale: 'files' },
      function EmbeddedFiles(props: PropsLocale<'files'> & WorkspaceSessionOwner) {
        const entry = embedded.get(props.tabId);
        if (!entry || entry.retiring) return null;
        return (
          <FilesI18n value={{ x: props.t, language: ctx.locale.getLocale().active }}>
            <FilesArrangement>
              <Session entry={entry} active={props.active} />
            </FilesArrangement>
          </FilesI18n>
        );
      },
    );
  });
  ctx.slots.inject('workspace.overlay', function* () {
    yield ctx.slots.register(
      { name: 'workspace.overlay', id: 'files.admission', locale: 'files' },
      function Admission() {
        const state = useSyncExternalStore(ftp.subscribe, ftp.getSnapshot);
        if (!state.unresolved) return null;
        return (
          <div className={cx('files-admission-error')} role="alert">
            <span>
              {ctx.locale.resolveText({
                en: 'The FTP connection result is uncertain.',
                ja: 'FTP 接続の結果を確認できません。',
                'zh-CN': 'FTP 连接结果尚不确定。',
                'zh-TW': 'FTP 連線結果尚不確定。',
              })}
            </span>
            <button
              disabled={state.busy > 0}
              onClick={() => {
                void ftp.reconcile().catch(() => {});
              }}
            >
              {ctx.locale.resolveText({
                en: 'Check again',
                ja: '再確認',
                'zh-CN': '重新核对',
                'zh-TW': '重新核對',
              })}
            </button>
          </div>
        );
      },
    );
  });
  ctx.effect(() =>
    ctx.workspaceUi.registerAction('files.open', async (signal) => {
      const active = ctx.workspaceUi.getSnapshot().activeTabId;
      if (active && sessions.has(active)) return;
      const existing = [...sessions.values()].at(-1);
      if (existing) {
        existing.tab.activate();
        return;
      }
      await open(undefined, signal);
    }),
  );
  ctx.effect(() =>
    ctx.workspaceUi.registerAction('files.new', (signal) => open(undefined, signal).then(() => {})),
  );
  ctx.effect(() =>
    ctx.workspaceUi.registerNavigation({
      id: 'files',
      label: { en: 'Files', ja: 'ファイル', 'zh-CN': '文件', 'zh-TW': '檔案' },
      icon: <Files size={18} />,
      order: 20,
      action: 'files.open',
    }),
  );
  ctx.slots.inject('workspace.sidebar', function* () {
    yield ctx.slots.register(
      { name: 'workspace.sidebar', key: 'files', locale: 'files' },
      function FilesSidebar({ t }: PropsLocale<'files'>) {
        return (
          <div className={cx('file-sidebar')}>
            <Button onClick={() => void ctx.workspaceUi.invokeAction('files.new')}>
              <Plus size={14} />
              {t('fileManager.title')}
            </Button>
          </div>
        );
      },
    );
  });
  ctx.slots.inject('workspace.session', function* () {
    yield ctx.slots.register(
      { name: 'workspace.session', key: 'files', locale: 'files' },
      function FilesSession(props: PropsLocale<'files'> & WorkspaceSessionOwner) {
        const entry = sessions.get(props.tabId);
        if (!entry) return null;
        return (
          <FilesI18n value={{ x: props.t, language: ctx.locale.getLocale().active }}>
            <FilesArrangement>
              <Session entry={entry} active={props.active} />
            </FilesArrangement>
          </FilesI18n>
        );
      },
    );
  });
  function Session({
    entry,
    active,
  }: {
    entry: {
      owner: FilesSessionOwner;
      input?: Parameters<FilesWorkspaceUi['open']>[0];
      session?: { kind: 'local' } | { kind: 'ssh'; connectionId: string };
    };
    active: boolean;
  }) {
    const catalog = useSyncExternalStore(
        ctx.catalogActions.subscribe,
        ctx.catalogActions.getSnapshot,
      ),
      connections = useSyncExternalStore(
        ctx.connectionActions.subscribe,
        ctx.connectionActions.getSnapshot,
      ),
      settings = useSyncExternalStore(
        ctx.configurationActions.subscribe,
        ctx.configurationActions.getSnapshot,
      ),
      transfers = useSyncExternalStore(
        ctx.transferActions.subscribe,
        ctx.transferActions.getSnapshot,
      ),
      jobs = useSyncExternalStore(entry.owner.commands.subscribe, entry.owner.commands.getSnapshot);
    const initial = entry.input?.kind === 'remote' ? entry.input : undefined;
    return (
      <div
        ref={(element) => {
          entry.owner.container = element ?? undefined;
          entry.owner.active = active;
        }}
        className={cx('files-session-root')}
        data-files-workspace=""
      >
        {jobs
          .filter((job) => job.state === 'uncertain')
          .map((job) => (
            <div key={job.id} className={cx('error-banner')} role="alert">
              <span>
                {ctx.locale.resolveText({
                  en: 'The operation result is uncertain.',
                  ja: '操作結果を確認できません。',
                  'zh-CN': '操作结果尚不确定。',
                  'zh-TW': '操作結果尚不確定。',
                })}
              </span>
              <button onClick={() => void entry.owner.commands.retry(job.id).catch(() => {})}>
                {ctx.locale.resolveText({
                  en: 'Check / retry same request',
                  ja: '確認／同じ要求を再試行',
                  'zh-CN': '核对／重试同一请求',
                  'zh-TW': '核對／重試同一請求',
                })}
              </button>
            </div>
          ))}
        <FilesPanel
          owner={entry.owner}
          active={active}
          hosts={catalog.status === 'ready' ? [...catalog.baseline.hosts] : []}
          connections={connections.status === 'ready' ? [...connections.baseline.connections] : []}
          ftpConnections={
            connections.status === 'ready' ? [...connections.baseline.ftpConnections] : []
          }
          transfers={transfers.status === 'ready' ? [...transfers.baseline.items] : []}
          settings={settings.status === 'ready' ? settings.baseline.settings : undefined}
          getActiveSshDirectory={() => ctx.terminalWorkspaceUi.getActiveDirectory?.()}
          {...(entry.session
            ? { session: entry.session }
            : entry.input?.kind === 'local'
              ? { session: { kind: 'local' as const } }
              : {})}
          {...(initial
            ? {
                requestedSshDirectory: {
                  connectionId: initial.target.connectionId,
                  path: initial.path ?? '/',
                  nonce: entry.owner.id,
                },
              }
            : {})}
        />
      </div>
    );
  }
  ctx.effect(() => async () => {
    closing = true;
    const ftpClosing = ftp.dispose();
    const directoryClosing = initialDirectories.close();
    void directoryClosing.catch(() => {});
    void ftpClosing.catch(() => {});
    const results = await Promise.allSettled(
      [...sessions].map(async ([id, { owner, tab }]) => {
        await owner.dispose();
        initialGrants.delete(owner);
        tab.dispose();
        sessions.delete(id);
      }),
    );
    const orphanResults = await Promise.allSettled(
      [...orphans].map(async (owner) => {
        await owner.dispose();
        initialGrants.delete(owner);
        orphans.delete(owner);
      }),
    );
    const embeddedResults = await Promise.allSettled(
      [...embedded].map(([id, entry]) => releaseTerminalPane(id, entry.generation)),
    );
    const shared = await Promise.allSettled([handoffs.close(), ftpClosing, directoryClosing]);
    if (
      [...results, ...orphanResults, ...embeddedResults, ...shared].some(
        (result) => result.status === 'rejected',
      )
    )
      throw Error('FILES_WORKBENCH_UNDRAINED');
  });
}
