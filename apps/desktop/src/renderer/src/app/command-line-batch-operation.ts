import {
  createBatchOperationSchema,
  type BookmarkTree,
  type CreateBatchOperationRequest,
  type Host,
} from '@workspace/contracts';
import type { AxtermMessageKey, Variables } from '../i18n/core';

const MAX_BATCH_FILE_BYTES = 2 * 1024 * 1024;
type Translate = (key: AxtermMessageKey, variables?: Variables) => string;

export function parseCommandLineBatchOperation(
  content: string,
  fileName: string,
  tree: BookmarkTree,
  hosts: readonly Host[],
  x: Translate,
  createId: () => string = () => crypto.randomUUID(),
): CreateBatchOperationRequest {
  if (new TextEncoder().encode(content).byteLength > MAX_BATCH_FILE_BYTES)
    throw new Error(x('batchCli.fileTooLarge'));

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(x('batchCli.invalidJson'));
  }

  const native = createBatchOperationSchema.safeParse(parsed);
  if (native.success) return native.data;
  if (!Array.isArray(parsed)) throw new Error(x('batchCli.invalidFormat'));
  if (!parsed.length || parsed.length > 64) throw new Error(x('batchCli.workflowStepLimit'));

  const workflow = parsed.map((value) => recordOf(value, x));
  const connectIndexes = workflow.flatMap((step, index) =>
    step.action === 'connect' ? [index] : [],
  );
  if (connectIndexes.length !== 1 || connectIndexes[0] !== 0)
    throw new Error(x('batchCli.connectFirst'));
  if (workflow.some((step) => ['sftp_upload', 'sftp_download'].includes(String(step.action))))
    throw new Error(x('batchCli.fileGrantRequired'));
  if (workflow.some((step) => !['connect', 'command'].includes(String(step.action))))
    throw new Error(x('batchCli.unsupportedAction'));

  const connection = { ...workflow[0], ...recordOf(workflow[0]!.params, x, true) };
  const hostname = requiredString(connection.host, 'connect.host', x);
  const port = optionalInteger(connection.port, 22, 1, 65_535, 'connect.port', x);
  const username = optionalString(connection.username);
  const host = hosts.find(
    (candidate) =>
      candidate.hostname === hostname &&
      candidate.port === port &&
      (!username || candidate.username === username),
  );
  if (!host) throw new Error(x('batchCli.hostNotSaved'));
  const bookmark = tree.bookmarks
    .filter((candidate) => candidate.protocol === 'ssh' && candidate.hostId === host.id)
    .sort((left, right) => left.position - right.position)[0];
  if (!bookmark) throw new Error(x('batchCli.bookmarkMissing'));

  const commands = workflow.slice(1);
  if (!commands.length || commands.length > 32) throw new Error(x('batchCli.commandStepLimit'));
  const steps = commands.map((step, index) => {
    const next = commands[index + 1];
    return {
      id: createId(),
      name: optionalString(step.name) ?? x('batchCli.commandName', { number: index + 1 }),
      command: requiredString(step.command, `command[${index}].command`, x),
      delayMs: Math.min(
        65_535,
        optionalInteger(step.afterDelay, 0, 0, 65_535, 'afterDelay', x) +
          optionalInteger(next?.prevDelay, 0, 0, 65_535, 'prevDelay', x),
      ),
      continueOnError: false,
    };
  });

  return createBatchOperationSchema.parse({
    name:
      optionalString(connection.name) ??
      (fileName.replace(/\.json$/i, '') || x('batchCli.defaultName')),
    bookmarkIds: [bookmark.id],
    steps,
    concurrency: 1,
    connectionTimeoutMs: 30_000,
  });
}

function recordOf(value: unknown, x: Translate, optional = false): Record<string, unknown> {
  if (value === undefined && optional) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(x('batchCli.stepMustBeObject'));
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, x: Translate): string {
  const result = optionalString(value);
  if (!result) throw new Error(x('batchCli.missingField', { field }));
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
  x: Translate,
): number {
  if (value === undefined) return fallback;
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum)
    throw new Error(x('batchCli.invalidField', { field }));
  return result;
}
