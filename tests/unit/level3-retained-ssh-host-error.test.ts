import { describe, expect, it } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import {
  sshHostErrorMessage,
  formatSshHostFailure,
} from '../../packages/plugins/catalog/src/client/ui/editor/ssh-host-error.ts';
import { ownedTranslations } from '../fixtures/level3-owner-translations.ts';
import { dictionaries } from '../../packages/plugins/catalog/src/client/ui/locales.ts';
const translateAxterm = ownedTranslations('catalog', dictionaries);

const x = (
  key: Parameters<typeof translateAxterm>[1],
  variables?: Parameters<typeof translateAxterm>[2],
) => translateAxterm('zh-CN', key, variables);
const traceId = '12d9fa22-72d0-4a41-88c4-1186a217b612';

describe('SSH host operation errors', () => {
  it('explains the actual duplicate-name conflict and how to resolve it', () => {
    const text = sshHostErrorMessage(
      new RemoteError('catalog/failure', 'unsafe', {
        reason: 'conflict',
        diagnostic: { code: 'HOST_NAME_CONFLICT' },
      }),
      'save',
      x,
    );
    expect(text).toContain('保存 SSH 主机失败');
    expect(text).toContain('同名 SSH 主机');
    expect(text).toContain('修改显示名称');
    expect(text).not.toContain('检查连接');
  });
  it('distinguishes local Vault saving from SSH connection failure', () => {
    const vault = formatSshHostFailure(
      { stage: 'credential', diagnostic: { code: 'CAPABILITY_UNAVAILABLE', operationId: traceId } },
      x,
    );
    expect(vault).toContain('保存凭据失败');
    expect(vault).toContain('本地 Vault');
    expect(vault).toContain(traceId);
    const connection = sshHostErrorMessage(
      new RemoteError('connections/failure', 'unsafe', {
        reason: 'unavailable',
        diagnostic: { code: 'SSH_CONNECTION_REFUSED' },
      }),
      'connect',
      x,
    );
    expect(connection).toContain('主机已保存，但连接失败');
    expect(connection).toContain('端口');
    expect(connection).toContain('SSH_CONNECTION_REFUSED');
  });

  it('names invalid fields while excluding untrusted values and dynamic field names', () => {
    const text = sshHostErrorMessage(
      new RemoteError('catalog/failure', 'password=secret-value', {
        reason: 'invalid-input',
        diagnostic: {
          code: 'VALIDATION_ERROR',
          operationId: traceId,
          fields: ['host.port', 'host.startup.environment.secret-value', 'secret-value'],
          values: ['secret-value'],
        } as never,
      }),
      'save',
      x,
    );
    expect(text).toContain('保存 SSH 主机失败');
    expect(text).toContain('端口');
    expect(text).not.toContain('secret-value');
  });

  it.each([
    new Error('password=secret-value'),
    new RemoteError('catalog/failure', 'private key: secret-value', {
      reason: 'unavailable',
      diagnostic: { code: 'secret-value', operationId: 'secret-value' } as never,
    }),
  ])('keeps unknown errors safe without inventing a network cause', (error) => {
    const text = sshHostErrorMessage(error, 'save', x);
    expect(text).toContain('未取得具体错误原因');
    expect(text).not.toContain('secret-value');
    expect(text).not.toContain('检查连接');
  });

  it.each(['en', 'zh-CN', 'ja', 'zh-TW'] as const)(
    'localizes authentication failures in %s',
    (language) => {
      const text = sshHostErrorMessage(
        new RemoteError('connections/failure', 'unsafe', {
          reason: 'unavailable',
          diagnostic: { code: 'AUTHENTICATION_FAILED' },
        }),
        'connect',
        (key, variables) => translateAxterm(language, key, variables),
      );
      expect(text).toContain(translateAxterm(language, 'hosts.errorAuthentication'));
      expect(text).not.toMatch(/hosts\.|\{reason\}/u);
    },
  );
});

it('keeps a definite capacity refusal generic without treating an unknown carrier failure as a save result', () => {
  const refusal = sshHostErrorMessage(
    new RemoteError('catalog/failure', 'PRIVATE_REFUSAL_CANARY', { reason: 'capacity' }),
    'save',
    x,
  );
  expect(refusal).toBe('保存 SSH 主机失败：操作失败');
  expect(refusal).not.toContain('PRIVATE_REFUSAL_CANARY');
  const unknown = sshHostErrorMessage(
    new RemoteError('catalog/failure', 'PRIVATE_UNKNOWN_CANARY', { reason: 'unavailable' }),
    'save',
    x,
  );
  expect(unknown).toContain('未取得具体错误原因');
  expect(unknown).not.toContain('PRIVATE_UNKNOWN_CANARY');
});
