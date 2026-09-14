import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type { BatchOperation, CreateBatchOperationInput } from '@workspace/contracts';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  Play,
  Plus,
  Search,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react';
import './batch-operation-workspace.css';
import { useI18n } from '../../i18n/context';

type Client = ReturnType<typeof createRuntimeClient>;
type Step = CreateBatchOperationInput['steps'][number];

export function BatchOperationWorkspace({ client }: { client: Client }) {
  const { x } = useI18n();
  const queryClient = useQueryClient();
  const bookmarksQuery = useQuery({ queryKey: ['bookmark-tree'], queryFn: client.bookmarkTree });
  const operationsQuery = useQuery({
    queryKey: ['batch-operations'],
    queryFn: client.batchOperations,
    refetchInterval: 750,
  });
  const [name, setName] = useState(() => x('batchOperations.defaultName'));
  const [search, setSearch] = useState('');
  const [selectedBookmarks, setSelectedBookmarks] = useState<Set<string>>(new Set());
  const [steps, setSteps] = useState<Step[]>([newStep(x)]);
  const [concurrency, setConcurrency] = useState(4);
  const [selectedOperationId, setSelectedOperationId] = useState<string>();
  const [error, setError] = useState('');
  const sshBookmarks = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return (bookmarksQuery.data?.bookmarks ?? []).filter(
      (bookmark) =>
        bookmark.protocol === 'ssh' &&
        (!needle ||
          bookmark.title.toLocaleLowerCase().includes(needle) ||
          (bookmark.connectionDisplay ?? '').toLocaleLowerCase().includes(needle)),
    );
  }, [bookmarksQuery.data, search]);
  const operations = operationsQuery.data ?? [];
  const selectedOperation =
    operations.find(({ id }) => id === selectedOperationId) ?? operations[0];
  const active = operations.find(({ state }) => ['queued', 'running', 'canceling'].includes(state));

  function toggleBookmark(id: string) {
    setSelectedBookmarks((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function updateStep(index: number, patch: Partial<Step>) {
    setSteps((current) =>
      current.map((step, currentIndex) => (currentIndex === index ? { ...step, ...patch } : step)),
    );
  }

  function moveStep(index: number, offset: -1 | 1) {
    setSteps((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  async function run() {
    setError('');
    if (!selectedBookmarks.size) return setError(x('batchOperations.selectBookmark'));
    if (steps.some((step) => !step.name.trim() || !step.command))
      return setError(x('batchOperations.stepsRequired'));
    try {
      const operation = await client.createBatchOperation({
        name,
        bookmarkIds: [...selectedBookmarks],
        steps,
        concurrency,
        connectionTimeoutMs: 30_000,
      });
      setSelectedOperationId(operation.id);
      queryClient.setQueryData<BatchOperation[]>(['batch-operations'], (current = []) => [
        operation,
        ...current.filter(({ id }) => id !== operation.id),
      ]);
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  async function cancel(operation: BatchOperation) {
    setError('');
    try {
      const next = await client.cancelBatchOperation(operation.id);
      queryClient.setQueryData<BatchOperation[]>(['batch-operations'], (current = []) =>
        current.map((item) => (item.id === next.id ? next : item)),
      );
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  async function clearCompleted() {
    setError('');
    try {
      await client.clearBatchOperations();
      setSelectedOperationId(undefined);
      await operationsQuery.refetch();
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  return (
    <div className="batch-operation-workspace" data-testid="batch-operation-workspace">
      <section
        className="batch-operation-composer surface"
        aria-label={x('batchOperations.editor')}
      >
        <header>
          <div>
            <small>{x('batchOperations.eyebrow')}</small>
            <h3>{x('batchOperations.title')}</h3>
          </div>
          <label>
            {x('batchOperations.concurrency')}
            <select
              aria-label={x('batchOperations.concurrencyAria')}
              value={concurrency}
              onChange={(event) => setConcurrency(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </header>
        {error && <div className="batch-operation-error">{error}</div>}
        <label className="batch-operation-name">
          {x('batchOperations.name')}
          <input
            aria-label={x('batchOperations.nameAria')}
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="batch-operation-target-heading">
          <strong>{x('batchOperations.sshTargets')}</strong>
          <span>{x('batchOperations.selected', { count: selectedBookmarks.size })}</span>
          <button
            type="button"
            onClick={() => setSelectedBookmarks(new Set(sshBookmarks.map(({ id }) => id)))}
          >
            {x('batchOperations.selectAll')}
          </button>
          <button type="button" onClick={() => setSelectedBookmarks(new Set())}>
            {x('batchOperations.clear')}
          </button>
        </div>
        <label className="batch-operation-search">
          <Search size={14} />
          <input
            aria-label={x('batchOperations.searchTargets')}
            placeholder={x('batchOperations.searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="batch-operation-targets">
          {sshBookmarks.map((bookmark) => (
            <label key={bookmark.id}>
              <input
                type="checkbox"
                checked={selectedBookmarks.has(bookmark.id)}
                onChange={() => toggleBookmark(bookmark.id)}
              />
              <span>
                <strong>{bookmark.title}</strong>
                <small>{bookmark.connectionDisplay}</small>
              </span>
            </label>
          ))}
          {!sshBookmarks.length && <p>{x('batchOperations.noBookmarks')}</p>}
        </div>
        <div className="batch-operation-step-heading">
          <strong>{x('batchOperations.steps')}</strong>
          <button type="button" onClick={() => setSteps((current) => [...current, newStep(x)])}>
            <Plus size={13} /> {x('batchOperations.addStep')}
          </button>
        </div>
        <div className="batch-operation-steps">
          {steps.map((step, index) => (
            <article key={step.id} className="batch-operation-step">
              <div className="batch-operation-step-index">{index + 1}</div>
              <div className="batch-operation-step-fields">
                <input
                  aria-label={x('batchOperations.stepName', { number: index + 1 })}
                  value={step.name}
                  maxLength={100}
                  onChange={(event) => updateStep(index, { name: event.target.value })}
                />
                <textarea
                  aria-label={x('batchOperations.stepCommand', { number: index + 1 })}
                  value={step.command}
                  maxLength={16_384}
                  rows={3}
                  spellCheck={false}
                  onChange={(event) => updateStep(index, { command: event.target.value })}
                />
                <div>
                  <label>
                    {x('batchOperations.delay')}
                    <input
                      aria-label={x('batchOperations.stepDelay', { number: index + 1 })}
                      type="number"
                      min={0}
                      max={65_535}
                      value={step.delayMs}
                      onChange={(event) =>
                        updateStep(index, { delayMs: Number(event.target.value) })
                      }
                    />
                    ms
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={step.continueOnError}
                      onChange={(event) =>
                        updateStep(index, { continueOnError: event.target.checked })
                      }
                    />
                    {x('batchOperations.continueOnError')}
                  </label>
                </div>
              </div>
              <div className="batch-operation-step-actions">
                <button
                  type="button"
                  aria-label={x('batchOperations.moveStepUp', { number: index + 1 })}
                  onClick={() => moveStep(index, -1)}
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  type="button"
                  aria-label={x('batchOperations.moveStepDown', { number: index + 1 })}
                  onClick={() => moveStep(index, 1)}
                >
                  <ChevronDown size={13} />
                </button>
                <button
                  type="button"
                  aria-label={x('batchOperations.deleteStep', { number: index + 1 })}
                  disabled={steps.length === 1}
                  onClick={() => setSteps((current) => current.filter((_, item) => item !== index))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </article>
          ))}
        </div>
        <footer>
          <span>{x('batchOperations.executionHint')}</span>
          <button
            className="primary"
            type="button"
            disabled={Boolean(active)}
            onClick={() => void run()}
          >
            <Play size={14} />{' '}
            {x(active ? 'batchOperations.alreadyRunning' : 'batchOperations.start')}
          </button>
        </footer>
      </section>

      <section
        className="batch-operation-results surface"
        aria-label={x('batchOperations.results')}
      >
        <header>
          <div>
            <small>{x('batchOperations.historyEyebrow')}</small>
            <h3>{x('batchOperations.resultTitle')}</h3>
          </div>
          <button type="button" onClick={() => void clearCompleted()}>
            {x('batchOperations.clearCompleted')}
          </button>
        </header>
        <div className="batch-operation-history">
          {operations.map((operation) => (
            <button
              key={operation.id}
              type="button"
              aria-selected={operation.id === selectedOperation?.id}
              onClick={() => setSelectedOperationId(operation.id)}
            >
              <StateIcon state={operation.state} />
              <span>
                <strong>{operation.name}</strong>
                <small>
                  {stateLabel(operation.state, x)} · {operation.completedCount}/
                  {operation.targetCount}
                </small>
              </span>
            </button>
          ))}
          {!operations.length && <p>{x('batchOperations.emptyResults')}</p>}
        </div>
        {selectedOperation && (
          <div className="batch-operation-detail">
            <div className="batch-operation-summary">
              <span>
                {x('batchOperations.successCount', { count: selectedOperation.succeededCount })}
              </span>
              <span>
                {x('batchOperations.failureCount', { count: selectedOperation.failedCount })}
              </span>
              <span>
                {x('batchOperations.canceledCount', { count: selectedOperation.canceledCount })}
              </span>
              {['queued', 'running', 'canceling'].includes(selectedOperation.state) && (
                <button type="button" onClick={() => void cancel(selectedOperation)}>
                  <Square size={12} /> {x('common.cancel')}
                </button>
              )}
            </div>
            {selectedOperation.targets.map((target) => (
              <details key={target.bookmarkId} open={target.state !== 'queued'}>
                <summary>
                  <StateIcon state={target.state} />
                  <strong>{target.title}</strong>
                  <span>{stateLabel(target.state, x)}</span>
                  {target.errorCode && <code>{target.errorCode}</code>}
                </summary>
                <ol>
                  {target.steps.map((step) => (
                    <li key={step.stepId}>
                      <StateIcon state={step.state} />
                      <span>{step.name}</span>
                      <small>{stateLabel(step.state, x)}</small>
                      {step.exitCode !== null && <code>exit {step.exitCode}</code>}
                      {step.errorCode && <code>{step.errorCode}</code>}
                    </li>
                  ))}
                </ol>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function newStep(x: ReturnType<typeof useI18n>['x']): Step {
  return {
    id: crypto.randomUUID(),
    name: x('batchOperations.command'),
    command: '',
    delayMs: 0,
    continueOnError: false,
  };
}

function StateIcon({ state }: { state: string }) {
  if (state === 'succeeded') return <CheckCircle2 className="success" size={14} />;
  if (['failed', 'interrupted'].includes(state)) return <XCircle className="danger" size={14} />;
  return <CircleDashed className={state === 'running' ? 'running' : ''} size={14} />;
}

function stateLabel(state: string, x: ReturnType<typeof useI18n>['x']): string {
  return (
    {
      queued: x('batchOperations.stateQueued'),
      connecting: x('batchOperations.stateConnecting'),
      running: x('batchOperations.stateRunning'),
      canceling: x('batchOperations.stateCanceling'),
      succeeded: x('batchOperations.stateSucceeded'),
      failed: x('batchOperations.stateFailed'),
      skipped: x('batchOperations.stateSkipped'),
      canceled: x('batchOperations.stateCanceled'),
      interrupted: x('batchOperations.stateInterrupted'),
    }[state] ?? state
  );
}

function messageOf(error: unknown, x: ReturnType<typeof useI18n>['x']): string {
  return error instanceof Error ? error.message : x('batchOperations.failed');
}
