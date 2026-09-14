import { useMemo, useState, type DragEvent, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type {
  QuickCommand,
  QuickCommandInput,
  QuickCommandTree,
  QuickCommandTreeNode,
} from '@workspace/contracts';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderPlus,
  GripVertical,
  Plus,
  Save,
  Search,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useWorkspace } from '../../stores/workspace';
import {
  buildQuickCommandRows,
  quickCommandDropPosition,
  quickCommandTextForInsert,
} from './quick-command-model';
import './quick-command-workspace.css';
import { useI18n } from '../../i18n/context';

type Client = ReturnType<typeof createRuntimeClient>;
type Selection = QuickCommandTreeNode | { kind: 'new-command'; parentId: string | null };
const dragMime = 'application/x-axterm-quick-command-node';
const templates = ['clipboard', 'time', 'date'] as const;

export function QuickCommandWorkspace({ client }: { client: Client }) {
  const { x } = useI18n();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['quick-command-tree'], queryFn: client.quickCommandTree });
  const [selection, setSelection] = useState<Selection>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [newFolderParent, setNewFolderParent] = useState<string | null | undefined>();
  const [error, setError] = useState('');
  const tree = query.data;
  const rows = useMemo(
    () => (tree ? buildQuickCommandRows(tree, expanded, search) : []),
    [expanded, search, tree],
  );

  async function mutate(operation: (tree: QuickCommandTree) => Promise<QuickCommandTree>) {
    if (!tree) return;
    setError('');
    try {
      const next = await operation(tree);
      queryClient.setQueryData(['quick-command-tree'], next);
      queryClient.setQueryData(['quick-commands'], next.commands);
      return next;
    } catch (cause) {
      setError(messageOf(cause, x));
      await query.refetch();
      return undefined;
    }
  }

  async function createFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
    if (!name) return;
    const parentId = newFolderParent ?? null;
    const before = new Set(tree?.groups.map(({ id }) => id));
    const next = await mutate((current) =>
      client.createQuickCommandGroup(current, { parentId, name }),
    );
    const created = next?.groups.find(({ id }) => !before.has(id));
    if (created) {
      if (created.parentId)
        setExpanded((current) => new Set(current).add(created.parentId as string));
      setSelection({ kind: 'group', id: created.id });
    }
    setNewFolderParent(undefined);
  }

  async function drop(event: DragEvent<HTMLButtonElement>, target: QuickCommandTreeNode) {
    event.preventDefault();
    if (!tree) return;
    const raw = event.dataTransfer.getData(dragMime);
    let source: QuickCommandTreeNode;
    try {
      source = JSON.parse(raw) as QuickCommandTreeNode;
    } catch {
      return;
    }
    if (!['group', 'command'].includes(source.kind) || !source.id) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = quickCommandDropPosition(
      target.kind,
      event.clientY,
      bounds.top,
      bounds.height,
    );
    const next = await mutate((current) =>
      client.moveQuickCommandTreeNode(current, { source, target, position }),
    );
    if (next && position === 'inside' && target.kind === 'group')
      setExpanded((current) => new Set(current).add(target.id));
  }

  const selectedCommand =
    selection?.kind === 'command'
      ? tree?.commands.find(({ id }) => id === selection.id)
      : undefined;
  const selectedGroup =
    selection?.kind === 'group' ? tree?.groups.find(({ id }) => id === selection.id) : undefined;
  const commandParentId =
    selection?.kind === 'new-command' ? selection.parentId : selectedCommand?.groupId;

  return (
    <div className="quick-command-workspace" data-testid="quick-command-workspace">
      <section className="quick-command-library surface" aria-label={x('quickCommands.library')}>
        <div className="quick-command-toolbar">
          <label className="quick-command-search">
            <Search size={14} />
            <input
              aria-label={x('quickCommands.search')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={x('quickCommands.searchPlaceholder')}
            />
            {search && (
              <button
                type="button"
                aria-label={x('quickCommands.clearSearch')}
                onClick={() => setSearch('')}
              >
                <X size={13} />
              </button>
            )}
          </label>
          <button
            type="button"
            title={x('quickCommands.newFolder')}
            aria-label={x('quickCommands.newFolderAria')}
            onClick={() => setNewFolderParent(selection?.kind === 'group' ? selection.id : null)}
          >
            <FolderPlus size={14} />
          </button>
          <button
            type="button"
            title={x('quickCommands.newCommand')}
            aria-label={x('quickCommands.newCommand')}
            onClick={() =>
              setSelection({
                kind: 'new-command',
                parentId: selection?.kind === 'group' ? selection.id : null,
              })
            }
          >
            <Plus size={14} />
          </button>
        </div>
        {newFolderParent !== undefined && (
          <form
            className="quick-command-folder-create"
            onSubmit={(event) => void createFolder(event)}
          >
            <Folder size={13} />
            <input
              name="name"
              aria-label={x('quickCommands.folderName')}
              maxLength={60}
              autoFocus
              required
            />
            <button className="primary" aria-label={x('quickCommands.saveFolder')}>
              <Save size={12} />
            </button>
            <button
              type="button"
              aria-label={x('quickCommands.cancelNewFolder')}
              onClick={() => setNewFolderParent(undefined)}
            >
              <X size={12} />
            </button>
          </form>
        )}
        <div className="quick-command-tree" role="tree" aria-busy={query.isLoading}>
          {rows.map((row) => {
            const selected =
              selection?.kind === row.ref.kind && 'id' in selection && selection.id === row.ref.id;
            const isExpanded = row.ref.kind === 'group' && expanded.has(row.ref.id);
            return (
              <button
                type="button"
                role="treeitem"
                aria-level={row.depth + 1}
                aria-selected={selected}
                aria-expanded={row.ref.kind === 'group' ? isExpanded : undefined}
                className={`quick-command-tree-row ${row.matched ? 'matched' : ''}`}
                key={`${row.ref.kind}:${row.ref.id}`}
                style={{ paddingLeft: 8 + row.depth * 18 }}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData(dragMime, JSON.stringify(row.ref));
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(event) => void drop(event, row.ref)}
                onClick={() => {
                  setSelection(row.ref);
                  if (row.ref.kind === 'group')
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(row.ref.id)) next.delete(row.ref.id);
                      else next.add(row.ref.id);
                      return next;
                    });
                }}
              >
                <GripVertical className="quick-command-drag" size={12} />
                {row.ref.kind === 'group' ? (
                  <>
                    {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <Folder size={14} />
                  </>
                ) : (
                  <Terminal size={14} />
                )}
                <span>{row.name}</span>
                {row.command?.tags[0] && <small>{row.command.tags[0]}</small>}
              </button>
            );
          })}
          {!query.isLoading && !rows.length && (
            <div className="quick-command-empty">
              {search ? x('quickCommands.noMatches') : x('quickCommands.createFirst')}
            </div>
          )}
        </div>
      </section>

      <section className="quick-command-editor surface">
        {error && <div className="quick-command-error">{error}</div>}
        {(selectedCommand || selection?.kind === 'new-command') && commandParentId !== undefined ? (
          <QuickCommandEditor
            key={selectedCommand?.id ?? `new:${commandParentId ?? 'root'}`}
            {...(selectedCommand ? { command: selectedCommand } : {})}
            groupId={commandParentId}
            onSave={async (value) => {
              const previousIds = new Set(tree?.commands.map(({ id }) => id));
              const next = selectedCommand
                ? await mutate((current) =>
                    client.updateQuickCommand(current, selectedCommand.id, {
                      name: value.name,
                      command: value.command,
                      commands: value.commands,
                      description: value.description,
                      tags: value.tags,
                      shortcut: value.shortcut,
                      inputOnly: value.inputOnly,
                    }),
                  )
                : await mutate((current) => client.createQuickCommand(current, value));
              if (!selectedCommand && next) {
                const created = next.commands.find(({ id }) => !previousIds.has(id));
                if (created) setSelection({ kind: 'command', id: created.id });
              }
            }}
            {...(selectedCommand
              ? {
                  onDelete: async () => {
                    const next = await mutate((current) =>
                      client.deleteQuickCommand(current, selectedCommand.id),
                    );
                    if (next) setSelection(undefined);
                  },
                  onDuplicate: async () => {
                    const previousIds = new Set(tree?.commands.map(({ id }) => id));
                    const value = commandInput(
                      selectedCommand,
                      duplicateName(selectedCommand.name, tree?.commands ?? []),
                    );
                    const next = await mutate((current) =>
                      client.createQuickCommand(current, value),
                    );
                    const created = next?.commands.find(({ id }) => !previousIds.has(id));
                    if (created) setSelection({ kind: 'command', id: created.id });
                  },
                }
              : {})}
            onIncrement={async () => {
              if (!selectedCommand) return;
              await mutate((current) =>
                client.updateQuickCommand(current, selectedCommand.id, {
                  clickCount: selectedCommand.clickCount + 1,
                }),
              );
            }}
            onError={setError}
          />
        ) : selectedGroup ? (
          <QuickCommandGroupEditor
            key={selectedGroup.id}
            name={selectedGroup.name}
            onSave={(name) =>
              mutate((current) =>
                client.updateQuickCommandGroup(current, selectedGroup.id, { name }),
              )
            }
            onCreateFolder={() => setNewFolderParent(selectedGroup.id)}
            onCreateCommand={() =>
              setSelection({ kind: 'new-command', parentId: selectedGroup.id })
            }
            onDelete={async () => {
              const next = await mutate((current) =>
                client.deleteQuickCommandGroup(current, selectedGroup.id),
              );
              if (next) setSelection(undefined);
            }}
          />
        ) : (
          <div className="quick-command-editor-empty">
            <Terminal size={28} />
            <strong>{x('quickCommands.title')}</strong>
            <p>{x('quickCommands.editorEmpty')}</p>
            <button
              className="primary"
              onClick={() => setSelection({ kind: 'new-command', parentId: null })}
            >
              <Plus size={13} /> {x('quickCommands.newCommand')}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function QuickCommandEditor({
  command,
  groupId,
  onSave,
  onDelete,
  onDuplicate,
  onIncrement,
  onError,
}: {
  command?: QuickCommand;
  groupId: string | null;
  onSave(input: QuickCommandInput): Promise<void>;
  onDelete?: () => Promise<void>;
  onDuplicate?: () => Promise<void>;
  onIncrement(): Promise<void>;
  onError(message: string): void;
}) {
  const { x } = useI18n();
  const tabs = useWorkspace((state) => state.tabs);
  const activeTerminalId = useWorkspace((state) => state.activeTerminalId);
  const insertTerminal = useWorkspace((state) => state.insertTerminal);
  const setActiveTerminal = useWorkspace((state) => state.setActiveTerminal);
  const [name, setName] = useState(command?.name ?? '');
  const [description, setDescription] = useState(command?.description ?? '');
  const [tags, setTags] = useState(command?.tags.join(', ') ?? '');
  const [shortcut, setShortcut] = useState(command?.shortcut ?? '');
  const [inputOnly, setInputOnly] = useState(command?.inputOnly ?? false);
  const [steps, setSteps] = useState(
    command?.commands ?? [{ id: crypto.randomUUID(), name: '', command: '', delayMs: 100 }],
  );
  const [saving, setSaving] = useState(false);
  const target = activeTerminalId ?? tabs.at(-1)?.id;

  function value(): QuickCommandInput {
    return {
      groupId,
      name: name.trim(),
      command: steps[0]?.command ?? '',
      commands: steps,
      description,
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      shortcut: shortcut.trim() || null,
      inputOnly,
      clickCount: command?.clickCount ?? 0,
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave(value());
    } finally {
      setSaving(false);
    }
  }

  async function insert() {
    if (!command || !target) return;
    try {
      const text = await quickCommandTextForInsert(command, () => navigator.clipboard.readText());
      setActiveTerminal(target);
      insertTerminal(target, text);
      await onIncrement();
    } catch {
      onError(x('quickCommands.clipboardInsertFailed'));
    }
  }

  return (
    <form className="quick-command-form" onSubmit={(event) => void submit(event)}>
      <header>
        <div>
          <small>{command ? x('quickCommands.editEyebrow') : x('quickCommands.newEyebrow')}</small>
          <h3>{command?.name ?? x('quickCommands.newCommand')}</h3>
        </div>
        <div className="quick-command-editor-actions">
          {command && (
            <button type="button" disabled={!target} onClick={() => void insert()}>
              <Terminal size={13} /> {x('quickCommands.insert')}
            </button>
          )}
          {onDuplicate && (
            <button type="button" onClick={() => void onDuplicate()}>
              <Copy size={13} /> {x('quickCommands.duplicate')}
            </button>
          )}
          {onDelete && (
            <button className="danger" type="button" onClick={() => void onDelete()}>
              <Trash2 size={13} /> {x('quickCommands.delete')}
            </button>
          )}
        </div>
      </header>
      <div className="quick-command-form-grid">
        <label>
          {x('quickCommands.name')}
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            required
          />
        </label>
        <label>
          {x('quickCommands.shortcut')}
          <input
            value={shortcut}
            onChange={(event) => setShortcut(event.target.value)}
            placeholder={x('quickCommands.shortcutExample')}
            maxLength={100}
          />
        </label>
        <label className="wide">
          {x('quickCommands.description')}
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={2000}
          />
        </label>
        <label className="wide">
          {x('quickCommands.tags')}
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="ops, docker"
          />
        </label>
      </div>
      <div className="quick-command-steps-heading">
        <div>
          <strong>{x('quickCommands.steps')}</strong>
          <small>{x('quickCommands.stepsHint')}</small>
        </div>
        <button
          type="button"
          onClick={() =>
            setSteps((current) => [
              ...current,
              { id: crypto.randomUUID(), name: '', command: '', delayMs: 100 },
            ])
          }
        >
          <Plus size={13} /> {x('quickCommands.addStep')}
        </button>
      </div>
      <div className="quick-command-steps">
        {steps.map((step, index) => (
          <div
            className="quick-command-step"
            key={step.id}
            draggable
            onDragStart={(event) => event.dataTransfer.setData('text/plain', String(index))}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const source = Number(event.dataTransfer.getData('text/plain'));
              if (!Number.isInteger(source) || source === index) return;
              setSteps((current) => {
                const next = [...current];
                const [moved] = next.splice(source, 1);
                if (moved) next.splice(index, 0, moved);
                return next;
              });
            }}
          >
            <GripVertical className="quick-command-step-grip" size={14} />
            <input
              aria-label={x('quickCommands.stepName', { number: index + 1 })}
              value={step.name}
              maxLength={100}
              placeholder={x('quickCommands.step', { number: index + 1 })}
              onChange={(event) =>
                setSteps((current) =>
                  current.map((item) =>
                    item.id === step.id ? { ...item, name: event.target.value } : item,
                  ),
                )
              }
            />
            <label>
              {x('quickCommands.delay')}
              <input
                aria-label={x('quickCommands.stepDelay', { number: index + 1 })}
                type="number"
                min={1}
                max={65535}
                value={step.delayMs}
                onChange={(event) =>
                  setSteps((current) =>
                    current.map((item) =>
                      item.id === step.id ? { ...item, delayMs: Number(event.target.value) } : item,
                    ),
                  )
                }
              />
              ms
            </label>
            <textarea
              aria-label={x('quickCommands.stepCommand', { number: index + 1 })}
              value={step.command}
              rows={Math.max(2, Math.min(8, step.command.split('\n').length))}
              maxLength={16384}
              required
              onChange={(event) =>
                setSteps((current) =>
                  current.map((item) =>
                    item.id === step.id ? { ...item, command: event.target.value } : item,
                  ),
                )
              }
            />
            <button
              type="button"
              aria-label={x('quickCommands.deleteStep', { number: index + 1 })}
              disabled={steps.length === 1}
              onClick={() => setSteps((current) => current.filter(({ id }) => id !== step.id))}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="quick-command-templates">
        <span>{x('quickCommands.templates')}</span>
        {templates.map((template) => (
          <button
            type="button"
            key={template}
            onClick={() =>
              setSteps((current) =>
                current.map((step, index) =>
                  index === current.length - 1
                    ? { ...step, command: `${step.command}{{${template}}}` }
                    : step,
                ),
              )
            }
          >
            {`{{${template}}}`}
          </button>
        ))}
      </div>
      <label className="quick-command-input-only">
        <input
          type="checkbox"
          checked={inputOnly}
          onChange={(event) => setInputOnly(event.target.checked)}
        />
        {x('quickCommands.inputMode')}
      </label>
      <footer>
        <button className="primary" disabled={saving || !steps.length}>
          <Save size={13} /> {saving ? x('quickCommands.saving') : x('quickCommands.save')}
        </button>
      </footer>
    </form>
  );
}

function QuickCommandGroupEditor({
  name: initialName,
  onSave,
  onCreateFolder,
  onCreateCommand,
  onDelete,
}: {
  name: string;
  onSave(name: string): Promise<unknown>;
  onCreateFolder(): void;
  onCreateCommand(): void;
  onDelete(): Promise<void>;
}) {
  const { x } = useI18n();
  const [name, setName] = useState(initialName);
  return (
    <form
      className="quick-command-group-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(name.trim());
      }}
    >
      <header>
        <div>
          <small>{x('quickCommands.folderEyebrow')}</small>
          <h3>{initialName}</h3>
        </div>
        <button className="danger" type="button" onClick={() => void onDelete()}>
          <Trash2 size={13} /> {x('quickCommands.delete')}
        </button>
      </header>
      <label>
        {x('quickCommands.folderName')}
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={60}
          required
        />
      </label>
      <div className="quick-command-group-actions">
        <button className="primary">
          <Save size={13} /> {x('quickCommands.saveName')}
        </button>
        <button type="button" onClick={onCreateCommand}>
          <Plus size={13} /> {x('quickCommands.newCommandShort')}
        </button>
        <button type="button" onClick={onCreateFolder}>
          <FolderPlus size={13} /> {x('quickCommands.newSubfolder')}
        </button>
      </div>
      <p>{x('quickCommands.deleteFolderHint')}</p>
    </form>
  );
}

function commandInput(command: QuickCommand, name = command.name): QuickCommandInput {
  return {
    groupId: command.groupId,
    name,
    command: command.command,
    commands: command.commands.map((step) => ({ ...step, id: crypto.randomUUID() })),
    description: command.description,
    tags: command.tags,
    shortcut: null,
    inputOnly: command.inputOnly,
    clickCount: 0,
  };
}

function duplicateName(source: string, commands: QuickCommand[]): string {
  const base = source.replace(/\(\d+\)$/u, '');
  const names = new Set(commands.map(({ name }) => name.toLocaleLowerCase()));
  let index = 1;
  let candidate = `${base}(${index})`;
  while (names.has(candidate.toLocaleLowerCase())) candidate = `${base}(${++index})`;
  return candidate.slice(0, 60);
}

function messageOf(cause: unknown, x: ReturnType<typeof useI18n>['x']): string {
  return cause instanceof Error ? cause.message : x('quickCommands.operationFailed');
}
