import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installFrameFixture } from './level3-frame.ts';

/** Test-only byte sink, not the Axterm workspace or its visual acceptance. */
export async function installTerminalFrameFixture(home: string): Promise<void> {
  await installFrameFixture(home, 'desktop');
  const profile = join(home, 'profiles/desktop');
  const manifestPath = join(profile, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.axterm.profile.bundles.push('@axterm/bundle-terminals');
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    JSON.stringify([
      {
        id: 'terminals',
        config: {
          shell: '/bin/sh',
          shellArgs: ['-f'],
          cwd: home,
          env: { HOME: home, HISTFILE: '/dev/null', ENV: '' },
          maxSessions: 2,
        },
      },
    ]),
  );
  const frame = join(profile, 'node_modules/@fixture/frame');
  const frameManifest = JSON.parse(await readFile(join(frame, 'package.json'), 'utf8'));
  frameManifest.axterm.client.external.push('@axterm/plugin-terminals/client');
  await writeFile(join(frame, 'package.json'), JSON.stringify(frameManifest));
  await writeFile(
    join(frame, 'client.browser.js'),
    `window.__ModuleLoader__.load({id:'@fixture/frame',factory(require){
    const React=require('react'); const {TerminalStream}=require('@axterm/plugin-terminals/client');
    return {inject:['slots','desktopRuntimeModel','terminalsModel','connection'],apply(ctx){
      const model=ctx.terminalsModel;
      ctx.slots.register({name:'root'},function TerminalProbe(){
        const state=React.useSyncExternalStore(model.subscribe,model.getSnapshot);
        const [id,setId]=React.useState(null); const [closeState,setCloseState]=React.useState('idle');
        const output=React.useRef(null); const channel=React.useRef(null);
        React.useEffect(()=>{if(!id || !output.current)return;
          const decoder=new TextDecoder();
          const stream=new TerminalStream(ctx.connection,{terminalId:id,
            writer:{write(bytes,done){const value=typeof bytes==='string'?bytes:decoder.decode(bytes,{stream:true});output.current.textContent=(output.current.textContent+value).slice(-16384);done();}},
            control(control){if(control.type==='ready')output.current.dataset.channel='ready';},
            closed(){if(output.current)output.current.dataset.channel='closed';}});
          channel.current=stream;return()=>{stream.dispose();channel.current=null;};
        },[id]);
        return React.createElement('main',{'data-terminal-probe':state.status,'data-session-count':state.status==='ready'?state.baseline.sessions.length:'','data-close-state':closeState},
          React.createElement('button',{id:'create',onClick:async()=>{const session=await model.create({kind:'local',cols:80,rows:24});setId(session.id);}},'Create'),
          React.createElement('button',{id:'input',onClick:()=>channel.current?.sendInput("printf '\\\\101\\\\130\\\\124\\\\105\\\\122\\\\115\\\\137\\\\120\\\\101\\\\103\\\\113\\\\101\\\\107\\\\105\\\\137\\\\117\\\\113\\\\n'\\r")},'Input'),
          React.createElement('button',{id:'close',onClick:async()=>{if(id){setCloseState('pending');await model.close(id);setId(null);setCloseState('done');}}},'Close'),
          React.createElement('pre',{ref:output,'data-output':''}));
      });
    }};
  }});`,
  );
}
