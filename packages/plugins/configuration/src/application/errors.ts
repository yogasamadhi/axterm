import type { CredentialCommandFailure } from '@axterm/plugin-api/saved-credentials';
export class SettingsError extends Error {
  constructor(
    readonly code: 'PRECONDITION_REQUIRED' | 'PRECONDITION_FAILED',
    message: string,
    readonly status: 412 | 428,
  ) {
    super(message);
  }
}
export function versionFromEtag(value: string | undefined): number {
  if (!value)
    throw new SettingsError('PRECONDITION_REQUIRED', 'A settings version is required', 428);
  const match = /^"v(\d+)"$/.exec(value);
  const version = Number(match?.[1]);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new SettingsError('PRECONDITION_FAILED', 'The settings version is invalid', 412);
  return version;
}

export class CredentialWorkflowError extends Error {
  constructor(readonly reason: CredentialCommandFailure) {
    super('CREDENTIAL_COMMAND_' + reason.toUpperCase().replaceAll('-', '_'));
    this.name = 'CredentialWorkflowError';
  }
}
