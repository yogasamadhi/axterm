import { describe, expect, it } from 'vitest';
import {
  inspectCredentialScript,
  inspectRendererCopy,
  inspectSource,
  isSystemCredentialModule,
} from '../../scripts/architecture-policy.mjs';

describe('business IPC escape-hatch gate', () => {
  it('allows only narrow, literal bootstrap', () => {
    expect(
      inspectSource(
        'apps/desktop/src/preload/index.ts',
        "import { ipcRenderer } from 'electron'; ipcRenderer.invoke('desktop:bootstrap');",
      ),
    ).toEqual([]);
  });
  it.each([
    "import { ipcRenderer } from 'electron'; ipcRenderer.invoke('ssh.connect');",
    "import { ipcRenderer as ipc } from 'electron'; ipc.send('desktop:bootstrap');",
    "import { ipcRenderer } from 'electron'; const x = ipcRenderer;",
    "import { ipcRenderer } from 'electron'; const { invoke } = ipcRenderer;",
    "import { ipcRenderer } from 'electron'; ipcRenderer.invoke(channel);",
    "import { shell } from 'electron'; shell.openExternal(url);",
    'import(variable);',
    "import * as e from 'electron'; e.ipcRenderer.invoke('ssh.connect');",
    "const e = require('electron'); e.ipcRenderer.invoke('ssh.connect');",
  ])('rejects %s', (source) => {
    expect(inspectSource('apps/desktop/src/preload/index.ts', source).length).toBeGreaterThan(0);
  });
  it('rejects raw fetch in Renderer', () => {
    expect(
      inspectSource('apps/desktop/src/renderer/src/app.ts', "fetch('/api/v1/runtime');"),
    ).not.toEqual([]);
  });
  it('rejects Renderer copy that offers a system credential store', () => {
    const rendererPath = 'apps/desktop/src/renderer/src/app/settings.tsx';
    for (const source of [
      `const label = 'Use Keychain';`,
      `const label = 'Credential Manager';`,
      `const label = '是否启用系统钥匙串？';`,
      `const view = <p>选择系统凭据存储</p>;`,
    ]) {
      expect(inspectSource(rendererPath, source)).toContainEqual(
        expect.stringContaining('local vault storage is fixed'),
      );
    }
    expect(inspectSource(rendererPath, `const label = '应用本地加密存储';`)).toEqual([]);
    expect(
      inspectRendererCopy(
        'apps/desktop/src/renderer/src/locales/zh-CN.json',
        JSON.stringify({ storageQuestion: '是否启用系统钥匙串？' }),
      ),
    ).toContainEqual(expect.stringContaining('local vault storage is fixed'));
    expect(
      inspectRendererCopy(
        'apps/desktop/src/renderer/src/locales/zh-CN.json',
        JSON.stringify({ storage: '应用本地加密存储' }),
      ),
    ).toEqual([]);
  });
  it.each([
    "import { safeStorage } from 'electron'; safeStorage.encryptString('secret');",
    "import { safeStorage as store } from 'electron'; store.encryptString('secret');",
    "import keytar from 'keytar'; keytar.setPassword('app', 'user', 'secret');",
    "const ring = await import('@napi-rs/keyring');",
    "const ring = require('node-keychain');",
    "import { execFile } from 'node:child_process'; execFile('security', ['find-generic-password']);",
    "import { execFile } from 'node:child_process'; execFile('security', ['find-internet-password']);",
    "import { execSync } from 'node:child_process'; execSync('security find-certificate -a');",
    "import { execSync } from 'node:child_process'; execSync('secret-tool lookup service axterm');",
    "import { execSync } from 'node:child_process'; execSync('cmdkey /list');",
  ])('rejects system credential-store access: %s', (source) => {
    expect(inspectSource('apps/desktop/src/main/example.ts', source)).not.toEqual([]);
  });
  it('rejects credential-store access in scripts and dependency manifests', () => {
    expect(
      inspectCredentialScript(
        'scripts/example.mjs',
        "import keytar from 'keytar'; execFile('secret-tool', ['store']);",
      ),
    ).not.toEqual([]);
    expect(isSystemCredentialModule('@napi-rs/keyring')).toBe(true);
    expect(isSystemCredentialModule('keytar')).toBe(true);
    expect(isSystemCredentialModule('node:crypto')).toBe(false);
  });
  it('allows a built utility entry path but rejects importing its implementation', () => {
    const path = 'apps/desktop/src/main/index.ts';
    expect(
      inspectSource(
        path,
        "import runtimePath from '../../../../packages/runtime/src/entry/desktop.ts?modulePath';",
      ),
    ).toEqual([]);
    expect(
      inspectSource(path, "import '../../../../packages/runtime/src/entry/desktop';"),
    ).not.toEqual([]);
    expect(
      inspectSource(path, "import('../../../../packages/runtime/src/entry/desktop.ts');"),
    ).not.toEqual([]);
  });
});
