import { describe, expect, it } from 'vitest';
import { evaluatePluginCompatibility } from '@axterm/infra-app-boot';

const identity = { name: '@fixture/plugin', version: '1.2.3' };
describe('application plugin compatibility before code loading', () => {
  it('lets engines.axterm alone decide when explicitly declared', () => {
    expect(
      evaluatePluginCompatibility(
        {
          ...identity,
          engines: { axterm: '^0.10.0' },
          peerDependencies: { '@deepseek-ai/cordis': '>=99' },
        },
        {},
        '0.10.0',
        {},
      ),
    ).toBeUndefined();
  });
  it('checks each SDK/framework against its own installed version', () => {
    expect(
      evaluatePluginCompatibility(
        {
          ...identity,
          peerDependencies: {
            '@deepseek-ai/cordis': '^4.0.6-alpha.2',
            '@axterm/plugin-api': '^1.0.0',
          },
        },
        {},
        '0.10.0',
        { '@deepseek-ai/cordis': '4.0.6-alpha.2', '@axterm/plugin-api': '1.2.0' },
      ),
    ).toBeUndefined();
    expect(
      evaluatePluginCompatibility(
        { ...identity, peerDependencies: { '@axterm/ui': '^1.0.0' } },
        {},
        '0.10.0',
        { '@axterm/ui': '2.0.0' },
      ),
    ).toMatchObject({ requirements: { '@axterm/ui': '^1.0.0' }, exempted: false });
  });
  it('refuses a declared public peer missing from the runtime', () => {
    expect(
      evaluatePluginCompatibility(
        { ...identity, peerDependencies: { '@deepseek-ai/cordis': '*' } },
        {},
        '0.10.0',
        {},
      ),
    ).toMatchObject({ requirements: { '@deepseek-ai/cordis': '*' }, exempted: false });
  });
  it('never carries an exact exemption across plugin or runtime upgrades', () => {
    const plugin = { ...identity, engines: { axterm: '>=2.0.0' } };
    const exemptions = { '@fixture/plugin@1.2.3': ['0.10.0'] };
    expect(evaluatePluginCompatibility(plugin, exemptions, '0.10.0', {})).toMatchObject({
      exempted: true,
    });
    expect(
      evaluatePluginCompatibility({ ...plugin, version: '1.2.4' }, exemptions, '0.10.0', {}),
    ).toMatchObject({ exempted: false });
    expect(evaluatePluginCompatibility(plugin, exemptions, '0.10.1', {})).toMatchObject({
      exempted: false,
    });
  });
  it('rejects malformed requirement metadata', () => {
    expect(() =>
      evaluatePluginCompatibility({ ...identity, engines: { axterm: 42 } }, {}, '0.10.0', {}),
    ).toThrow('must be a string');
    expect(() =>
      evaluatePluginCompatibility({ ...identity, peerDependencies: [] }, {}, '0.10.0', {}),
    ).toThrow('must be an object');
  });
});

it('reads the installed public SDK version independently of the application version', async () => {
  const { readFile } = await import('node:fs/promises');
  const sdk = JSON.parse(await readFile('packages/api/plugin-api/package.json', 'utf8')) as {
    version: string;
  };
  expect(
    evaluatePluginCompatibility(
      {
        name: 'external-host',
        version: '1.0.0',
        peerDependencies: { '@axterm/plugin-api': `=${sdk.version}` },
      },
      {},
      '99.0.0',
    ),
  ).toBeUndefined();
  expect(
    evaluatePluginCompatibility(
      {
        name: 'external-host',
        version: '1.0.0',
        peerDependencies: { '@axterm/plugin-api': '=99.0.0' },
      },
      {},
      '99.0.0',
    ),
  ).toBeDefined();
});
