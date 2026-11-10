import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { installFrameFixture } from './level3-frame.ts';
/** Test-only Slots frame. Protocol bytes feed a bounded digest directly, never a Client model or React state. */
export async function installRemoteDesktopFrameFixture(
  home: string,
  input: { rdp: number; vnc: number; spice: number; credentialRef: string; firstFrame: string },
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
    '@axterm/bundle-remote-desktop',
  );
  await writeFile(path, JSON.stringify(manifest));
  const source = `window.__ModuleLoader__.load({id:'@fixture/frame',factory(require){const React=require('react');return {inject:['slots','catalogModel','remoteDesktopModel','connection'],apply(ctx){
    const model=ctx.remoteDesktopModel; const catalog=ctx.catalogModel;
    ctx.slots.register({name:'root'},function Probe(){const state=React.useSyncExternalStore(model.subscribe,model.getSnapshot);const [result,setResult]=React.useState('idle');
      return React.createElement('main',{'data-desktop-state':state.status,'data-result':result},React.createElement('button',{id:'test-remote-desktop',onClick:async()=>{setResult('working');const ids=[];try{
        for(const protocol of ['rdp','vnc','spice']){
          const current=catalog.getSnapshot();if(current.status!=='ready')throw new Error('catalog');
          const bookmark=await catalog.createBookmark(crypto.randomUUID(),{protocol,hostId:null,title:'Packaged '+protocol,[protocol]:{hostname:'127.0.0.1',port:(${JSON.stringify(input)})[protocol],credentialRef:${JSON.stringify(input.credentialRef)},...(protocol==='spice'?{}:{username:'fixture'})}},current.baseline.bookmarks.etag);
          const key=crypto.randomUUID();const request={protocol,bookmarkId:bookmark.ids[0]};const created=await model.create(request,key);ids.push(created.id);
          const repeat=await model.create(request,key);if(repeat.id!==created.id)throw new Error('replay');
          const claim=await model.claimCredentials(created.id);if(!claim.password)throw new Error('claim');
          let replayRejected=false;try{await model.claimCredentials(created.id);}catch{replayRejected=true;}if(!replayRejected)throw new Error('claim-replay');
          const socket=ctx.connection.openWebSocket('/remote-desktop/stream?'+new URLSearchParams({id:created.id}));socket.binaryType='arraybuffer';
          await new Promise((resolve,reject)=>{let received=0;let first=protocol==='rdp';const timeout=setTimeout(()=>{socket.close();reject(new Error('bytes-timeout'));},10000);
            const send=()=>{const chunk=new Uint8Array(65536);chunk.fill(115);for(let i=0;i<64;i++)socket.send(chunk);};
            socket.addEventListener('open',()=>{if(first)socket.send(Uint8Array.from(atob(${JSON.stringify(input.firstFrame)}),c=>c.charCodeAt(0)));else send();});
            socket.addEventListener('error',()=>{clearTimeout(timeout);socket.close();reject(new Error('socket'));});
            socket.addEventListener('close',()=>{clearTimeout(timeout);if(received!==4194304)reject(new Error('early-close'));});
            socket.addEventListener('message',event=>{const bytes=new Uint8Array(event.data);if(first){first=false;if(bytes[0]!==48){socket.close();reject(new Error('rdp-handshake'));return;}send();return;}for(const byte of bytes)if(byte!==115){clearTimeout(timeout);socket.close();reject(new Error('corrupt'));return;}received+=bytes.length;if(received===4194304){clearTimeout(timeout);socket.close();resolve();}else if(received>4194304){clearTimeout(timeout);socket.close();reject(new Error('overflow'));}});
          });
          await model.close(created.id);
        }await model.retry();setResult('done');
      }catch{for(const id of ids)await model.close(id).catch(()=>{});setResult('failed');}}},'Test remote desktop'));
    });
  }};}});`;
  new Script(source);
  await writeFile(join(profile, 'node_modules/@fixture/frame/client.browser.js'), source);
}
