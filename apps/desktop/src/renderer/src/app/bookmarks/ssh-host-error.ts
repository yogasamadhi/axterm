import { RuntimeClientError } from '@workspace/client';
import type { AxtermMessageKey } from '../../i18n/core';
import type { useI18n } from '../../i18n/context';

export type SshHostOperationStage = 'credential' | 'save' | 'connect' | 'terminal';
type Translator = ReturnType<typeof useI18n>['x'];

const reasons: Record<string, AxtermMessageKey> = {
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

const stages: Record<SshHostOperationStage, AxtermMessageKey> = {
  credential: 'hosts.errorStageCredential',
  save: 'hosts.errorStageSave',
  connect: 'hosts.errorStageConnect',
  terminal: 'hosts.errorStageTerminal',
};

// Only known contract fields are shown. Never render server exception text,
// validation values, arbitrary field names or credential-bearing payloads.
const fields: Record<string, AxtermMessageKey> = {
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

export function sshHostErrorMessage(
  error: unknown,
  stage: SshHostOperationStage,
  x: Translator,
): string {
  const known = error instanceof RuntimeClientError ? error : undefined;
  const reasonKey = known && Object.hasOwn(reasons, known.code) ? reasons[known.code] : undefined;
  const reason =
    known?.code === 'CAPABILITY_UNAVAILABLE' && stage === 'credential'
      ? x('hosts.errorVault')
      : x(reasonKey ?? 'hosts.errorUnknown');
  const invalidFields =
    known?.code === 'VALIDATION_ERROR'
      ? [
          ...new Set(
            Object.keys(known.fieldErrors ?? {}).flatMap((path) => {
              const field = path.split('.').slice(0, 2).join('.');
              const label = Object.hasOwn(fields, field) ? fields[field] : undefined;
              return label ? [x(label)] : [];
            }),
          ),
        ].slice(0, 8)
      : [];
  const fieldHint = invalidFields.length
    ? ` ${x('hosts.errorFields', { fields: invalidFields.join(', ') })}`
    : '';
  const code = known && /^[A-Z][A-Z0-9_]{0,63}$/u.test(known.code) ? known.code : '';
  const trace = known?.traceId && /^[0-9a-f-]{36}$/iu.test(known.traceId) ? known.traceId : '';
  const diagnostics = [code, trace].filter(Boolean).join(' / ');
  return `${x(stages[stage], { reason })}${fieldHint}${diagnostics ? ` (${diagnostics})` : ''}`;
}
