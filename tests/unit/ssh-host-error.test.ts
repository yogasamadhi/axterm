import { describe, expect, it } from 'vitest';
import { RuntimeClientError } from '../../packages/client/src/api-client';
import { sshHostErrorMessage } from '../../apps/desktop/src/renderer/src/app/bookmarks/ssh-host-error';
import { translateAxterm } from '../../apps/desktop/src/renderer/src/i18n/core';

const x = (
  key: Parameters<typeof translateAxterm>[1],
  variables?: Parameters<typeof translateAxterm>[2],
) => translateAxterm('zh-CN', key, variables);
const traceId = '12d9fa22-72d0-4a41-88c4-1186a217b612';

describe('SSH host operation errors', () => {
  it('explains the actual duplicate-name conflict and how to resolve it', () => {
    const text = sshHostErrorMessage(
      new RuntimeClientError('HOST_NAME_CONFLICT', 'unsafe', 409),
      'save',
      x,
    );
    expect(text).toContain('保存 SSH 主机失败');
    expect(text).toContain('同名 SSH 主机');
    expect(text).toContain('修改显示名称');
    expect(text).not.toContain('检查连接');
  });
  it('distinguishes local Vault saving from SSH connection failure', () => {
    const vault = sshHostErrorMessage(
      new RuntimeClientError('CAPABILITY_UNAVAILABLE', 'unsafe', 503, traceId),
      'credential',
      x,
    );
    expect(vault).toContain('保存凭据失败');
    expect(vault).toContain('本地 Vault');
    expect(vault).toContain(traceId);
    const connection = sshHostErrorMessage(
      new RuntimeClientError('SSH_CONNECTION_REFUSED', 'unsafe'),
      'connect',
      x,
    );
    expect(connection).toContain('主机已保存，但连接失败');
    expect(connection).toContain('端口');
    expect(connection).toContain('SSH_CONNECTION_REFUSED');
  });

  it('names invalid fields while excluding untrusted values and dynamic field names', () => {
    const text = sshHostErrorMessage(
      new RuntimeClientError('VALIDATION_ERROR', 'password=secret-value', 400, traceId, {
        'host.port': ['secret-value'],
        'host.startup.environment.secret-value': ['secret-value'],
        'secret-value': ['secret-value'],
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
    new RuntimeClientError('secret-value', 'private key: secret-value', 500, 'secret-value'),
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
        new RuntimeClientError('AUTHENTICATION_FAILED', 'unsafe'),
        'connect',
        (key, variables) => translateAxterm(language, key, variables),
      );
      expect(text).toContain(translateAxterm(language, 'hosts.errorAuthentication'));
      expect(text).not.toMatch(/hosts\.|\{reason\}/u);
    },
  );
});
