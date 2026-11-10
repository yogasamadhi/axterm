import { remoteErrorOf } from '@axterm/plugin-api';
import {
  sshDiagnosticCodeSchema,
  sshDiagnosticFieldSchema,
  sshOperationDiagnosticSchema,
  type SshOperationDiagnostic,
} from '@axterm/plugin-api/catalog';
import type {} from '@axterm/plugin-api/connections';
import type { TranslateNS } from '@axterm/ui';
import type {} from '../locales.ts';
export type SshHostOperationStage = 'credential' | 'save' | 'connect' | 'terminal';
type Translator = TranslateNS<'catalog'>;
type MessageKey = Parameters<Translator>[0];
export interface SshOperationFailure {
  readonly stage: SshHostOperationStage;
  readonly diagnostic?: SshOperationDiagnostic;
  /** Explicit refusal is a known command result; an unknown carrier failure is not. */
  readonly definiteRejection?: true;
}
const reasons: Record<string, MessageKey> = {
  CONNECTION_WAIT_TIMEOUT: 'app.sshWaitTimeout',
  VALIDATION_ERROR: 'hosts.errorValidation',
  PRECONDITION_FAILED: 'hosts.errorConflict',
  PRECONDITION_REQUIRED: 'hosts.errorConflict',
  CONFLICT: 'hosts.errorConflict',
  HOST_NAME_CONFLICT: 'hosts.errorNameConflict',
  NOT_FOUND: 'hosts.errorNotFound',
  RUNTIME_UNAVAILABLE: 'hosts.errorRuntime',
  STALE_GENERATION: 'hosts.errorRuntimeChanged',
  UNAUTHORIZED: 'hosts.errorRuntimeChanged',
  FORBIDDEN: 'hosts.errorForbidden',
  CAPABILITY_UNAVAILABLE: 'hosts.errorCapability',
  INTERNAL_ERROR: 'hosts.errorInternal',
  AUTHENTICATION_FAILED: 'hosts.errorAuthentication',
  SSH_AUTH_FAILED: 'hosts.errorAuthentication',
  SSH_CONNECTION_REFUSED: 'hosts.errorRefused',
  SSH_CONNECTION_TIMEOUT: 'hosts.errorTimeout',
  SSH_DNS_FAILED: 'hosts.errorDns',
  SSH_NETWORK_UNREACHABLE: 'hosts.errorUnreachable',
  SSH_CONNECTION_LOST: 'hosts.errorLost',
  SSH_NEGOTIATION_FAILED: 'hosts.errorNegotiation',
  SSH_KEY_INVALID: 'hosts.errorKey',
  SSH_CONNECTION_FAILED: 'hosts.errorSshUnknown',
  HOST_KEY_REJECTED: 'hosts.errorHostKey',
  HOST_KEY_CHANGED: 'hosts.errorHostKey',
  CONNECTION_CLOSED: 'hosts.errorClosed',
  PROXY_AUTH_REQUIRED: 'hosts.errorProxyAuth',
  PROXY_AUTH_INVALID: 'hosts.errorProxyAuth',
  PROXY_TIMEOUT: 'hosts.errorProxyTimeout',
  PROXY_CONNECT_FAILED: 'hosts.errorProxyConnect',
  PROXY_CONNECT_REJECTED: 'hosts.errorProxyConnect',
};

const stages: Record<SshHostOperationStage, MessageKey> = {
  credential: 'hosts.errorStageCredential',
  save: 'hosts.errorStageSave',
  connect: 'hosts.errorStageConnect',
  terminal: 'hosts.errorStageTerminal',
};

// Only known contract fields are shown. Never render server exception text,
// validation values, arbitrary field names or credential-bearing payloads.
const fields: Record<string, MessageKey> = {
  'host.name': 'hosts.displayName',
  'host.hostname': 'hosts.address',
  'host.username': 'hosts.username',
  'host.port': 'hosts.port',
  'host.authType': 'hosts.authMethod',
  'host.proxy': 'proxy.title',
  'host.sshAgent': 'hosts.useAgent',
  'host.connectionOptions': 'hosts.settings',
  'host.startup': 'hosts.settings',
  'host.jumpHostIds': 'hosts.jumpHosts',
  'bookmark.groupId': 'hosts.group',
  'bookmark.title': 'hosts.bookmarkTitle',
  'bookmark.color': 'hosts.titleColor',
  'bookmark.profileId': 'hosts.terminalProfile',
  'bookmark.connectionProfileId': 'hosts.connectionProfile',
  'bookmark.quickCommands': 'hosts.bookmarkQuickCommands',
  'bookmark.triggers': 'hosts.bookmarkTriggers',
};

