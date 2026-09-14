import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type { Settings } from '@workspace/contracts';
import { useI18n } from '../i18n/context';

type Client = ReturnType<typeof createRuntimeClient>;
type StartupSessions = Settings['workspace']['startupSessions'];

export function ElectermBehaviorSettingsPanel({ client }: { client: Client }) {
  const { x } = useI18n();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: client.settings });
  const bookmarks = useQuery({ queryKey: ['bookmark-tree'], queryFn: client.bookmarkTree });
  const [startupModeOverride, setStartupModeOverride] = useState<'bookmarks' | 'workspace'>();
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function update(
    key: string,
    patch:
      | { workspace: { startupSessions: StartupSessions } }
      | { terminal: { screenReaderMode: boolean } }
      | {
          fileManager: Partial<
            Pick<
              Settings['fileManager'],
              'externalEditor' | 'refreshOnFocus' | 'followTerminalCwd' | 'sshSplitView'
            >
          >;
        },
  ) {
    if (busy) return;
    const current = queryClient.getQueryData<Settings>(['settings']) ?? settings.data;
    if (!current) return;
    setBusy(key);
    setError('');
    setNotice('');
    try {
      const next = await client.updateSettings(current, patch);
      queryClient.setQueryData(['settings'], next);
      setNotice(x('electermSettings.saved'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : x('electermSettings.saveFailed'));
      await settings.refetch();
    } finally {
      setBusy('');
    }
  }

  function saveEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const editorExecutable = String(
      new FormData(event.currentTarget).get('editorExecutable') ?? '',
    ).trim();
    void update('externalEditor', { fileManager: { externalEditor: editorExecutable } });
  }

  const startupSessions = settings.data?.workspace.startupSessions ?? [];
  const selectedBookmarks = Array.isArray(startupSessions) ? startupSessions : [];
  const selectedWorkspace = typeof startupSessions === 'string' ? startupSessions : '';
  const startupMode =
    startupModeOverride ??
    (typeof startupSessions === 'string' ? ('workspace' as const) : ('bookmarks' as const));

  return (
    <section
      className="surface stack electerm-behavior-settings"
      aria-labelledby="electerm-settings-title"
    >
      <h3 id="electerm-settings-title">{x('electermSettings.title')}</h3>
      <p className="hint">{x('electermSettings.description')}</p>

      <fieldset className="monitor-settings-group">
        <legend>{x('electermSettings.startup')}</legend>
        <div className="segmented compact-segmented" role="tablist">
          <button
            aria-selected={startupMode === 'bookmarks'}
            className={startupMode === 'bookmarks' ? 'active' : ''}
            onClick={() => {
              setStartupModeOverride('bookmarks');
              if (!Array.isArray(startupSessions))
                void update('startupSessions', { workspace: { startupSessions: [] } });
            }}
            role="tab"
            type="button"
          >
            {x('electermSettings.startupBookmarks')}
          </button>
          <button
            aria-selected={startupMode === 'workspace'}
            className={startupMode === 'workspace' ? 'active' : ''}
            onClick={() => setStartupModeOverride('workspace')}
            role="tab"
            type="button"
          >
            {x('electermSettings.startupWorkspace')}
          </button>
        </div>
        {startupMode === 'bookmarks' ? (
          <label className="field compact-field">
            <span>{x('electermSettings.startupBookmarks')}</span>
            <select
              aria-label={x('electermSettings.startupBookmarks')}
              disabled={!settings.data || bookmarks.isLoading || !!busy}
              multiple
              size={Math.min(7, Math.max(3, bookmarks.data?.bookmarks.length ?? 3))}
              value={selectedBookmarks}
              onChange={(event) => {
                const values = [...event.currentTarget.selectedOptions]
                  .map(({ value }) => value)
                  .slice(0, 20);
                void update('startupSessions', { workspace: { startupSessions: values } });
              }}
            >
              {!bookmarks.data?.bookmarks.length && (
                <option disabled value="">
                  {x('electermSettings.noStartupBookmarks')}
                </option>
              )}
              {bookmarks.data?.bookmarks.map((bookmark) => (
                <option key={bookmark.id} value={bookmark.id}>
                  {bookmark.title} · {bookmark.protocol.toUpperCase()}
                </option>
              ))}
            </select>
            <small className="hint">{x('electermSettings.startupBookmarksHint')}</small>
          </label>
        ) : (
          <label className="field compact-field">
            <span>{x('electermSettings.startupWorkspace')}</span>
            <select
              aria-label={x('electermSettings.startupWorkspace')}
              disabled={!settings.data || !!busy}
              value={selectedWorkspace}
              onChange={(event) =>
                void update('startupSessions', {
                  workspace: { startupSessions: event.currentTarget.value || [] },
                })
              }
            >
              <option value="">{x('electermSettings.noStartupWorkspace')}</option>
              {settings.data?.workspace.namedWorkspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
            <small className="hint">{x('electermSettings.startupWorkspaceHint')}</small>
          </label>
        )}
      </fieldset>

      <fieldset className="monitor-settings-group">
        <legend>{x('electermSettings.fileBehavior')}</legend>
        <label className="check">
          <input
            checked={settings.data?.fileManager.refreshOnFocus ?? false}
            disabled={!settings.data || !!busy}
            onChange={(event) =>
              void update('refreshOnFocus', {
                fileManager: { refreshOnFocus: event.currentTarget.checked },
              })
            }
            type="checkbox"
          />
          {x('electermSettings.refreshOnFocus')}
        </label>
        <label className="check">
          <input
            checked={settings.data?.fileManager.followTerminalCwd ?? false}
            disabled={!settings.data || !!busy}
            onChange={(event) =>
              void update('followTerminalCwd', {
                fileManager: { followTerminalCwd: event.currentTarget.checked },
              })
            }
            type="checkbox"
          />
          {x('electermSettings.followTerminalCwd')}
        </label>
        <label className="check">
          <input
            checked={settings.data?.fileManager.sshSplitView ?? false}
            disabled={!settings.data || !!busy}
            onChange={(event) =>
              void update('sshSplitView', {
                fileManager: { sshSplitView: event.currentTarget.checked },
              })
            }
            type="checkbox"
          />
          {x('electermSettings.sshSplitView')}
        </label>
        <form
          className="stack"
          key={settings.data?.fileManager.externalEditor ?? 'system-editor'}
          onSubmit={saveEditor}
        >
          <label className="field compact-field">
            <span>{x('electermSettings.externalEditor')}</span>
            <input
              autoComplete="off"
              disabled={!settings.data || !!busy}
              maxLength={4096}
              defaultValue={settings.data?.fileManager.externalEditor ?? ''}
              name="editorExecutable"
              placeholder={x('electermSettings.systemEditor')}
            />
            <small className="hint">{x('electermSettings.externalEditorHint')}</small>
          </label>
          <div className="modal-actions">
            <button className="primary" disabled={!settings.data || !!busy} type="submit">
              {x('electermSettings.saveEditor')}
            </button>
          </div>
        </form>
      </fieldset>

      <fieldset className="monitor-settings-group">
        <legend>{x('electermSettings.accessibility')}</legend>
        <label className="check">
          <input
            checked={settings.data?.terminal.screenReaderMode ?? false}
            disabled={!settings.data || !!busy}
            onChange={(event) =>
              void update('screenReaderMode', {
                terminal: { screenReaderMode: event.currentTarget.checked },
              })
            }
            type="checkbox"
          />
          {x('electermSettings.screenReaderMode')}
        </label>
        <p className="hint">{x('electermSettings.screenReaderHint')}</p>
      </fieldset>

      {notice && (
        <p className="hint" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="danger-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
