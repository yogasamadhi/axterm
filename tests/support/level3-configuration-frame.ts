import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { installTerminalFrameFixture } from './level3-terminal-frame.ts';
/** Packaged model/carrier probe only; the actual Settings UI is validated separately. */
export async function installConfigurationFrameFixture(home: string): Promise<void> {
  await installTerminalFrameFixture(home);
  const profile = join(home, 'profiles/desktop');
  const path = join(profile, 'package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.axterm.profile.bundles.push(
    '@axterm/bundle-catalog',
    '@axterm/bundle-configuration',
    '@axterm/bundle-connections',
    '@axterm/bundle-files',
    '@axterm/bundle-automation',
  );
  await writeFile(path, JSON.stringify(manifest));
  const frame = join(profile, 'node_modules/@fixture/frame');
  const packagePath = join(frame, 'package.json');
  const packageInfo = JSON.parse(await readFile(packagePath, 'utf8'));
  packageInfo.axterm.client.external.push('@axterm/plugin-api/catalog');
  await writeFile(packagePath, JSON.stringify(packageInfo));
  const source = `window.__ModuleLoader__.load({id:'@fixture/frame',factory(require){
    const React=require('react');const {hostSchema,createHostSchema}=require('@axterm/plugin-api/catalog');
    return {inject:['slots','configurationPortableModel'],apply(ctx){
      const model=ctx.configurationPortableModel;
      ctx.slots.register({name:'root'},function ConfigurationProbe(){
        const state=React.useSyncExternalStore(model.subscribe,model.getSnapshot);
        const [result,setResult]=React.useState('idle');
        const wait=async predicate=>{for(let count=0;count<120;count++){if(predicate())return;await new Promise(done=>setTimeout(done,25));}throw new Error('CONFIGURATION_PROBE_TIMEOUT');};
        return React.createElement('main',{'data-configuration-state':state.status,'data-configuration-result':result},
          React.createElement('button',{id:'configuration-roundtrip',onClick:async()=>{try{
            setResult('running');const contents=await model.exportDownload();const document=JSON.parse(await contents.text());
            if(document.format!=='axterm-configuration')throw new Error('INVALID_FORMAT');
            const id=crypto.randomUUID(),at=new Date().toISOString();
            document.data.hosts.push(hostSchema.parse({...createHostSchema.parse({name:'Packaged configuration',hostname:'packaged.example.test',username:'operator'}),id,createdAt:at,updatedAt:at,version:1}));
            const file=new Blob([JSON.stringify(document)],{type:'application/json'});
            const inspection=await model.inspectUpload(file);if(inspection.entityCount!==1)throw new Error('INVALID_INSPECTION');
            const preview=await model.previewUpload(file,false);if(!preview.canCommit)throw new Error('INVALID_PREVIEW');
            await wait(()=>{const state=model.getSnapshot();return state.status==='ready'&&state.baseline.previews.some(item=>item.previewId===preview.previewId);});
            await model.retry();await wait(()=>model.getSnapshot().status==='ready');
            const key=crypto.randomUUID(),first=await model.commit(key,preview.previewId),second=await model.commit(key,preview.previewId);
            if(first.counts.create!==1||JSON.stringify(first)!==JSON.stringify(second))throw new Error('INVALID_RECEIPT');
            const exported=JSON.parse(await(await model.exportDownload()).text());
            if(exported.data.hosts.length!==1||exported.data.hosts[0].id===id||exported.data.hosts[0].name!=='Packaged configuration')throw new Error('INVALID_REMAP');
            setResult('done');
          }catch{setResult('failed');}}},'Run configuration roundtrip'));
      });
    }};
  }});`;
  new Script(source);
  await writeFile(join(frame, 'client.browser.js'), source);
}