/** Accept product codes and field labels only, never exception text or validation values. */
export function readSshDiagnostic(value: unknown): SshOperationDiagnostic | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>,
    code = sshDiagnosticCodeSchema.safeParse(input.code);
  if (!code.success) return;
  const fields = Array.isArray(input.fields)
    ? [
        ...new Set(
          input.fields.slice(0, 32).flatMap((path) => {
            if (typeof path !== 'string' || path.length > 256) return [];
            const field = sshDiagnosticFieldSchema.safeParse(path.split('.').slice(0, 2).join('.'));
            return field.success ? [field.data] : [];
          }),
        ),
      ].slice(0, 8)
    : [];
  const operationId =
    typeof input.operationId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      input.operationId,
    )
      ? input.operationId
      : undefined;
  return sshOperationDiagnosticSchema.parse({
    code: code.data,
    ...(fields.length ? { fields } : {}),
    ...(operationId ? { operationId } : {}),
  });
}
export function sshHostFailure(
  error: unknown,
  stage: SshHostOperationStage,
  operationId?: string,
): SshOperationFailure {
  const marked = remoteErrorOf(error);
  let diagnostic: SshOperationDiagnostic | undefined;
  if (
    (marked?.code === 'catalog/failure' || marked?.code === 'connections/failure') &&
    marked.details
  ) {
    diagnostic = readSshDiagnostic(marked.details.diagnostic);
    const code = (
      {
        'invalid-input': 'VALIDATION_ERROR',
        'not-found': 'NOT_FOUND',
        conflict: 'CONFLICT',
        'precondition-required': 'PRECONDITION_REQUIRED',
        'precondition-failed': 'PRECONDITION_FAILED',
        stale: 'STALE_GENERATION',
        closed: 'CONNECTION_CLOSED',
      } as Record<string, string>
    )[marked.details.reason];
    if (!diagnostic && code) diagnostic = readSshDiagnostic({ code });
  }
  if (diagnostic && !diagnostic.operationId && operationId)
    diagnostic = readSshDiagnostic({ ...diagnostic, operationId });
  const definiteRejection =
    !diagnostic && marked?.code === 'catalog/failure' && marked.details.reason === 'capacity';
  return Object.freeze({
    stage,
    ...(diagnostic ? { diagnostic } : {}),
    ...(definiteRejection ? { definiteRejection: true as const } : {}),
  });
}
export function formatSshHostFailure(failure: SshOperationFailure, x: Translator): string {
  const known = readSshDiagnostic(failure.diagnostic);
  const reasonKey = known && Object.hasOwn(reasons, known.code) ? reasons[known.code] : undefined;
  const reason =
    known?.code === 'CAPABILITY_UNAVAILABLE' && failure.stage === 'credential'
      ? x('hosts.errorVault')
      : x(
          reasonKey ??
            (failure.definiteRejection ? 'common.operationFailed' : 'hosts.errorUnknown'),
        );
  const labels =
    known?.code === 'VALIDATION_ERROR'
      ? [
          ...new Set(
            (known.fields ?? []).flatMap((field) =>
              Object.hasOwn(fields, field) ? [x(fields[field]!)] : [],
            ),
          ),
        ]
      : [];
  const hint = labels.length ? ' ' + x('hosts.errorFields', { fields: labels.join(', ') }) : '';
  const diagnostic = known ? [known.code, known.operationId].filter(Boolean).join(' / ') : '';
  return x(stages[failure.stage], { reason }) + hint + (diagnostic ? ' (' + diagnostic + ')' : '');
}
export function sshHostErrorMessage(
  error: unknown,
  stage: SshHostOperationStage,
  x: Translator,
): string {
  return formatSshHostFailure(sshHostFailure(error, stage), x);
}
