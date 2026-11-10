import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { installFrameFixture } from './level3-frame.ts';

/** Test-only controls expose metadata ports; all forwarding bytes stay outside browser state. */
export async function installTunnelFrameFixture(
  home: string,
  input: { port: number; password: string; targetPort: number },
): Promise<void> {
  await installFrameFixture(home, 'desktop');
  const profile = join(home, 'profiles/desktop');
  const path = join(profile, 'package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.axterm.profile.bundles.push(
    '@axterm/bundle-catalog',
    '@axterm/bundle-configuration',
    '@axterm/bundle-terminals',
    '@axterm/bundle-connections',
  );
  await writeFile(path, JSON.stringify(manifest));
  const source = `window.__ModuleLoader__.load({id:'@fixture/frame',factory(require){const React=require('react');return {inject:['slots','connectionsModel'],apply(ctx){
    const model=ctx.connectionsModel;
    ctx.slots.register({name:'root'},function Probe(){
      const state=React.useSyncExternalStore(model.subscribe,model.getSnapshot);const [result,setResult]=React.useState('idle');const [ports,setPorts]=React.useState([]);const connection=React.useRef(null);
      return React.createElement('main',{'data-tunnel-state':state.status,'data-result':result,'data-tunnel-ports':JSON.stringify(ports)},
        React.createElement('button',{id:'start-tunnels',onClick:async()=>{setResult('working');const owned=[];try{
          const created=await model.createConnection(crypto.randomUUID(),{target:{hostname:'127.0.0.1',port:${input.port},username:'fixture',authType:'password'},temporarySecret:${JSON.stringify(input.password)}});connection.current=created.id;
          const answered=new Set();let ready=false;
          for(let attempt=0;attempt<500;attempt++){
            const current=model.getSnapshot();if(current.status==='ready'){
              const selected=current.baseline.connections.find(item=>item.id===created.id);
              if(selected?.state==='ready'){ready=true;break;}if(selected?.state==='failed')throw new Error('connect');
              const prompt=current.baseline.interactions.find(item=>item.connectionId===created.id);
              if(prompt&&!answered.has(prompt.id)){answered.add(prompt.id);await model.respondInteraction(prompt.id,{accepted:true,remember:false});}
            }await new Promise(resolve=>setTimeout(resolve,10));
          }if(!ready)throw new Error('connect-timeout');
          for(const type of ['local','remote','dynamic']){
            const key=crypto.randomUUID();const request={connectionId:created.id,profile:{name:'Packaged '+type,hostId:created.hostId,type,bindHost:'127.0.0.1',bindPort:0,targetHost:type==='dynamic'?null:'127.0.0.1',targetPort:type==='dynamic'?null:${input.targetPort},allowNonLoopback:false}};
            const tunnel=await model.startTunnel(key,request);owned.push({id:tunnel.id,type,port:tunnel.bindPort});if((await model.startTunnel(key,request)).id!==tunnel.id)throw new Error('replay');
          }setPorts(owned);setResult('ready');
        }catch{for(const item of owned)await model.stopTunnel(item.id).catch(()=>{});if(connection.current)await model.closeConnection(connection.current).catch(()=>{});setResult('failed');}}},'Start tunnels'),
        React.createElement('button',{id:'stop-tunnels',onClick:async()=>{try{for(const item of ports)await model.stopTunnel(item.id);if(connection.current)await model.closeConnection(connection.current);connection.current=null;setPorts([]);setResult('done');}catch{setResult('failed');}}},'Stop tunnels'));
    });
  }};}});`;
  new Script(source);
  await writeFile(join(profile, 'node_modules/@fixture/frame/client.browser.js'), source);
}
