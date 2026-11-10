import { readFile, writeFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
const execute = promisify(execFile);
const packageResult = process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
it.skipIf(!packageResult || process.platform !== 'darwin')(
  'runs owned subprocesses, raw PTY and emitted FFI bootstrap in source-free Electron with a restricted PATH',
  async () => {
    const record: { app: string } = JSON.parse(await readFile(resolve(packageResult!), 'utf8'));
    const inventory: { packages: { name: string; id: string }[] } = JSON.parse(
      await readFile(join(record.app, 'LEVEL3_PACKAGE.json'), 'utf8'),
    );
    const locate = (name: string) => {
      const entry = inventory.packages.find((p) => p.name === name);
      if (!entry) throw new Error('Required packaged subprocess dependency is missing');
      return join(record.app, 'node_modules/.axterm', entry.id, 'package');
    };
    const appRoot = dirname(dirname(dirname(record.app)));
    const [name] = await readdir(join(appRoot, 'Contents/MacOS'));
    const binary = join(appRoot, 'Contents/MacOS', name!);
    const home = await mkdtemp(join(tmpdir(), 'axterm-subprocess-source-free-'));
    try {
      const probe = join(home, 'subprocess-probe.mjs');
      await writeFile(
        probe,
        `
 import assert from 'node:assert/strict';
 import {readFile,stat,mkdtemp,writeFile,rm} from 'node:fs/promises';
 import {join} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
 import {Context} from ${JSON.stringify(pathToFileURL(join(locate('@deepseek-ai/cordis'), 'lib/index.js')).href)};
 import Local from ${JSON.stringify(pathToFileURL(join(locate('@axterm/infra-subprocess-local'), 'lib/index.js')).href)};
 const root=new Context();const baseline=process.listenerCount('exit');await root.plugin(Local);
 try{
  assert.equal(await root.subprocess.resolveExecutable('/bin/sh'),'/bin/sh');
  const child=root.subprocess.spawn({argv:['/bin/sh','-c','printf packaged-output'],cwd:process.cwd(),graceMs:100,stdio:{stdin:'ignore',stdout:{maxBytes:4,spill:{maxBytes:1024}},stderr:{maxBytes:128}}});
  assert.equal((await child.done).exitCode,0);const value=child.collected.stdout.readFrom(0);
  assert.equal(value.text,'tput');assert.equal(value.lossy,true);assert.equal(await readFile(value.spillPath,'utf8'),'packaged-output');
  assert.equal((await stat(value.spillPath)).mode & 0o777,0o600);await child.dispose();
  await assert.rejects(stat(value.spillPath),{code:'ENOENT'});assert.throws(()=>child.collected.stdout.readFrom(0),/CLOSED/);
  const term=await root.subprocess.spawnTerminal({argv:['/bin/sh','-c','printf "\\\\377\\\\376TAG"'],cwd:process.cwd(),graceMs:1000,rows:24,cols:80,terminalType:'xterm',binary:true});
  const chunks=[];term.output.on('data',b=>chunks.push(Buffer.from(b)));await term.done;await term.terminate();
  assert.ok(Buffer.concat(chunks).equals(Buffer.from([255,254,...Buffer.from('TAG')])));
 }finally{await root.fiber.dispose();}
 assert.equal(process.listenerCount('exit'),baseline);
 const requestDir=await mkdtemp(join(process.cwd(),'axterm-subprocess-launch-'));const request=join(requestDir,'launch-request.json');
 try{
  await writeFile(request,JSON.stringify({cwd:process.cwd(),env:{PATH:'/usr/bin:/bin',EXPLICIT_FACT:'owned'}}),{mode:0o600});
  const result=await promisify(execFile)(process.execPath,[${JSON.stringify(join(locate('@axterm/infra-subprocess-local'), 'lib/runner.js'))},'--','/bin/sh','-c','printf "%s:%s" "$EXPLICIT_FACT" "\${AXTERM_SUBPROCESS_RUNNER-unset}"'],{env:{PATH:'/usr/bin:/bin',HOME:process.cwd(),ELECTRON_RUN_AS_NODE:'1',AXTERM_SUBPROCESS_RUNNER:request},timeout:5000});
  assert.equal(result.stdout,'owned:unset');await assert.rejects(stat(request),{code:'ENOENT'});
 }finally{await rm(requestDir,{recursive:true,force:true});}
 console.log('source-free Electron RunAsNode subprocess, native raw PTY, private spills, listener cleanup and emitted FFI exec bootstrap passed');
 `,
      );
      const { stdout } = await execute(binary, ['--expose-internals', probe], {
        cwd: home,
        timeout: 15000,
        maxBuffer: 256 * 1024,
        env: {
          ...process.env,
          HOME: home,
          AXTERM_HOME: home,
          AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
          PATH: '/usr/bin:/bin',
          NODE_PATH: '',
          NODE_OPTIONS: '',
          ELECTRON_RUN_AS_NODE: '1',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        },
      });
      expect(stdout.trim()).toBe(
        'source-free Electron RunAsNode subprocess, native raw PTY, private spills, listener cleanup and emitted FFI exec bootstrap passed',
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  20000,
);
