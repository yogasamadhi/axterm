import { createBatchOperationSchema, type CreateBatchOperationRequest } from '@workspace/contracts';
import type { AxtermMessageKey, Variables } from '../i18n/core';
import { LocalShellError } from './shell-error';

const MAX_BATCH_FILE_BYTES = 2 * 1024 * 1024;
type Translate = (key: AxtermMessageKey, variables?: Variables) => string;

export function parseCommandLineBatchOperation(
  content: string,
  x: Translate,
): CreateBatchOperationRequest {
  if (new TextEncoder().encode(content).byteLength > MAX_BATCH_FILE_BYTES)
    throw new LocalShellError(x('batchCli.fileTooLarge'));

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^\uFEFF/u, ''));
  } catch {
    throw new LocalShellError(x('batchCli.invalidJson'));
  }

  const operation = createBatchOperationSchema.safeParse(parsed);
  if (!operation.success) throw new LocalShellError(x('batchCli.invalidFormat'));
  return operation.data;
}
