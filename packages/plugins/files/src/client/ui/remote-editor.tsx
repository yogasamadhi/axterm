import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import type { FilesSessionOwner } from './session-owner.ts';
import type { RemoteFileTarget } from '@axterm/plugin-api/files';
import { remoteErrorOf } from '@axterm/plugin-api';
import { Dialog, DialogContent, DialogTitle } from '@axterm/ui/controls';
import { cx } from './styles.ts';
import { ChevronDown, ChevronUp, Copy, FilePlus2, RotateCcw, Save, Search, X } from 'lucide-react';
import { useI18n } from './i18n.tsx';

export function RemoteEditor({
  owner,
  target,
  path,
  onClose,
  onSavedAs,
}: {
  owner: FilesSessionOwner;
  target: RemoteFileTarget;
  path: string;
  onClose(): void;
  onSavedAs?(path: string): void;
}) {
  const { x } = useI18n();
  const model = owner.files,
    commands = owner.commands;
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const revision = useRef('');
  const saving = useRef(false);
  const lineEnding = useRef<'lf' | 'crlf'>('lf');
  const originalContent = useRef('');
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matches, setMatches] = useState<Array<{ from: number; to: number }>>([]);
  const [matchIndex, setMatchIndex] = useState(-1);
  const [saveAsPath, setSaveAsPath] = useState('');

  const connectionId = target.connectionId,
    protocol = target.protocol;
  useEffect(() => {
    let disposed = false;
    if (!container.current) return;
    view.current = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: '',
        extensions: [
          history({ minDepth: 64 }),
          EditorState.transactionFilter.of((transaction) =>
            (!transaction.docChanged || !saving.current) &&
            new TextEncoder().encode(transaction.newDoc.toString()).byteLength <= 2 * 1024 * 1024
              ? transaction
              : [],
          ),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            setDirty(update.state.doc.toString() !== originalContent.current);
            setState('ready');
            setMessage('');
            setConflicted(false);
          }),
          EditorView.theme({
            '&': { height: '100%', backgroundColor: '#0a0e10', color: '#dce4e8' },
            '.cm-scroller': { fontFamily: 'SFMono-Regular, Consolas, monospace' },
            '.cm-gutters': {
              backgroundColor: '#101519',
              color: '#64737a',
              border: 'none',
            },
            '.cm-cursor': { borderLeftColor: '#82dfa0' },
            '&.cm-focused .cm-selectionBackground, ::selection': {
              backgroundColor: '#365842 !important',
            },
          }),
        ],
      }),
    });
    void model.readRemoteText({ connectionId, protocol }, path, owner.lifetime.signal).then(
      (document) => {
        if (disposed || !view.current) return;
        revision.current = document.revision;
        lineEnding.current = document.lineEnding;
        originalContent.current = document.content;
        view.current.dispatch({
          changes: { from: 0, to: view.current.state.doc.length, insert: document.content },
          selection: { anchor: 0 },
        });
        setDirty(false);
        setState('ready');
      },
      (error: Error) => {
        setState('error');
        setMessage(error.message);
      },
    );
    return () => {
      disposed = true;
      view.current?.destroy();
      view.current = undefined;
    };
  }, [owner, model, connectionId, protocol, path]);

  async function save() {
    if (!view.current || saving.current) return;
    saving.current = true;
    setState('saving');
    setMessage('');
    try {
      const content = view.current.state.doc.toString();
      const request = {
        path,
        content,
        overwriteRevision: revision.current,
        lineEnding: lineEnding.current,
      };
      await commands.file((key, signal) => model.writeRemoteText(key, target, request, signal));
      const saved = await model.readRemoteText(target, path, owner.lifetime.signal);
      const expected =
        request.lineEnding === 'crlf'
          ? content.replace(/\r?\n/g, '\r\n')
          : content.replace(/\r\n/g, '\n');
      if (saved.content !== expected) throw Error(x('remoteEditor.conflict'));
      revision.current = saved.revision;
      originalContent.current = content;
      setDirty(false);
      setConflicted(false);
      setState('saved');
      setMessage(x('remoteEditor.saved'));
    } catch (error) {
      setState('error');
      setConflicted(
        remoteErrorOf(error)?.code === 'files/failure' &&
          (remoteErrorOf(error)?.details as { reason: string }).reason === 'conflict',
      );
      setMessage(error instanceof Error ? error.message : x('remoteEditor.saveFailed'));
    } finally {
      saving.current = false;
    }
  }

  async function reload() {
    if (!view.current || saving.current) return;
    setState('loading');
    setMessage('');
    try {
      const document = await model.readRemoteText(target, path, owner.lifetime.signal);
      revision.current = document.revision;
      lineEnding.current = document.lineEnding;
      originalContent.current = document.content;
      view.current.dispatch({
        changes: { from: 0, to: view.current.state.doc.length, insert: document.content },
        selection: { anchor: 0 },
      });
      setDirty(false);
      setConflicted(false);
      setState('ready');
      setMessage(x('remoteEditor.reloaded'));
    } catch (error) {
      setState('error');
      setMessage(error instanceof Error ? error.message : x('remoteEditor.reloadFailed'));
    }
  }

  async function saveAs() {
    const remoteTarget = target;
    const destination = saveAsPath.trim();
    if (!view.current || !destination || saving.current) return;
    saving.current = true;
    const content = view.current.state.doc.toString();
    const savedLineEnding = lineEnding.current;
    setState('saving');
    setMessage('');
    try {
      await commands.file((key, signal) =>
        model.createRemoteEntry(key, remoteTarget, { path: destination, type: 'file' }, signal),
      );
      const empty = await model.readRemoteText(remoteTarget, destination, owner.lifetime.signal);
      if (empty.content !== '') throw Error(x('remoteEditor.conflict'));
      await commands.file((key, signal) =>
        model.writeRemoteText(
          key,
          remoteTarget,
          {
            path: destination,
            content,
            overwriteRevision: empty.revision,
            lineEnding: savedLineEnding,
          },
          signal,
        ),
      );
      setDirty(false);
      setConflicted(false);
      setState('saved');
      setMessage(x('remoteEditor.savedAs', { path: destination }));
      onSavedAs?.(destination);
    } catch (error) {
      setState('error');
      setMessage(error instanceof Error ? error.message : x('remoteEditor.saveAsFailed'));
    } finally {
      saving.current = false;
    }
  }

  function find() {
    if (!view.current || !searchQuery) {
      setMatches([]);
      setMatchIndex(-1);
      return;
    }
    const source = view.current.state.doc.toString().toLocaleLowerCase();
    const query = searchQuery.toLocaleLowerCase();
    const next: Array<{ from: number; to: number }> = [];
    let offset = 0;
    while (next.length < 1_000) {
      const found = source.indexOf(query, offset);
      if (found < 0) break;
      next.push({ from: found, to: found + query.length });
      offset = found + Math.max(1, query.length);
    }
    setMatches(next);
    setMatchIndex(next.length ? 0 : -1);
    if (next[0]) selectMatch(next[0]);
  }

  function moveMatch(delta: number) {
    if (!matches.length) return;
    const next = (matchIndex + delta + matches.length) % matches.length;
    setMatchIndex(next);
    const match = matches[next];
    if (match) selectMatch(match);
  }

  function selectMatch(match: { from: number; to: number }) {
    view.current?.dispatch({
      selection: { anchor: match.from, head: match.to },
      effects: EditorView.scrollIntoView(match.from, { y: 'center' }),
    });
    view.current?.focus();
  }

  async function copyContent() {
    if (!view.current) return;
    try {
      await navigator.clipboard.writeText(view.current.state.doc.toString());
      setMessage(x('remoteEditor.copied'));
    } catch {
      setMessage(x('remoteEditor.clipboardFailed'));
    }
  }

  function close() {
    if (dirty && !window.confirm(x('remoteEditor.closeDirtyConfirm'))) return;
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  }

  return (
    <Dialog
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent asChild container={owner.container ?? null}>
        <div
          className={cx('remote-editor')}
          role="dialog"
          aria-label={x('remoteEditor.title')}
          onKeyDown={handleKeyDown}
        >
          <header>
            <DialogTitle asChild>
              <span title={path}>
                {path} {dirty ? '●' : ''}
              </span>
            </DialogTitle>
            <div>
              <small>{message || x(`remoteEditor.state.${state}`)}</small>
              <button
                onClick={() => void save()}
                disabled={state === 'loading' || state === 'saving'}
              >
                <Save size={14} /> {x('remoteEditor.save')}
              </button>
              <button onClick={close} aria-label={x('remoteEditor.close')}>
                <X size={14} />
              </button>
            </div>
          </header>
          <div className={cx('remote-editor-toolbar')}>
            <label>
              <Search size={13} />
              <input
                aria-label={x('remoteEditor.find')}
                value={searchQuery}
                placeholder={x('remoteEditor.findPlaceholder')}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    find();
                  }
                }}
              />
            </label>
            <span>{matches.length ? `${matchIndex + 1}/${matches.length}` : '0/0'}</span>
            <button
              type="button"
              title={x('remoteEditor.previousMatch')}
              disabled={!matches.length}
              onClick={() => moveMatch(-1)}
            >
              <ChevronUp size={13} />
            </button>
            <button
              type="button"
              title={x('remoteEditor.nextMatch')}
              disabled={!matches.length}
              onClick={() => moveMatch(1)}
            >
              <ChevronDown size={13} />
            </button>
            <button type="button" onClick={() => void copyContent()}>
              <Copy size={13} /> {x('remoteEditor.copyAll')}
            </button>
          </div>
          {conflicted && (
            <div className={cx('remote-editor-conflict')} role="alert">
              <strong>{x('remoteEditor.conflict')}</strong>
              <button type="button" onClick={() => void reload()}>
                <RotateCcw size={13} /> {x('remoteEditor.reload')}
              </button>
              <label>
                {x('remoteEditor.saveAsPath')}
                <input
                  value={saveAsPath}
                  placeholder="/path/to/copy.txt"
                  onChange={(event) => setSaveAsPath(event.target.value)}
                />
              </label>
              <button type="button" disabled={!saveAsPath.trim()} onClick={() => void saveAs()}>
                <FilePlus2 size={13} /> {x('remoteEditor.saveAs')}
              </button>
            </div>
          )}
          <div className={cx('editor-host')} ref={container} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
