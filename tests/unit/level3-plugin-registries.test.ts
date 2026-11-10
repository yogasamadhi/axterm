import { expect, it, vi } from 'vitest';
import { PackageInspector } from '../../packages/infra/plugin-manager/src/metadata.ts';
import { registryPlan } from '../../packages/infra/plugin-manager/src/registry.ts';
import type {
  PackageRunner,
  PackageRunResult,
} from '../../packages/infra/plugin-manager/src/package-runner.ts';
const npm = 'https://registry.npmjs.org/',
  one = 'https://public-one.example.test/',
  two = 'https://public-two.example.test/',
  privateRegistry = 'https://private.example.test/';
function result(value: unknown): PackageRunResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: '', lossy: false };
}
const manifest = { name: '@fixture/plugin', version: '1.0.0' };
it('queries configured public sources in order and keeps unknown/private primaries alone', () => {
  expect(registryPlan(npm, [one, two, one])).toEqual([npm, one, two]);
  expect(registryPlan(privateRegistry, [npm, one])).toEqual([privateRegistry]);
  expect(() => registryPlan(npm, ['https://user:secret@bad.example.test/'])).toThrow();
  expect(() => registryPlan(npm, Array(9).fill(one))).toThrow();
});
it('pins the exact answering source and scope, retries eligible public failures and chooses the highest matching range version', async () => {
  const run = vi
    .fn<PackageRunner['run']>()
    .mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: '',
      lossy: false,
      failure: 'network',
    })
    .mockResolvedValueOnce(
      result([
        { ...manifest, version: '1.2.0' },
        { ...manifest, version: '1.0.0' },
        { ...manifest, version: '1.1.0' },
      ]),
    );
  const inspector = new PackageInspector({ run } as unknown as PackageRunner, npm, [one, two]);
  expect(await inspector.inspect('@fixture/plugin@^1.0.0')).toMatchObject({
    spec: '@fixture/plugin@1.2.0',
    registry: one,
  });
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[0]?.[0]).toContain('--config.@fixture:registry=' + npm);
  expect(run.mock.calls[1]?.[0]).toContain('--config.@fixture:registry=' + one);
});
it.each(['permission', 'capacity', 'invalid-input'] as const)(
  'does not retry %s or execute a private failure against a public source',
  async (reason) => {
    const run = vi
      .fn<PackageRunner['run']>()
      .mockResolvedValue({ exitCode: 1, stdout: '', stderr: '', lossy: false, failure: reason });
    await expect(
      new PackageInspector({ run } as unknown as PackageRunner, npm, [one]).inspect(
        '@fixture/plugin',
      ),
    ).rejects.toMatchObject({ reason });
    expect(run).toHaveBeenCalledTimes(1);
    run.mockClear();
    run.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: '',
      lossy: false,
      failure: 'network',
    });
    await expect(
      new PackageInspector({ run } as unknown as PackageRunner, privateRegistry, [npm]).inspect(
        '@fixture/plugin',
      ),
    ).rejects.toMatchObject({ reason: 'network' });
    expect(run).toHaveBeenCalledTimes(1);
  },
);
it.each([
  { ...manifest, name: '@other/unapproved' },
  { ...manifest, version: '2.0.0' },
])(
  'rejects a registry answer outside the requested identity without fallback',
  async (metadata) => {
    const run = vi.fn<PackageRunner['run']>().mockResolvedValue(result(metadata));
    await expect(
      new PackageInspector({ run } as unknown as PackageRunner, npm, [one]).inspect(
        '@fixture/plugin@1.0.0',
      ),
    ).rejects.toMatchObject({ reason: 'invalid-input' });
    expect(run).toHaveBeenCalledTimes(1);
  },
);
