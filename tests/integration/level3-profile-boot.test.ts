import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(profile = 'web', failing = false, hmr = false) {
  const home = await mkdtemp(join(tmpdir(), 'axterm-profile-boot-'));
  roots.push(home);
  const directory = join(home, 'profiles', profile);
  const bundle = join(directory, 'node_modules/@fixture/bundle');
  const plugin = join(directory, 'node_modules/@fixture/probe');
  await mkdir(bundle, { recursive: true });
  await mkdir(plugin, { recursive: true });
  const journal = join(home, 'lifecycle.jsonl');
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: `fixture-${profile}`,
      private: true,
      dependencies: { '@fixture/bundle': '1.0.0', '@fixture/probe': '1.0.0' },
      axterm: {
        profile: { bundles: [...(hmr ? ['@axterm/bundle-base'] : []), '@fixture/bundle'] },
      },
    }),
  );
  await writeFile(
    join(bundle, 'package.json'),
    JSON.stringify({
      name: '@fixture/bundle',
      version: '1.0.0',
      dependencies: { '@fixture/probe': '1.0.0' },
      axterm: { bundle: { patch: './patch.json' } },
    }),
  );
  await writeFile(
    join(bundle, 'patch.json'),
    JSON.stringify([
      {
        insert: [
          {
            id: 'probe',
            name: '@fixture/probe',
            config: { value: 'bundle', nested: { a: 1, b: 2 }, journal },
          },
        ],
      },
    ]),
  );
  await writeFile(
    join(plugin, 'package.json'),
    JSON.stringify({
      name: '@fixture/probe',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
      peerDependencies: { '@deepseek-ai/cordis': '*' },
    }),
  );
  await writeFile(
    join(plugin, 'index.js'),
    `import {appendFileSync} from 'node:fs';
export const inject=['profileContext'];
export function apply(ctx,config){
 appendFileSync(config.journal,JSON.stringify({event:'start',profile:ctx.profileContext.name})+'\\n');
 ctx.effect(()=>()=>appendFileSync(config.journal,JSON.stringify({event:'stop'})+'\\n'));
 if(ctx.cmdlineArgs.get().includes('hold')) ctx.effect(()=>{const timer=setInterval(()=>{},1000);return()=>clearInterval(timer);});
 ${failing ? "throw new Error('probe activation failure');" : "ctx.provide('probe',{value:config.value,profile:ctx.profileContext.name,home:ctx.profileContext.home,nested:config.nested??null,args:ctx.cmdlineArgs.get()});"}
}`,
  );
  await writeFile(
    join(directory, 'cordis.patch.yml'),
    JSON.stringify([
      ...(hmr
        ? [
            {
              id: 'hmr',
              config: { root: [], awaitWriteFinish: { stabilityThreshold: 30, pollInterval: 10 } },
            },
          ]
        : []),
      { id: 'probe', config: { value: 'profile', journal } },
    ]),
  );
  await writeFile(
    join(home, 'cordis.patch.yml'),
    JSON.stringify([{ id: 'probe', config: { value: 'home', journal } }]),
  );
  const overlay = join(home, 'overlay.json');
  await writeFile(
    overlay,
    JSON.stringify([{ id: 'probe', config: { value: 'overlay', journal } }]),
  );
  return { home, directory, journal, overlay, profile };
}

function invocation(f: Awaited<ReturnType<typeof fixture>>, body: string) {
  const options = {
    profile: f.profile,
    home: f.home,
    installAnchor: resolve('apps/cli/package.json'),
    templates: {},
    patchFiles: [f.overlay],
    args: ['literal-argument'],
    desktopOwner: true,
  };
  return `import {runProfile,dumpProfile} from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-boot.js')).href)};\nconst options=${JSON.stringify(options)};\n${body}`;
}

