import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installFrameFixture } from './level3-frame.ts';
/** Test-only file selection controls; does not stand in for the product file UI. */
export async function installFileFrameFixture(
  home: string,
  options: {
    sftp?: { port: number; password: string };
    ftp?: { port: number; credentialRef: string };
  } = {},
): Promise<void> {
  await installFrameFixture(home, 'desktop');
  const profile = join(home, 'profiles/desktop');
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  manifest.axterm.profile.bundles.push('@axterm/bundle-files');
  if (options.sftp || options.ftp)
    manifest.axterm.profile.bundles.push(
      '@axterm/bundle-catalog',
      '@axterm/bundle-configuration',
      '@axterm/bundle-terminals',
      '@axterm/bundle-connections',
      '@axterm/bundle-transfers',
    );
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest));
  const exerciseTransfer = `{
            const grant=await model.create({kind:'directory-path',path:${JSON.stringify(home)}});
            const payload=new TextEncoder().encode('packaged transfer payload');const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',payload))).map(value=>value.toString(16).padStart(2,'0')).join('');
            const query=new URLSearchParams({grantId:grant.grantId,path:'transfer-source.txt',overwrite:'true'});
            const write=await fetch('/api/files/write?'+query,{method:'POST',headers:{'idempotency-key':crypto.randomUUID(),'x-axterm-file-bytes':String(payload.length),'x-axterm-file-sha256':digest},body:payload});if(!write.ok)throw new Error('transfer-source');
            const transfers=ctx.transfersModel;const key=crypto.randomUUID();const request={target,direction:'upload',grantId:grant.grantId,localPath:'transfer-source.txt',remotePath:'/transfer-payload.txt'};
            const uploaded=await transfers.create(key,request);if((await transfers.create(key,request)).id!==uploaded.id)throw new Error('transfer-receipt');
            const wait=async id=>{for(let attempt=0;attempt<500;attempt++){const task=await transfers.get(id);if(task.state==='succeeded')return;if(task.state==='failed'||task.state==='canceled')throw new Error('transfer-failed');await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('transfer-timeout');};
            await wait(uploaded.id);const downloaded=await transfers.create(crypto.randomUUID(),{...request,direction:'download',localPath:'transfer-downloaded.txt'});await wait(downloaded.id);
            const read=await fetch('/api/files/read?'+new URLSearchParams({grantId:grant.grantId,path:'transfer-downloaded.txt'}));if(!read.ok||await read.text()!=='packaged transfer payload')throw new Error('transfer-roundtrip');
            await model.deleteRemoteEntry(crypto.randomUUID(),target,'/transfer-payload.txt');await model.deleteEntry(crypto.randomUUID(),grant.grantId,'transfer-source.txt');await model.deleteEntry(crypto.randomUUID(),grant.grantId,'transfer-downloaded.txt');await model.revoke(grant.grantId);
  }`;
  await writeFile(
    join(profile, 'node_modules/@fixture/frame/client.browser.js'),
    `window.__ModuleLoader__.load({id:'@fixture/frame',factory(require){
    const React=require('react');return {inject:${JSON.stringify(['slots', 'fileGrantsModel', ...(options.sftp ? ['connectionsModel', 'transfersModel'] : options.ftp ? ['connectionsModel', 'catalogModel', 'transfersModel'] : [])])},apply(ctx){const model=ctx.fileGrantsModel;
      ctx.slots.register({name:'root'},function Probe(){const state=React.useSyncExternalStore(model.subscribe,model.getSnapshot);const [busy,setBusy]=React.useState(false);const [result,setResult]=React.useState('idle');const catalogState=${options.ftp ? 'React.useSyncExternalStore(ctx.catalogModel.subscribe,ctx.catalogModel.getSnapshot)' : 'null'};
        return React.createElement('main',{'data-file-state':state.status,'data-catalog-state':catalogState?.status,'data-file-generation':state.status==='ready'?state.baseline.generation:''},
          React.createElement('button',{id:'choose',disabled:busy,onClick:async()=>{setBusy(true);try{await model.create({kind:'open-directory'});}catch{}finally{setBusy(false);}}},'Choose directory'),
          React.createElement('button',{id:'exercise-files',onClick:async()=>{setResult('working');try{
            const grant=await model.create({kind:'directory-path',path:${JSON.stringify(home)}});
            const key=crypto.randomUUID();const created=await model.createEntry(key,grant.grantId,{name:'owned-fixture',type:'directory'});
            const duplicate=await model.createEntry(key,grant.grantId,{path:'',name:'owned-fixture',type:'directory'});
            if(duplicate.id!==created.id)throw new Error('receipt');
            await model.createEntry(crypto.randomUUID(),grant.grantId,{path:'owned-fixture',name:'source.txt',type:'file'});
            const payload='packaged streamed bytes';const bytes=new TextEncoder().encode(payload);const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('');
            const query=new URLSearchParams({grantId:grant.grantId,path:'owned-fixture/source.txt',overwrite:'true'});const nonce=crypto.randomUUID();
            const upload=()=>fetch('/api/files/write?'+query,{method:'POST',headers:{'idempotency-key':nonce,'x-axterm-file-bytes':String(bytes.length),'x-axterm-file-sha256':digest},body:bytes});
            const uploaded=await upload();if(!uploaded.ok)throw new Error('upload');const receipt=await uploaded.json();
            const repeated=await upload();if(!repeated.ok||(await repeated.json()).id!==receipt.id)throw new Error('stream-receipt');
            const downloaded=await fetch('/api/files/read?'+new URLSearchParams({grantId:grant.grantId,path:'owned-fixture/source.txt'}));if(!downloaded.ok||await downloaded.text()!==payload)throw new Error('download');
            await model.operateEntries(crypto.randomUUID(),grant.grantId,{paths:['owned-fixture/source.txt'],destination:'owned-fixture',operation:'copy',conflict:'rename'});
            const listed=await model.listDirectory(grant.grantId,'owned-fixture');if(listed.entries.length!==2)throw new Error('copy');
            await model.deleteEntry(crypto.randomUUID(),grant.grantId,'owned-fixture');await model.revoke(grant.grantId);setResult('done');
          }catch{setResult('failed');}}},'Exercise file operations'),
          React.createElement('button',{id:'exercise-imports',onClick:async()=>{setResult('import-working');const owned=[];let step='upload';try{
            const payload=new Uint8Array(4*1024*1024);for(let i=0;i<payload.length;i++)payload[i]=i%251;
            const file=new File([payload],'用户文書.bin');const grant=await model.importFile(file);owned.push(grant.grantId);
            if(grant.name!==file.name||grant.permissions.join(',')!=='read')throw new Error('import-authority');
            step='download';const response=await fetch('/api/files/read?'+new URLSearchParams({grantId:grant.grantId,path:grant.name}));if(!response.ok)throw new Error('import-read');
            const actual=await response.arrayBuffer();const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',value))).join(',');
            if(actual.byteLength!==payload.length||await hash(actual)!==await hash(payload))throw new Error('import-hash');
            step='editable';const editable=await model.importFile(new File(['editable user file'],'editable.txt'),true);owned.push(editable.grantId);
            if(editable.permissions.join(',')!=='read,write'||(await model.readText(editable.grantId,1024)).content!=='editable user file')throw new Error('editable-import');
            step='empty';const empty=await model.importFile(new File([],'empty.txt'));owned.push(empty.grantId);
            step='empty-read';if((await model.readText(empty.grantId,1024)).content!=='')throw new Error('empty-import');
            step='revoke';for(const id of owned.splice(0))await model.revoke(id);
            setResult('import-done');
          }catch(error){const reason=error?.details?.reason??error?.name;setResult('import-failed-'+step+'-'+(typeof reason==='string'&&/^[a-zA-Z-]{1,32}$/.test(reason)?reason:'unknown'));}finally{for(const id of owned)await model.revoke(id).catch(()=>{});}}},'Exercise managed file imports'),
          React.createElement('output',{'data-file-operations':result},result),
          ${
            options.sftp
              ? `React.createElement('button',{id:'exercise-remote-files',onClick:async()=>{setResult('remote-working');let connection;try{
            const connections=ctx.connectionsModel;
            connection=await connections.createConnection(crypto.randomUUID(),{target:{hostname:'127.0.0.1',port:${options.sftp.port},username:'fixture',authType:'password'},temporarySecret:${JSON.stringify(options.sftp.password)}});
            let ready=false;const answered=new Set();
            for(let attempt=0;attempt<500;attempt++){
              const state=connections.getSnapshot();
              if(state.status==='ready'){
                const current=state.baseline.connections.find(item=>item.id===connection.id);
                if(current?.state==='ready'){ready=true;break;}
                if(current?.state==='failed')throw new Error('connect');
                const prompt=state.baseline.interactions.find(item=>item.connectionId===connection.id);
                if(prompt&&!answered.has(prompt.id)){answered.add(prompt.id);await connections.respondInteraction(prompt.id,{accepted:true,remember:false});}
              }await new Promise(resolve=>setTimeout(resolve,10));
            }if(!ready)throw new Error('connect-timeout');
            const target={protocol:'sftp',connectionId:connection.id};
            const home=await model.getRemoteHome(target);if(home.path!=='/')throw new Error('home');
            const key=crypto.randomUUID();const first=await model.createRemoteEntry(key,target,{path:'/source',type:'file'});
            const duplicate=await model.createRemoteEntry(key,target,{path:'/source',type:'file'});if(first.id!==duplicate.id)throw new Error('receipt');
            const text=await model.readRemoteText(target,'/source');if(text.content!=='')throw new Error('text');
            await model.operateRemoteEntries(crypto.randomUUID(),target,{paths:['/source'],destination:'/',operation:'copy'});
            const listing=await model.listRemoteDirectory(target,'/');if(listing.entries.length!==2)throw new Error('copy');
            await model.deleteRemoteEntry(crypto.randomUUID(),target,'/source');await model.deleteRemoteEntry(crypto.randomUUID(),target,'/source(copy-1)');
            ${exerciseTransfer}
            await connections.closeConnection(connection.id);connection=undefined;setResult('remote-done');
          }catch{setResult('remote-failed');}finally{if(connection)await ctx.connectionsModel.closeConnection(connection.id).catch(()=>{});}}},'Exercise remote file operations'),`
              : ''
          }

          ${
            options.ftp
              ? `React.createElement('button',{id:'exercise-ftp-files',onClick:async()=>{setResult('ftp-working');let connection;try{
            const catalog=ctx.catalogModel;const state=catalog.getSnapshot();if(state.status!=='ready')throw new Error('catalog');
            const created=await catalog.createBookmark(crypto.randomUUID(),{protocol:'ftp',hostId:null,title:'Packaged FTP',ftp:{hostname:'127.0.0.1',port:${options.ftp.port},username:'fixture',credentialRef:${JSON.stringify(options.ftp.credentialRef)},security:'plain',tlsVerify:true,encoding:'utf-8',initialDirectory:'/'}},state.baseline.bookmarks.etag);
            const connections=ctx.connectionsModel;connection=await connections.createFtpConnection(crypto.randomUUID(),{bookmarkId:created.ids[0]});
            const target={protocol:'ftp',connectionId:connection.id};const home=await model.getRemoteHome(target);if(home.path!=='/')throw new Error('home');
            const original=await model.readRemoteText(target,'/hello.txt');if(original.content!=='hello')throw new Error('text');
            const key=crypto.randomUUID();const first=await model.createRemoteEntry(key,target,{path:'/source',type:'file'});
            const duplicate=await model.createRemoteEntry(key,target,{path:'/source',type:'file'});if(first.id!==duplicate.id)throw new Error('receipt');
            await model.operateRemoteEntries(crypto.randomUUID(),target,{paths:['/hello.txt'],destination:'/',operation:'copy'});
            const text=await model.readRemoteText(target,'/hello(copy-1).txt');if(text.content!=='hello')throw new Error('copy');
            await model.deleteRemoteEntry(crypto.randomUUID(),target,'/source');await model.deleteRemoteEntry(crypto.randomUUID(),target,'/hello(copy-1).txt');
            ${exerciseTransfer}
            await connections.closeFtpConnection(connection.id);connection=undefined;setResult('ftp-done');
          }catch{setResult('ftp-failed');}finally{if(connection)await ctx.connectionsModel.closeFtpConnection(connection.id).catch(()=>{});}}},'Exercise FTP operations'),`
              : ''
          }

          React.createElement('output',{'data-grant-count':state.status==='ready'?state.baseline.grants.length:''}));});
    }};}});`,
  );
}
