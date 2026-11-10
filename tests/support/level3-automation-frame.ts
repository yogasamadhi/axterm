import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { installTerminalFrameFixture } from './level3-terminal-frame.ts';
/** Validation-only Slots contribution; terminal bytes go to a bounded DOM sink, never React/model state. */
export async function installAutomationFrameFixture(
  home: string,
  input: { port: number; credentialRef: string },
): Promise<void> {
  await installTerminalFrameFixture(home);
  const profile = join(home, 'profiles/desktop');
  const path = join(profile, 'package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.axterm.profile.bundles.push(
    '@axterm/bundle-catalog',
    '@axterm/bundle-configuration',
    '@axterm/bundle-connections',
    '@axterm/bundle-automation',
    '@axterm/bundle-files',
  );
  await writeFile(path, JSON.stringify(manifest));
  const source = `window.__ModuleLoader__.load({id:'@fixture/frame',factory(require){const React=require('react');const {TerminalStream}=require('@axterm/plugin-terminals/client');return {inject:['slots','catalogModel','connectionsModel','automationModel','terminalsModel','connection','fileGrantsModel','fileRenameModel'],apply(ctx){
    const model=ctx.automationModel;const catalog=ctx.catalogModel;const connections=ctx.connectionsModel;const terminals=ctx.terminalsModel;
    ctx.slots.register({name:'root'},function Probe(){const state=React.useSyncExternalStore(model.subscribe,model.getSnapshot);const [result,setResult]=React.useState('idle');const output=React.useRef(null);
      return React.createElement('main',{'data-automation-state':state.status,'data-result':result},React.createElement('button',{id:'test-automation',onClick:async()=>{setResult('working');let channel;let connection;let terminal;try{
        const files=ctx.fileGrantsModel;const renames=ctx.fileRenameModel;const grant=await files.create({kind:'directory-path',path:${JSON.stringify(join(home, 'rename-fixture'))}});if(!grant)throw new Error('grant');
        const review=await renames.preview({grantId:grant.grantId,template:'{name}-{n:2}.{ext}'});if(!review.canRun||review.ready!==2)throw new Error('review');
        const renameKey=crypto.randomUUID();const renamed=await renames.run(renameKey,review.id,new AbortController().signal);if(renamed.renamed!==2||(await renames.run(renameKey,review.id,new AbortController().signal)).finishedAt!==renamed.finishedAt)throw new Error('rename-replay');
        const listing=await files.listDirectory(grant.grantId,'');if(!listing.entries.some(item=>item.name==='alpha-01.txt')||!listing.entries.some(item=>item.name==='beta-02.txt'))throw new Error('rename-list');
        await renames.retry();let renameReady=false;for(let attempt=0;attempt<500;attempt++){const snapshot=renames.getSnapshot();if(snapshot.status==='ready'&&snapshot.baseline.previews.length===0&&snapshot.baseline.running.length===0){renameReady=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}if(!renameReady)throw new Error('rename-retry');await files.revoke(grant.grantId);
        let current=catalog.getSnapshot();if(current.status!=='ready')throw new Error('catalog');
        const host=await catalog.createHost(crypto.randomUUID(),{name:'Packaged batch host',hostname:'127.0.0.1',port:${input.port},username:'fixture',authType:'password',credentialRef:${JSON.stringify(input.credentialRef)}});
        current=catalog.getSnapshot();if(current.status!=='ready')throw new Error('catalog');
        const bookmark=await catalog.createBookmark(crypto.randomUUID(),{protocol:'ssh',hostId:host.ids[0],title:'Packaged batch'},current.baseline.bookmarks.etag);
        connection=await connections.createConnection(crypto.randomUUID(),{hostId:host.ids[0]});const answered=new Set();let ready=false;
        for(let attempt=0;attempt<500;attempt++){const snapshot=connections.getSnapshot();if(snapshot.status==='ready'){const item=snapshot.baseline.connections.find(item=>item.id===connection.id);if(item?.state==='ready'){ready=true;break;}if(item?.state==='failed')throw new Error('connect');const prompt=snapshot.baseline.interactions.find(item=>item.connectionId===connection.id);if(prompt&&!answered.has(prompt.id)){answered.add(prompt.id);await connections.respondInteraction(prompt.id,{accepted:true,remember:true});}}await new Promise(resolve=>setTimeout(resolve,10));}if(!ready)throw new Error('connect-timeout');
        let facts=model.getSnapshot();if(facts.status!=='ready')throw new Error('facts');
        const group=await model.createQuickCommandGroup(crypto.randomUUID(),{name:'Packaged commands',parentId:null},facts.baseline.quickCommands.etag);
        facts=model.getSnapshot();if(facts.status!=='ready'||!facts.baseline.quickCommands.groups.some(item=>item.id===group.ids[0]))throw new Error('cursor');
        const key=crypto.randomUUID();const request={name:'Packaged SSH batch',bookmarkIds:[bookmark.ids[0]],steps:[{id:crypto.randomUUID(),name:'Inspect',command:'printf AXTERM_PACKAGED_BATCH_OK'}]};
        const batch=await model.createBatchOperation(key,request);if((await model.createBatchOperation(key,request)).ids[0]!==batch.ids[0])throw new Error('replay');let complete=false;
        for(let attempt=0;attempt<500;attempt++){facts=model.getSnapshot();if(facts.status==='ready'){const item=facts.baseline.batches.find(item=>item.id===batch.ids[0]);if(item?.state==='succeeded'){complete=true;break;}if(item&&['failed','canceled','interrupted'].includes(item.state))throw new Error('batch');}await new Promise(resolve=>setTimeout(resolve,10));}if(!complete)throw new Error('batch-timeout');
        facts=model.getSnapshot();if(facts.status!=='ready')throw new Error('facts');
        await model.createTrigger(crypto.randomUUID(),{name:'Packaged trigger',enabled:true,match:{type:'text',value:'AXTERM_PACKAGED_TRIGGER_PROBE',caseSensitive:true},action:{type:'send',value:'AXTERM_PACKAGED_TRIGGER_RESPONSE'},sendEnter:true,mode:'once',cooldownMs:0},facts.baseline.triggers.etag);
        terminal=await terminals.create({kind:'ssh',connectionId:connection.id,cols:80,rows:24});let streamReady=false;
        channel=new TerminalStream(ctx.connection,{terminalId:terminal.id,writer:{write(bytes,done){const text=typeof bytes==='string'?bytes:new TextDecoder().decode(bytes);output.current.textContent=(output.current.textContent+text).slice(-16384);done();}},control(value){if(value.type==='ready')streamReady=true;}});
        for(let attempt=0;attempt<500&&!streamReady;attempt++)await new Promise(resolve=>setTimeout(resolve,10));if(!streamReady)throw new Error('stream');
        if(!channel.sendInput('AXTERM_PACKAGED_TRIGGER_PROBE\\n'))throw new Error('stdin');let triggered=false;
        for(let attempt=0;attempt<500;attempt++){if(output.current.textContent.includes('AXTERM_PACKAGED_TRIGGER_RESPONSE')){triggered=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}if(!triggered)throw new Error('trigger-timeout');
        channel.dispose();channel=null;await terminals.close(terminal.id);terminal=null;await connections.closeConnection(connection.id);connection=null;await model.retry();let retried=false;for(let attempt=0;attempt<500;attempt++){if(model.getSnapshot().status==='ready'){retried=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}if(!retried)throw new Error('retry-timeout');setResult('done');
      }catch{channel?.dispose();if(terminal)await terminals.close(terminal.id).catch(()=>{});if(connection)await connections.closeConnection(connection.id).catch(()=>{});setResult('failed');}}},'Test automation'),React.createElement('pre',{ref:output,'data-automation-output':''}));
    });
  }};}});`;
  new Script(source);
  await writeFile(join(profile, 'node_modules/@fixture/frame/client.browser.js'), source);
}
