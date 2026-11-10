import { expect, it } from 'vitest';
import { inspectSource } from '../../scripts/architecture-policy.mjs';

it('admits only the five selected loading owners and their actual computed shape', () => {
  for (const [path, source] of [
    ['packages/infra/lazy-require/src/index.ts', 'require(specifier);'],
    ['packages/infra/hmr/src/package-manifest.ts', 'require(id);'],
    ['packages/infra/app-boot/src/profile-resolution/resolver.ts', 'require(id);'],
    ['packages/infra/typert-loader/src/index.ts', 'import(url.href);'],
    [
      'packages/plugins/remote-desktop/src/client/index.ts',
      'import(new URL(path, document.baseURI).href);',
    ],
  ]) {
    expect(inspectSource(path!, source!)).toEqual([]);
    expect(
      inspectSource('packages/plugins/fixture/src/client/index.ts', source!).join(' '),
    ).toContain('Computed imports cannot bypass architecture analysis');
    expect(inspectSource(path!, 'import(arbitrary);').join(' ')).toContain(
      'Computed imports cannot bypass architecture analysis',
    );
  }
});

it('requires exact authentication/HMR transport and rejects business fetch, globals and evaluator escapes', () => {
  expect(inspectSource('apps/web/src/auth.ts', "fetch('./connect', { method: 'POST' });")).toEqual(
    [],
  );
  expect(
    inspectSource('packages/infra/client-hmr/src/client/index.ts', 'fetch(EVENTS_ROUTE, {});'),
  ).toEqual([]);
  expect(
    inspectSource('packages/plugins/files/src/client/imports.ts', 'globalThis.fetch(input, init);'),
  ).toEqual([]);
  for (const [path, source] of [
    ['apps/web/src/auth.ts', "fetch('./connect', { method: 'GET' });"],
    ['apps/web/src/auth.ts', "fetch('/api/v1/terminals', { method: 'POST' });"],
    ['packages/infra/client-hmr/src/client/index.ts', "fetch('/api/v1/terminals');"],
    ['packages/plugins/fixture/src/client/index.ts', "fetch('./connect', { method: 'POST' });"],
    ['packages/plugins/fixture/src/client/index.ts', 'globalThis.fetch(input, init);'],
    ['apps/web/src/boot-page.ts', "window.eval('code');"],
    ['apps/web/src/boot-page.ts', "globalThis.require('electron');"],
  ])
    expect(inspectSource(path!, source!).join(' ')).toContain('Client transport');
});

it('keeps native IPC and system-credential rejection on actual Client and Host paths', () => {
  for (const [path, source] of [
    [
      'packages/plugins/fixture/src/client/index.ts',
      "import { ipcRenderer } from 'electron'; ipcRenderer.invoke('ssh.connect');",
    ],
    ['apps/desktop-host/src/index.ts', "import keytar from 'keytar';"],
    ['packages/plugins/fixture/src/client/view.tsx', 'const choice=<label>Use Keychain</label>;'],
  ])
    expect(inspectSource(path!, source!).length).toBeGreaterThan(0);
});
