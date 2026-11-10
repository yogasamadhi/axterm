import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EncryptedVault } from '@axterm/infra-credential-vault';
import { DesktopHostProcess } from '../../apps/desktop/src/shell/host-process.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function fixture(
  mode: 'ready' | 'silent' | 'wrong-generation' | 'malformed' | 'ignore-shutdown',
  fatal = vi.fn(() => {}),
) {
  const home = await mkdtemp(join(tmpdir(), 'axterm-host-supervision-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const vault = new EncryptedVault(join(home, 'vault'));
  await vault.open();
  cleanups.push(() => vault.close());
  const entry = join(home, 'host.mjs');
  await writeFile(
    entry,
    `process.on('message',m=>{if(m.type==='initialize'){if(${JSON.stringify(mode)}==='silent')return;process.send({type:'ssh.connect',password:'MUST_BE_IGNORED'});const r={kind:'axterm-desktop-control',version:1,type:'ready',generation:m.generation,origin:'http://127.0.0.1:49152',injections:[]};if(${JSON.stringify(mode)}==='wrong-generation')r.generation='11111111-1111-4111-8111-111111111111';if(${JSON.stringify(mode)}==='malformed')r.password='PRIVATE_HOST_CONTROL';process.send(r);}else if(m.type==='shutdown'&&${JSON.stringify(mode)}!=='ignore-shutdown')process.exit(0);});`,
  );
  const owner = new DesktopHostProcess({
    executable: process.execPath,
    entry,
    home,
    environment: { ...process.env, HOME: home },
    vault,
    fatal,
    startupTimeoutMs: mode === 'silent' ? 30 : 2000,
    shutdownTimeoutMs: 150,
  });
  cleanups.push(() => owner.stop());
  return { owner, fatal, entry, home, vault };
}
it('rejects a real unready Host at the bounded startup deadline and drains repeated stop without restarting', async () => {
  const f = await fixture('silent');
  await expect(f.owner.ready()).rejects.toThrow('DESKTOP_HOST_FAILED');
  expect(f.owner.authority()).toBeUndefined();
  expect(f.owner.snapshot().phase).toBe('failed');
  expect(f.fatal).toHaveBeenCalledOnce();
  const first = f.owner.stop();
  expect(f.owner.stop()).toBe(first);
  await first;
  expect(f.owner.snapshot().phase).toBe('stopped');
});
it.each(['wrong-generation', 'malformed'] as const)(
  'refuses a real %s ready frame without publishing authority or private fields',
  async (mode) => {
    const f = await fixture(mode);
    await expect(f.owner.ready()).rejects.toThrow('DESKTOP_HOST_FAILED');
    expect(f.owner.authority()).toBeUndefined();
    expect(f.fatal).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.owner.snapshot())).not.toContain('PRIVATE_HOST_CONTROL');
    await f.owner.stop();
  },
);
it('accepts valid ready once, releases startup supervision and creates independent authority in a fresh Host generation', async () => {
  const first = await fixture('ready');
  expect(await first.owner.ready()).toMatchObject({
    type: 'ready',
    generation: first.owner.generation,
  });
  const authority = first.owner.authority()!;
  expect(authority.origin).toBe('http://127.0.0.1:49152');
  await first.owner.stop();
  expect(first.owner.authority()).toBeUndefined();
  const second = await fixture('ready');
  await second.owner.ready();
  expect(second.owner.generation).not.toBe(first.owner.generation);
  expect(second.owner.authority()?.credential).not.toBe(authority.credential);
  expect(first.fatal).not.toHaveBeenCalled();
  expect(second.fatal).not.toHaveBeenCalled();
  await second.owner.stop();
});
it('force-kills a real Host that ignores shutdown and joins actual child close before releasing Native ownership', async () => {
  const f = await fixture('ignore-shutdown');
  await f.owner.ready();
  await f.owner.stop();
  expect(f.owner.snapshot().phase).toBe('stopped');
  expect(f.owner.authority()).toBeUndefined();
  expect(f.fatal).not.toHaveBeenCalled();
});
it('contains a throwing failure notification without leaking its exception and still permits actual drain', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fatal = vi.fn(() => {
    throw Error('PRIVATE_NOTIFICATION_FAILURE');
  });
  const f = await fixture('wrong-generation', fatal);
  await expect(f.owner.ready()).rejects.toThrow('DESKTOP_HOST_FAILED');
  expect(fatal).toHaveBeenCalledOnce();
  expect(warning).toHaveBeenCalledWith('[desktop] Failure notification failed');
  expect(JSON.stringify(warning.mock.calls)).not.toContain('PRIVATE_NOTIFICATION_FAILURE');
  await f.owner.stop();
});

it('rejects invalid deadlines before spawning any Host process', async () => {
  const f = await fixture('ready');
  await f.owner.ready();
  for (const value of [0, -1, 0.5, NaN, Infinity, 120001]) {
    for (const key of ['startupTimeoutMs', 'shutdownTimeoutMs'] as const) {
      expect(
        () =>
          new DesktopHostProcess({
            executable: '/invalid/never-spawn',
            entry: f.entry,
            home: f.home,
            environment: {},
            vault: f.vault,
            fatal: vi.fn(),
            [key]: value,
          }),
      ).toThrow('DESKTOP_HOST_DEADLINE_INVALID');
    }
  }
});
