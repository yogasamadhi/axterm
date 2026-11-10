import {
  createBatchOperationSchema,
  type CreateBatchOperationInput,
} from '@axterm/plugin-api/automation';
export type BatchFileMessageKey =
  'batchCli.fileTooLarge' | 'batchCli.invalidJson' | 'batchCli.invalidFormat';
/** Only allowlisted local validation messages cross into the UI alert. */
export class BatchFileError extends Error {
  constructor(
    readonly key: BatchFileMessageKey,
    message: string,
  ) {
    super(message);
  }
}
/** Retained Axterm format; no legacy import, execution or grant ownership belongs here. */
export function parseCommandLineBatchOperation(
  content: string,
  translate: (key: BatchFileMessageKey) => string = (key) => key,
): CreateBatchOperationInput {
  const fail = (key: BatchFileMessageKey): never => {
    throw new BatchFileError(key, translate(key));
  };
  if (new TextEncoder().encode(content).byteLength > 2 * 1024 * 1024) fail('batchCli.fileTooLarge');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^\uFEFF/u, ''));
  } catch {
    fail('batchCli.invalidJson');
  }
  const result = createBatchOperationSchema.safeParse(parsed);
  if (!result.success) fail('batchCli.invalidFormat');
  return result.data!;
}