async function run(f: Awaited<ReturnType<typeof fixture>>, body: string) {
  const script = invocation(f, body);
  return execute(process.execPath, ['--expose-internals', '--input-type=module', '-e', script], {
    cwd: resolve('.'),
    env: { ...process.env, AXTERM_HOME: f.home, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' },
    timeout: 8000,
  });
}

describe('real Cordis Profile runner', () => {
  it('rejects an enabled built-in file owner with a missing shared task service instead of exposing an unusable Client', async () => {
    const f = await fixture();
    const manifest = JSON.parse(await readFile(join(f.directory, 'package.json'), 'utf8'));
    manifest.axterm.profile.bundles.unshift('@axterm/bundle-base', '@axterm/bundle-files');
    await writeFile(join(f.directory, 'package.json'), JSON.stringify(manifest));
    await writeFile(
      join(f.directory, 'cordis.patch.yml'),
      JSON.stringify([{ id: 'desktop-task-inspection', disabled: true }]),
    );
    await expect(run(f, 'await runProfile(options);')).rejects.toThrow(
      /files \(required\)\s+desktopTaskInspection/,
    );
    // A rejected startup must release the Profile writer lock before the repaired attempt.
    await writeFile(join(f.directory, 'cordis.patch.yml'), '[]');
    const { stdout } = await run(
      f,
      "const app=await runProfile(options);console.log(JSON.stringify({files:!!app.ctx.get('filesController'),tasks:!!app.ctx.get('desktopTaskInspection')}));await app.shutdown.shutdown(0);",
    );
    expect(JSON.parse(stdout.trim())).toEqual({ files: true, tasks: true });
  });
  it('imports every unchanged framework build in the supported Node runtime', async () => {
    const f = await fixture();
    const { stdout } = await run(
      f,
      `
      const names=['cosmokit','schemastery','cordis','cordis-plugin-loader','cordis-plugin-include','cordis-plugin-group','cordis-plugin-timer','cordis-plugin-hmr','cordis-plugin-logger-console'];
      for(const name of names) await import('@deepseek-ai/'+name);
      console.log(JSON.stringify({imported:names.length}));
    `,
    );
    expect(JSON.parse(stdout.trim())).toEqual({ imported: 9 });
  });

  for (const profile of ['desktop', 'web', 'headless'])
    it(`boots ${profile} with facts before plugin activation and releases owned effects`, async () => {
      const f = await fixture(profile);
      const { stdout } = await run(
        f,
        `const before=[process.listenerCount('SIGTERM'),process.listenerCount('SIGINT'),process.listenerCount('unhandledRejection')]; const app=await runProfile(options); const probe=app.ctx.get('probe'); await app.shutdown.shutdown(0); console.log(JSON.stringify({probe,before,after:[process.listenerCount('SIGTERM'),process.listenerCount('SIGINT'),process.listenerCount('unhandledRejection')]}));`,
      );
      const result = JSON.parse(stdout.trim());
      expect(result.probe).toEqual({
        value: 'overlay',
        profile,
        home: f.home,
        nested: null,
        args: ['literal-argument'],
      });
      expect(result.after).toEqual(result.before);
      expect(
        (await readFile(f.journal, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line).event),
      ).toEqual(['start', 'stop']);
    });

  it('dumps the same ordered replacement patches as boot and refuses CLI desktop ownership', async () => {
    const f = await fixture('desktop');
    const { stdout } = await run(
      f,
      `const dump=dumpProfile(options); let denied=false; try{dumpProfile({...options,desktopOwner:false});}catch{denied=true;} console.log(JSON.stringify({dump,denied}));`,
    );
    const result = JSON.parse(stdout.trim());
    expect(result.denied).toBe(true);
    expect(result.dump).toContain('overlay');
    expect(result.dump).not.toContain('value: bundle');
    expect(result.dump).not.toContain('nested:');
  });

  it('contains activation failure and still disposes partially activated resources', async () => {
    const f = await fixture('web', true);
    const { stdout, stderr } = await run(
      f,
      "const app=await runProfile(options); console.log(JSON.stringify({state:[...app.ctx.loader.entries()].find(entry=>entry.options.id==='probe')?.fiber?.state})); await app.shutdown.shutdown(0);",
    );
    expect(JSON.parse(stdout.trim()).state).toBe(3);
    expect(stderr).toContain('probe activation failure');
    expect(
      (await readFile(f.journal, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).event),
    ).toEqual(['start', 'stop']);
  });

  it('excludes concurrent profile owners and releases the lock on SIGTERM', async () => {
    const f = await fixture();
    const first = spawn(
      process.execPath,
      [
        '--expose-internals',
        '--input-type=module',
        '-e',
        invocation(f, "options.args=['hold']; await runProfile(options); console.log('READY');"),
      ],
      {
        env: {
          ...process.env,
          AXTERM_HOME: f.home,
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exited = new Promise<number | null>((resolve) => first.once('exit', resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Profile did not become ready')), 3000);
        first.stdout.on('data', (data) => {
          if (String(data).includes('READY')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        first.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        first.once('exit', (code) => {
          clearTimeout(timeout);
          if (code !== 0) reject(new Error(`Profile exited ${code}`));
        });
      });
      await expect(run(f, 'await runProfile(options);')).rejects.toThrow(/writer lock/);
      first.kill('SIGTERM');
      expect(await exited).toBe(0);
      await expect(
        run(f, 'const app=await runProfile(options); await app.shutdown.shutdown(0);'),
      ).resolves.toBeDefined();
    } finally {
      if (first.exitCode === null) first.kill('SIGKILL');
    }
  });

  it('does not expose malformed YAML input through messages or nested causes', async () => {
    const f = await fixture();
    await writeFile(f.overlay, '- id: probe\n  config: [PRIVATE_CONFIGURATION_MARKER\n');
    let failure: unknown;
    try {
      await run(f, 'await runProfile(options);');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain('PRIVATE_CONFIGURATION_MARKER');
    expect(String(failure)).toContain('failed to parse');
  });

  it('does not expose malformed Profile JSON input through startup diagnostics', async () => {
    const f = await fixture();
    await writeFile(
      join(f.directory, 'package.json'),
      '{"private":"PRIVATE_CONFIGURATION_MARKER",invalid}',
    );
    let failure: unknown;
    try {
      await run(f, 'await runProfile(options);');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain('PRIVATE_CONFIGURATION_MARKER');
    expect(String(failure)).toContain('invalid profile manifest');
  });

  it('reconciles real configuration watches, contains parse failure and drains self-unload', async () => {
    const f = await fixture('web', false, true);
    const { stdout, stderr } = await run(
      f,
      `
      import {writeFile,unlink,readFile} from 'node:fs/promises';
      import {join} from 'node:path';
      options.patchFiles=[];
      const app=await runProfile(options);
      const hmr=app.ctx.get('hmr');
      if(!hmr) throw new Error('HMR did not activate');
      if(!app.ctx.get('typert')) throw new Error('Reflection registry did not activate');
      const waitFor=async(predicate)=>{
        const deadline=Date.now()+3500;
        while(!predicate()) {
          if(Date.now()>deadline) throw new Error('Configuration did not reconcile');
          await new Promise(resolve=>setTimeout(resolve,20));
        }
      };
      const homePatch=join(options.home,'cordis.patch.yml');
      const profilePatch=join(options.home,'profiles/web/cordis.patch.yml');
      const manifest=join(options.home,'profiles/web/package.json');
      const config=(value)=>JSON.stringify([{id:'probe',config:{value,journal:${JSON.stringify(f.journal)}}}]);
      const profileOriginal=await readFile(profilePatch,'utf8');
      await writeFile(homePatch,config('home-edited'));
      await waitFor(()=>app.ctx.get('probe')?.value==='home-edited');
      await writeFile(profilePatch,${JSON.stringify('- id: probe\n  config: [PRIVATE_HMR_CONFIGURATION_MARKER\n')});
      // A manual reconciliation shares the exact automatic queue and exposes its failure deterministically.
      let rejected=false;
      try { await hmr.runExclusive(()=>hmr.reconcileProfile()); } catch {rejected=true;}
      if(!rejected || app.ctx.get('probe')?.value!=='home-edited') throw new Error('Invalid generation replaced live config');
      await writeFile(profilePatch,profileOriginal);
      await unlink(homePatch);
      await waitFor(()=>app.ctx.get('probe')?.value==='profile');
      const data=JSON.parse(await readFile(manifest,'utf8'));
      data.axterm.profile.bundles=[];
      await writeFile(manifest,JSON.stringify(data));
      await waitFor(()=>!app.ctx.get('hmr')&&!app.ctx.get('probe')&&!app.ctx.get('typert'));
      await app.shutdown.shutdown(0);
      let disposed=false;try{await hmr.runExclusive(async()=>{});}catch{disposed=true;}
      console.log(JSON.stringify({rejected,disposed}));
    `,
    );
    expect(JSON.parse(stdout.trim())).toEqual({ rejected: true, disposed: true });
    expect(stderr).not.toContain('PRIVATE_HMR_CONFIGURATION_MARKER');
    const events = (await readFile(f.journal, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event);
    expect(events.filter((event) => event === 'start')).toHaveLength(
      events.filter((event) => event === 'stop').length,
    );
  });

  it('rejects malformed patch metadata before running the plugin', async () => {
    const f = await fixture();
    await writeFile(f.overlay, 'not-a-list: true\n');
    await expect(run(f, 'await runProfile(options);')).rejects.toThrow(/top-level YAML array/);
    await expect(readFile(f.journal)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
