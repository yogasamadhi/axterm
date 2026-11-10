import type {} from './locales.ts';
import {
  Terminal,
  Folder,
  Server,
  Monitor,
  Globe,
  ChevronDown,
  Ellipsis,
  SplitSquareHorizontal,
} from 'lucide-react';
import { NamedWorkspaceMenu, type NamedTranslate } from './named-menu.tsx';
import type { NamedWorkspaces } from './named-workspaces.ts';
import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
  Dialog,
  DialogContent,
  DialogTitle,
} from '@axterm/ui/controls';
import type { PropsLocale } from '@axterm/ui';
import type {
  WorkspaceArrangement,
  WorkspaceRootShare,
  WorkspaceSnapshot,
  WorkspaceTab,
} from '@axterm/ui/workspace';
import type { Settings, WorkspaceLayoutMode } from '@axterm/plugin-api/configuration';
import { type WorkspaceStore, paneCount } from './store.ts';
import styles from './workspace.module.css';
const cls = (...values: string[]) =>
  values.map((value) => `${value} ${styles[value] ?? ''}`).join(' ');
type Text = Pick<PropsLocale<'workspace'>, 't'>;
export const layoutChoices = ['c1', 'c2', 'r2', 'c3', 'r3', 'c2x2', 'c1r2', 'r1c2'] as const;
const layoutLabels = [
  'single',
  'twoColumns',
  'twoRows',
  'threeColumns',
  'threeRows',
  'grid2x2',
  'twoRowsRight',
  'twoColumnsBottom',
] as const;
interface WorkspaceProps extends Text {
  onDuplicate?: ((id: string) => Promise<void>) | undefined;
  tabPreferences?: Pick<Settings['workspace'], 'showTabNumber' | 'switchTabOnHover'> | undefined;
  workspace: WorkspaceStore;
  state: WorkspaceSnapshot;
  onError(): void;
}
export function LayoutControl({
  workspace,
  state,
  t,
  named,
  x,
}: WorkspaceProps & { named?: NamedWorkspaces | undefined; x: NamedTranslate }) {
  const [tab, setTab] = useState<'layout' | 'workspace'>('layout');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className={cls('layout-toggle')} aria-label={t('layout')} title={t('layout')}>
          ▦
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent
          className={cls('layout-menu', 'popover-surface')}
          sideOffset={4}
          align="end"
        >
          <div className={cls('menu-tabs')}>
            <button
              type="button"
              className={tab === 'layout' ? cls('active') : ''}
              onClick={() => setTab('layout')}
            >
              {x('shell.layout')}
            </button>
            <button
              type="button"
              disabled={!named}
              className={tab === 'workspace' ? cls('active') : ''}
              onClick={() => setTab('workspace')}
            >
              {x('shell.workspace')}
            </button>
          </div>
          {tab === 'workspace' && named ? (
            <NamedWorkspaceMenu owner={named} x={x} />
          ) : (
            <div className={cls('layout-choice-grid')}>
              {layoutChoices.map((mode, index) => (
                <DropdownMenuItem key={mode} asChild>
                  <button
                    data-layout-choice={mode}
                    title={t(layoutLabels[index]!)}
                    className={state.arrangement?.mode === mode ? cls('active') : ''}
                    onClick={() => workspace.arrange.setLayout(mode)}
                  >
                    <span className={cls('layout-glyph', `layout-${mode}`)}>
                      {Array.from({ length: paneCount(mode) }, (_, index) => (
                        <i key={index} />
                      ))}
                    </span>
                    <small>{t(layoutLabels[index]!)}</small>
                  </button>
                </DropdownMenuItem>
              ))}
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenu>
  );
}
const dragType = 'application/x-axterm-workspace-tab';
export function WorkspaceTabs({
  workspace,
  state,
  t,
  onError,
  pane,
  renderSlot,
  tabPreferences,
  onDuplicate,
}: WorkspaceProps & Pick<WorkspaceRootShare, 'renderSlot'> & { pane?: number }) {
  const [menu, setMenu] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const [draft, setDraft] = useState('');
  const [hovered, setHovered] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  }>();
  const tabs = state.tabs.filter((tab) => pane === undefined || tab.paneIndex === pane);
  const active = pane === undefined ? state.activeTabId : state.arrangement?.paneTabIds[pane];
  const focusable = tabs.some((tab) => tab.id === active) ? active : tabs[0]?.id;
  const target =
    tabs.find((tab) => tab.id === (renaming ?? menu ?? hovered)) ??
    tabs.find((tab) => tab.id === active);
  const tabLayoutKey = tabs.map((tab) => tab.id + tab.title).join('\0');
  useLayoutEffect(() => {
    const container = root.current;
    const title = Array.from(container?.querySelectorAll<HTMLElement>('[role=tab]') ?? []).find(
      (element) => element.dataset.tabId === target?.id,
    );
    if (!container || !title) {
      setPosition(undefined);
      return;
    }
    const update = () => {
      const box = title.getBoundingClientRect(),
        outer = container.getBoundingClientRect();
      const next = {
        left: box.left - outer.left + container.scrollLeft,
        top: box.top - outer.top,
        width: box.width,
        height: box.height,
      };
      setPosition((old) =>
        old &&
        Object.keys(next).every(
          (key) => old[key as keyof typeof next] === next[key as keyof typeof next],
        )
          ? old
          : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(title);
    container.addEventListener('scroll', update);
    return () => {
      observer.disconnect();
      container.removeEventListener('scroll', update);
    };
  }, [target?.id, tabLayoutKey]);
  const run = (fn: () => Promise<void>) => void fn().catch(onError);
  const rename = (tab: WorkspaceTab) => {
    setRenaming(tab.id);
    setDraft(tab.title);
  };
  const finishRename = () => {
    if (renaming && draft.trim()) workspace.arrange.renameTab(renaming, draft);
    setRenaming(undefined);
  };
  const key = (event: KeyboardEvent, tab: WorkspaceTab) => {
    if (event.key === 'F10' && event.shiftKey) {
      event.preventDefault();
      setMenu(tab.id);
      return;
    }
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (direction && event.altKey && event.shiftKey) {
      const movable = tabs.filter((value) => !!value.pinned === !!tab.pinned),
        target = movable[movable.findIndex((value) => value.id === tab.id) + direction];
      if (target) {
        event.preventDefault();
        workspace.arrange.moveTab(tab.id, target.id, direction > 0);
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const index = tabs.findIndex((value) => value.id === tab.id),
      target = direction
        ? tabs[(index + direction + tabs.length) % tabs.length]
        : event.key === 'Home'
          ? tabs[0]
          : event.key === 'End'
            ? tabs.at(-1)
            : undefined;
    if (target) {
      event.preventDefault();
      workspace.selectTab(target.id);
      const list = event.currentTarget.closest('[role=tablist]');
      requestAnimationFrame(() =>
        Array.from(list?.querySelectorAll<HTMLElement>('[role=tab]') ?? [])
          .find((element) => element.dataset.tabId === target.id)
          ?.focus(),
      );
    }
  };
  return (
    <div
      ref={root}
      className={cls('workspace-session-tabs')}
      onMouseLeave={() => {
        if (!root.current?.contains(document.activeElement)) setHovered(undefined);
      }}
      data-workspace-global-tabs={pane === undefined ? '' : undefined}
    >
      <div
        className={cls('workspace-tablist')}
        role={tabs.length ? 'tablist' : undefined}
        aria-label={
          tabs.length
            ? pane === undefined
              ? t('allSessions')
              : t('paneRegion', { number: pane + 1 })
            : undefined
        }
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cls('workspace-tab-entry', ...(tab.pinned ? ['pinned'] : []))}
            role="presentation"
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                run(() => workspace.closeTab(tab.id));
              }
            }}
            draggable={renaming !== tab.id}
            onDragStart={(event) => {
              event.dataTransfer.setData(dragType, tab.id);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes(dragType)) event.preventDefault();
            }}
            onDrop={(event) => {
              const source = event.dataTransfer.getData(dragType);
              if (source.length > 512 || !state.tabs.some((value) => value.id === source)) return;
              event.preventDefault();
              workspace.arrange.moveTab(
                source,
                tab.id,
                event.clientX >
                  event.currentTarget.getBoundingClientRect().x +
                    event.currentTarget.getBoundingClientRect().width / 2,
              );
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu(tab.id);
            }}
          >
            <button
              type="button"
              className={cls(
                'workspace-tab',
                'terminal-tab',
                ...(active === tab.id ? ['active'] : []),
              )}
              role="tab"
              data-tab-id={tab.id}
              aria-label={tab.title}
              onMouseEnter={() => {
                setHovered(tab.id);
                if (
                  tabPreferences?.switchTabOnHover &&
                  active !== tab.id &&
                  !document.querySelector('.terminal-tab.dragging')
                )
                  workspace.selectTab(tab.id);
              }}
              id={`workspace-tab-${pane ?? 'global'}-${tab.id}`}
              aria-controls={'workspace-session-' + tab.id}
              aria-selected={active === tab.id}
              tabIndex={focusable === tab.id ? 0 : -1}
              onKeyDown={(event) => {
                if (event.target === event.currentTarget) key(event, tab);
              }}
              onClick={() => workspace.selectTab(tab.id)}
              onDoubleClick={() => {
                if (onDuplicate) run(() => onDuplicate(tab.id));
              }}
            >
              <>
                {(tabPreferences?.showTabNumber ?? true) && (
                  <span className={cls('tab-number')} aria-hidden="true">
                    {tab.tabNumber ?? state.tabs.findIndex((value) => value.id === tab.id) + 1}
                  </span>
                )}
                {tab.icon === 'terminal' ? (
                  <Terminal size={13} />
                ) : tab.icon === 'server' ? (
                  <Server size={13} />
                ) : tab.icon === 'files' ? (
                  <Folder size={13} />
                ) : tab.icon === 'desktop' ? (
                  <Monitor size={13} />
                ) : tab.icon === 'web' ? (
                  <Globe size={13} />
                ) : null}
                {tab.pinned ? '⌖ ' : ''}
                {tab.title}
              </>
            </button>
          </div>
        ))}
      </div>
      {target && position && (
        <>
          {renaming === target.id && (
            <input
              className={cls('workspace-tab-rename')}
              style={{
                left: position.left,
                top: position.top,
                width: position.width,
                height: position.height,
              }}
              autoFocus
              maxLength={512}
              aria-label={t('rename')}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={finishRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') finishRename();
                if (event.key === 'Escape') setRenaming(undefined);
              }}
            />
          )}
          {!renaming && (
            <div
              className={cls('workspace-tab-controls')}
              data-tab-controls-id={target.id}
              style={{
                left: position.left + position.width - 46,
                top: position.top,
                height: position.height,
              }}
            >
              <DropdownMenu
                open={menu === target.id}
                onOpenChange={(open) => setMenu(open ? target.id : undefined)}
              >
                <DropdownMenuTrigger asChild>
                  <button
                    className={cls('tab-actions')}
                    aria-label={t('tabActions', { title: target.title })}
                  >
                    ⋯
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuContent className={cls('tab-context-menu')} align="start">
                    <TabMenuItems
                      {...{ workspace, state, tab: target, t, renderSlot, onError }}
                      onRename={() => rename(target)}
                    />
                  </DropdownMenuContent>
                </DropdownMenuPortal>
              </DropdownMenu>
              <button
                className={cls('tab-close')}
                data-close-tab-id={target.id}
                aria-label={t('closeTab', { title: target.title })}
                onClick={() => run(() => workspace.closeTab(target.id))}
              >
                ×
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TabMenuItems({
  workspace,
  state,
  tab,
  t,
  renderSlot,
  onError,
  onRename,
}: WorkspaceProps &
  Pick<WorkspaceRootShare, 'renderSlot'> & { tab: WorkspaceTab; onRename(): void }) {
  const run = (fn: () => Promise<void>) => void fn().catch(onError);
  return (
    <>
      <DropdownMenuItem onSelect={() => workspace.arrange.pinTab(tab.id)}>
        {t(tab.pinned ? 'unpinTab' : 'pinTab')}
      </DropdownMenuItem>
      {renderSlot('workspace.tab-menu', { tabId: tab.id })}
      <DropdownMenuItem onSelect={() => onRename()}>{t('rename')}</DropdownMenuItem>
      {Array.from({ length: paneCount(state.arrangement?.mode ?? 'c1') }, (_, index) => (
        <DropdownMenuItem
          key={index}
          data-move-pane={index}
          disabled={tab.paneIndex === index}
          onSelect={() => workspace.arrange.moveToPane(tab.id, index)}
        >
          {t('moveToPane', { number: index + 1 })}
        </DropdownMenuItem>
      ))}
      <DropdownMenuItem onSelect={() => run(() => workspace.closeTab(tab.id))}>
        {t('closeTab', { title: tab.title })}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => run(() => workspace.arrange.closeTabs('others', tab.id))}>
        {t('closeOtherTabs')}
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={
          !state.tabs
            .slice(state.tabs.findIndex((item) => item.id === tab.id) + 1)
            .some((item) => !item.pinned)
        }
        onSelect={() => run(() => workspace.arrange.closeTabs('right', tab.id))}
      >
        {t('closeTabsToRight')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => run(() => workspace.arrange.closeTabs('all', tab.id))}>
        {t('closeAllTabs')}
      </DropdownMenuItem>
    </>
  );
}
export function AllTabsControl({ workspace, state, t }: WorkspaceProps) {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cls('toolbar-tab-control')}
            data-all-tabs=""
            aria-label={t('allTabs')}
            title={t('allTabs')}
            disabled={!state.tabs.length}
          >
            <ChevronDown size={13} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent className={cls('tab-context-menu', 'tab-overflow-menu')} align="end">
            {state.tabs.map((tab) => (
              <DropdownMenuItem
                key={tab.id}
                data-overflow-tab={tab.id}
                aria-current={active?.id === tab.id ? 'true' : undefined}
                onSelect={() => workspace.selectTab(tab.id)}
              >
                {tab.tabNumber ?? ''} {tab.title}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>
    </>
  );
}
export function TabToolbar({
  workspace,
  state,
  t,
  renderSlot,
  onError,
}: WorkspaceProps & Pick<WorkspaceRootShare, 'renderSlot'>) {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  const [renaming, setRenaming] = useState<WorkspaceTab>(),
    [draft, setDraft] = useState('');
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cls('toolbar-tab-control')}
            data-current-tab-actions=""
            aria-label={t('currentTabActions')}
            title={t('currentTabActions')}
            disabled={!active}
          >
            <Ellipsis size={15} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent className={cls('tab-context-menu')} align="end">
            {active && (
              <TabMenuItems
                {...{ workspace, state, tab: active, t, renderSlot, onError }}
                onRename={() => {
                  setDraft(active.title);
                  setRenaming(active);
                }}
              />
            )}
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>
      <Dialog
        open={!!renaming}
        onOpenChange={(open) => {
          if (!open) setRenaming(undefined);
        }}
      >
        <DialogContent closeLabel={t('close')}>
          <DialogTitle>{t('rename')}</DialogTitle>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (renaming && draft.trim() && state.tabs.some((tab) => tab.id === renaming.id))
                workspace.arrange.renameTab(renaming.id, draft);
              setRenaming(undefined);
            }}
          >
            <input
              autoFocus
              aria-label={t('rename')}
              maxLength={512}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" disabled={!draft.trim()}>
              {t('rename')}
            </button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function panePlacement(mode: WorkspaceLayoutMode, index: number): CSSProperties {
  if (mode === 'c1r2' || mode === 'r1c2')
    return { gridArea: ['primary', 'secondary', 'tertiary'][index] };
  if (mode === 'c2x2') return { gridRow: Math.floor(index / 2) + 1, gridColumn: (index % 2) + 1 };
  if (mode === 'r2' || mode === 'r3') return { gridRow: index + 1, gridColumn: 1 };
  return { gridRow: 1, gridColumn: index + 1 };
}
export function WorkspaceSessions({
  workspace,
  state,
  t,
  onError,
  renderSlot,
  sectionView,
  tabPreferences,
  onDuplicate,
}: WorkspaceProps & Pick<WorkspaceRootShare, 'renderSlot'> & { sectionView: boolean }) {
  const layout = state.arrangement ?? {
    mode: 'c1' as const,
    paneTabIds: [state.activeTabId ?? null],
    focusedPane: 0,
  };
  const ratios = layout.ratios ?? { x: 50, x2: 66.67, y: 50, y2: 66.67 };
  const gridStyle = {
    '--ax-workspace-split-x': ratios.x + '%',
    '--ax-workspace-split-x2': ratios.x2 + '%',
    '--ax-workspace-split-y': ratios.y + '%',
    '--ax-workspace-split-y2': ratios.y2 + '%',
  } as CSSProperties;
  const placement = (index: number) =>
    layout.maximizedPane === index
      ? { gridArea: '1 / 1 / -1 / -1' }
      : panePlacement(layout.mode, index);
  return (
    <div
      data-workspace-grid=""
      className={cls('terminal-pane-grid', `terminal-grid-${layout.mode}`)}
      hidden={sectionView}
      style={gridStyle}
    >
      {Array.from({ length: paneCount(layout.mode) }, (_, index) => (
        <section
          key={'pane-' + index}
          className={cls('terminal-pane', ...(index === layout.focusedPane ? ['active'] : []))}
          aria-label={t('paneRegion', { number: index + 1 })}
          data-pane-index={index}
          data-pane-empty={!layout.paneTabIds[index] ? 'true' : undefined}
          hidden={layout.maximizedPane !== undefined && layout.maximizedPane !== index}
          style={placement(index)}
          onMouseDown={() => {
            if (index !== layout.focusedPane) workspace.arrange.focusPane(index);
          }}
          onFocusCapture={() => {
            if (index !== layout.focusedPane) workspace.arrange.focusPane(index);
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes(dragType)) event.preventDefault();
          }}
          onDrop={(event) => {
            const id = event.dataTransfer.getData(dragType);
            if (id.length <= 512 && state.tabs.some((tab) => tab.id === id)) {
              event.preventDefault();
              workspace.arrange.moveToPane(id, index);
            }
          }}
        >
          {layout.mode !== 'c1' && index > 0 && (
            <div className={cls('pane-tabbar')}>
              <WorkspaceTabs
                {...{ workspace, state, t, onError, renderSlot, tabPreferences, onDuplicate }}
                pane={index}
              />
              {renderSlot(
                'workspace.toolbar',
                {
                  section: state.section,
                  activeTabId: layout.paneTabIds[index] ?? undefined,
                  paneIndex: index,
                },
                { only: 'terminals.new' },
              )}
              {renderSlot(
                'workspace.toolbar',
                {
                  section: state.section,
                  activeTabId: layout.paneTabIds[index] ?? undefined,
                  paneIndex: index,
                },
                { only: 'catalog.pane-new-session' },
              )}
              <button
                aria-label={t(layout.maximizedPane === index ? 'restorePane' : 'maximizePane')}
                onClick={() =>
                  workspace.arrange.maximizePane(layout.maximizedPane === index ? undefined : index)
                }
              >
                □
              </button>
              {index > 0 && (
                <button
                  data-pane-swap={`${index - 1}:${index}`}
                  title={t('swapPreviousPane')}
                  aria-label={t('swapPanes', { left: index, right: index + 1 })}
                  onClick={() => workspace.arrange.swapPanes(index - 1, index)}
                >
                  <SplitSquareHorizontal size={12} />
                </button>
              )}
            </div>
          )}
          {!layout.paneTabIds[index] &&
            renderSlot('workspace.empty', {
              section: state.section,
              activeTabId: undefined,
              ...(layout.mode === 'c1' ? {} : { paneIndex: index }),
            })}
        </section>
      ))}
      <PaneResizers layout={layout} workspace={workspace} t={t} />
      {state.tabs.map((tab) => {
        const index = tab.paneIndex ?? 0,
          visible =
            !sectionView &&
            layout.paneTabIds[index] === tab.id &&
            (layout.maximizedPane === undefined || layout.maximizedPane === index);
        return (
          <section
            key={tab.id}
            id={'workspace-session-' + tab.id}
            data-session-pane={index}
            className={cls('workspace-session', ...(layout.mode === 'c1' ? [] : ['pane-session']))}
            hidden={!visible}
            role="tabpanel"
            aria-labelledby={`workspace-tab-${layout.mode === 'c1' || index === 0 ? 'global' : index}-${tab.id}`}
            style={placement(index)}
            onMouseDown={() => {
              if (index !== layout.focusedPane) workspace.arrange.focusPane(index);
            }}
          >
            {renderSlot(
              'workspace.session',
              { tabId: tab.id, active: visible },
              { entryKey: tab.kind },
            )}
          </section>
        );
      })}
    </div>
  );
}

