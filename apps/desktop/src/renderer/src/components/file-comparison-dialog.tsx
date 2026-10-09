import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FileComparison } from '@workspace/contracts';
import { Check, Copy, FileDiff, TriangleAlert, X } from 'lucide-react';
import { useI18n } from '../i18n/context';

export function FileComparisonDialog({
  comparison,
  onClose,
}: {
  comparison: FileComparison;
  onClose(): void;
}) {
  const { x } = useI18n();
  const [tab, setTab] = useState<'info' | 'content'>('info');
  const rows = useMemo(
    () =>
      comparison.status === 'different'
        ? buildDiffRows(comparison.left.content ?? '', comparison.right.content ?? '')
        : [],
    [comparison],
  );

  return createPortal(
    <div className="modal-backdrop">
      <section
        className="modal file-comparison-dialog"
        role="dialog"
        aria-label={x('fileComparison.title')}
      >
        <header>
          <div>
            <strong>{x('fileComparison.title')}</strong>
            <small>
              {comparison.left.name} ↔ {comparison.right.name}
            </small>
          </div>
          <button type="button" aria-label={x('fileComparison.close')} onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="file-comparison-tabs" role="tablist" aria-label={x('fileComparison.views')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'info'}
            onClick={() => setTab('info')}
          >
            {x('fileComparison.info')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'content'}
            onClick={() => setTab('content')}
          >
            {x('fileComparison.content')}
          </button>
          <ComparisonStatus comparison={comparison} />
        </div>
        {tab === 'info' ? (
          <ComparisonInfo comparison={comparison} />
        ) : (
          <ComparisonContent comparison={comparison} rows={rows} />
        )}
        <footer>
          {comparison.status === 'different' && (
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(comparison.right.content ?? '')}
            >
              <Copy size={13} /> {x('fileComparison.copyRemote')}
            </button>
          )}
          <button type="button" onClick={onClose}>
            {x('common.close')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function ComparisonStatus({ comparison }: { comparison: FileComparison }) {
  const { x } = useI18n();
  const labels = {
    equal: x('fileComparison.equal'),
    different: x('fileComparison.different'),
    unsupported:
      comparison.reason === 'directory'
        ? x('fileComparison.directoryUnsupported')
        : x('fileComparison.binaryUnsupported'),
    'too-large':
      comparison.reason === 'too-many-lines'
        ? x('fileComparison.tooManyLines')
        : x('fileComparison.tooLarge'),
  } as const;
  return (
    <span className={`file-comparison-status ${comparison.status}`} role="status">
      {comparison.status === 'equal' ? <Check size={13} /> : <TriangleAlert size={13} />}
      {labels[comparison.status]}
    </span>
  );
}

function ComparisonInfo({ comparison }: { comparison: FileComparison }) {
  const { language, x } = useI18n();
  const values = [
    [
      x('fileComparison.location'),
      sourceLabel(comparison.left.scope, x),
      sourceLabel(comparison.right.scope, x),
    ],
    [x('fileComparison.name'), comparison.left.name, comparison.right.name],
    [
      x('fileComparison.size'),
      formatBytes(comparison.left.size),
      formatBytes(comparison.right.size),
    ],
    [
      x('fileComparison.permissions'),
      formatMode(comparison.left.mode),
      formatMode(comparison.right.mode),
    ],
    [x('fileComparison.path'), comparison.left.path, comparison.right.path],
    [x('fileComparison.owner'), comparison.left.owner ?? '—', comparison.right.owner ?? '—'],
    [x('fileComparison.group'), comparison.left.group ?? '—', comparison.right.group ?? '—'],
    [
      x('fileComparison.accessedAt'),
      formatDate(comparison.left.accessedAt, language),
      formatDate(comparison.right.accessedAt, language),
    ],
    [
      x('fileComparison.modifiedAt'),
      formatDate(comparison.left.modifiedAt, language),
      formatDate(comparison.right.modifiedAt, language),
    ],
  ];
  return (
    <div className="file-comparison-info" role="tabpanel">
      <table>
        <thead>
          <tr>
            <th>{x('fileComparison.property')}</th>
            <th>{comparison.left.name}</th>
            <th>{comparison.right.name}</th>
          </tr>
        </thead>
        <tbody>
          {values.map(([label, left, right]) => (
            <tr key={label}>
              <th>{label}</th>
              <td className={left === right ? '' : 'different'}>{left}</td>
              <td className={left === right ? '' : 'different'}>{right}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ComparisonContent({ comparison, rows }: { comparison: FileComparison; rows: DiffRow[] }) {
  const { x } = useI18n();
  if (comparison.status !== 'different')
    return (
      <div className="file-comparison-message" role="tabpanel">
        {comparison.status === 'equal' ? <Check size={28} /> : <FileDiff size={28} />}
        <strong>
          {comparison.status === 'equal'
            ? x('fileComparison.contentsEqual')
            : comparison.status === 'too-large'
              ? x('fileComparison.outOfRange')
              : x('fileComparison.notText')}
        </strong>
        <span>
          {comparison.status === 'too-large'
            ? comparison.reason === 'too-many-lines'
              ? x('fileComparison.lineLimit')
              : x('fileComparison.sizeLimit')
            : comparison.status === 'unsupported'
              ? comparison.reason === 'directory'
                ? x('fileComparison.selectFiles')
                : x('fileComparison.utf8Only')
              : x('fileComparison.infoStillAvailable')}
        </span>
      </div>
    );
  return (
    <div className="file-comparison-content" role="tabpanel">
      <div className="file-diff-heading">
        <strong>{x('fileComparison.localNamed', { name: comparison.left.name })}</strong>
        <strong>{x('fileComparison.remoteNamed', { name: comparison.right.name })}</strong>
      </div>
      <div className="file-diff-scroll">
        {rows.map((row, index) => (
          <div className={`file-diff-row ${row.kind}`} key={index}>
            <code>
              <span>{row.leftNumber ?? ''}</span>
              <b>{row.left}</b>
            </code>
            <code>
              <span>{row.rightNumber ?? ''}</span>
              <b>{row.right}</b>
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

interface DiffRow {
  left: string | undefined;
  right: string | undefined;
  leftNumber: number | undefined;
  rightNumber: number | undefined;
  kind: 'same' | 'changed';
}

function buildDiffRows(left: string, right: string): DiffRow[] {
  const leftLines = splitLines(left);
  const rightLines = splitLines(right);
  let prefix = 0;
  while (prefix < leftLines.length && prefix < rightLines.length) {
    if (leftLines[prefix] !== rightLines[prefix]) break;
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < leftLines.length - prefix && suffix < rightLines.length - prefix) {
    if (leftLines[leftLines.length - suffix - 1] !== rightLines[rightLines.length - suffix - 1])
      break;
    suffix += 1;
  }
  const rows: DiffRow[] = leftLines.slice(0, prefix).map((line, index) => ({
    left: line,
    right: line,
    leftNumber: index + 1,
    rightNumber: index + 1,
    kind: 'same',
  }));
  const changedLength = Math.max(
    leftLines.length - prefix - suffix,
    rightLines.length - prefix - suffix,
  );
  for (let index = 0; index < changedLength; index += 1) {
    const leftIndex = prefix + index;
    const rightIndex = prefix + index;
    rows.push({
      left: leftIndex < leftLines.length - suffix ? leftLines[leftIndex] : undefined,
      right: rightIndex < rightLines.length - suffix ? rightLines[rightIndex] : undefined,
      leftNumber: leftIndex < leftLines.length - suffix ? leftIndex + 1 : undefined,
      rightNumber: rightIndex < rightLines.length - suffix ? rightIndex + 1 : undefined,
      kind: 'changed',
    });
  }
  for (let index = suffix; index > 0; index -= 1) {
    const leftIndex = leftLines.length - index;
    const rightIndex = rightLines.length - index;
    rows.push({
      left: leftLines[leftIndex],
      right: rightLines[rightIndex],
      leftNumber: leftIndex + 1,
      rightNumber: rightIndex + 1,
      kind: 'same',
    });
  }
  return rows;
}

function splitLines(content: string): string[] {
  return content ? content.replace(/\r\n|\r/gu, '\n').split('\n') : [];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatMode(mode: number | undefined): string {
  return mode === undefined ? '—' : (mode & 0o7777).toString(8).padStart(4, '0');
}

function formatDate(value: string | undefined, language: string): string {
  return value ? new Date(value).toLocaleString(language) : '—';
}

function sourceLabel(scope: 'local' | 'remote', x: ReturnType<typeof useI18n>['x']): string {
  return scope === 'local' ? x('fileComparison.localGrant') : 'SSH / SFTP';
}