function PaneResizers({
  layout,
  workspace,
  t,
}: Text & { layout: WorkspaceArrangement; workspace: WorkspaceStore }) {
  if (layout.maximizedPane !== undefined || layout.mode === 'c1') return null;
  const axes: ('x' | 'x2' | 'y' | 'y2')[] = [];
  if (['c2', 'c3', 'c2x2', 'c1r2', 'r1c2'].includes(layout.mode)) axes.push('x');
  if (layout.mode === 'c3') axes.push('x2');
  if (['r2', 'r3', 'c2x2', 'c1r2', 'r1c2'].includes(layout.mode)) axes.push('y');
  if (layout.mode === 'r3') axes.push('y2');
  return axes.map((axis) => {
    const horizontal = axis.startsWith('y'),
      value = layout.ratios?.[axis] ?? (axis.endsWith('2') ? 66.67 : 50);
    const style: CSSProperties = horizontal
      ? { top: `${value}%`, left: 0, right: 0, height: 5, cursor: 'row-resize' }
      : { left: `${value}%`, top: 0, bottom: 0, width: 5, cursor: 'col-resize' };
    if (axis === 'x' && layout.mode === 'r1c2') style.top = `${layout.ratios?.y ?? 50}%`;
    if (axis === 'y' && layout.mode === 'c1r2') style.left = `${layout.ratios?.x ?? 50}%`;
    return (
      <div
        key={axis}
        className={cls('pane-resizer')}
        style={style}
        role="separator"
        aria-label={t('resizePanes')}
        aria-orientation={horizontal ? 'horizontal' : 'vertical'}
        aria-valuemin={10}
        aria-valuemax={90}
        aria-valuenow={Math.round(value)}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const bounds = event.currentTarget
            .closest('[data-workspace-grid]')!
            .getBoundingClientRect();
          const length = horizontal ? bounds.height : bounds.width;
          if (length > 0)
            workspace.arrange.resizePane(
              axis,
              (100 *
                ((horizontal ? event.clientY : event.clientX) -
                  (horizontal ? bounds.y : bounds.x))) /
                length,
            );
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onKeyDown={(event) => {
          const direction = ['ArrowLeft', 'ArrowUp'].includes(event.key)
            ? -1
            : ['ArrowRight', 'ArrowDown'].includes(event.key)
              ? 1
              : 0;
          if (direction) {
            event.preventDefault();
            workspace.arrange.resizePane(axis, value + direction * 5);
          }
        }}
      />
    );
  });
}
