import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
/** Test-only command controls. The real Workspace and interaction view remain installed. */
export async function installConnectionUiDriver(
  home: string,
  surface: 'web' | 'desktop',
  port: number,
): Promise<void> {
  const profile = join(home, 'profiles', surface);
  const bundle = join(profile, 'node_modules/@fixture/connection-ui-bundle');
  const driver = join(profile, 'node_modules/@fixture/connection-ui-driver');
  await mkdir(bundle, { recursive: true });
  await mkdir(driver, { recursive: true });
  const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
  await json(join(profile, 'package.json'), {
    name: 'isolated-connection-ui',
    private: true,
    dependencies: {
      '@fixture/connection-ui-bundle': '1.0.0',
      '@fixture/connection-ui-driver': '1.0.0',
    },
    axterm: {
      profile: {
        bundles: [...PROFILE_TEMPLATES[surface]!.bundles, '@fixture/connection-ui-bundle'],
      },
    },
  });
  await json(join(bundle, 'package.json'), {
    name: '@fixture/connection-ui-bundle',
    version: '1.0.0',
    axterm: { bundle: { patch: './patch.json' } },
  });
  await json(join(bundle, 'patch.json'), [
    { insert: [{ id: 'connection-ui-driver', name: '@fixture/connection-ui-driver' }] },
  ]);
  await json(join(driver, 'package.json'), {
    name: '@fixture/connection-ui-driver',
    version: '1.0.0',
    type: 'module',
    exports: {
      '.': './index.js',
      './client': { browser: './client.browser.js', default: './client.js' },
    },
    axterm: { client: { platform: 'web', immediately: true } },
  });
  await writeFile(join(driver, 'index.js'), 'export function apply(){}\n');
  await writeFile(join(driver, 'client.js'), 'export function apply(){}\n');
  await writeFile(
    join(driver, 'client.browser.js'),
    `window.__ModuleLoader__.load({id:'@fixture/connection-ui-driver',factory(require){const React=require('react');return {inject:['catalogModel','connectionsModel','terminalsModel','slots','workspaceUi','connectionWorkspaceUi'],apply(ctx){const model=ctx.connectionsModel;ctx.slots.inject('workspace.toolbar',function*(){yield ctx.slots.register({name:'workspace.toolbar',id:'fixture.connection-ui-driver',order:999},function Driver(){const state=React.useSyncExternalStore(model.subscribe,model.getSnapshot);const catalog=React.useSyncExternalStore(ctx.catalogModel.subscribe,ctx.catalogModel.getSnapshot);const history=catalog.status==='ready'?catalog.baseline.history.items.find(value=>value.hostname==='127.0.0.1'&&value.port===${port}):undefined;const[id,setId]=React.useState('');const[busy,setBusy]=React.useState(false);const[failed,setFailed]=React.useState(false);const[workspaceTerminal,setWorkspaceTerminal]=React.useState('');const[workspaceConnection,setWorkspaceConnection]=React.useState('');const current=state.status==='ready'?state.baseline.connections.find(value=>value.id===id):undefined;return React.createElement('div',{style:{display:'flex',alignItems:'center',gap:2,height:38,minWidth:0,width:226,maxWidth:226,flex:'0 0 226px'},'data-connection-ui-driver':'','data-opened-terminal':workspaceTerminal,'data-history-count':history?.count??0,'data-workspace-connection':workspaceConnection,'data-id':id,'data-state':state.status==='ready'?(current?.state??(id?'absent':'ready')):state.status,'data-busy':String(busy),'data-error':String(failed)},React.createElement('button',{type:'button',style:{flex:'0 0 36px',width:36,minWidth:0,maxWidth:36,height:30,padding:'0 4px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'},id:'connection-ui-create',disabled:busy||state.status!=='ready',onClick:()=>{setBusy(true);setFailed(false);void model.createConnection(crypto.randomUUID(),{target:{hostname:'127.0.0.1',port:${port},username:'fixture',authType:'keyboardInteractive'}}).then(value=>setId(value.id)).catch(()=>setFailed(true)).finally(()=>setBusy(false));}},'Connect SSH fixture'),React.createElement('button',{type:'button',style:{flex:'0 0 36px',width:36,minWidth:0,maxWidth:36,height:30,padding:'0 4px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'},id:'connection-ui-close',disabled:busy||!id,onClick:()=>{setBusy(true);setFailed(false);void model.closeConnection(id).catch(()=>setFailed(true)).finally(()=>setBusy(false));}},'Close SSH fixture'),React.createElement('button',{type:'button',style:{flex:'0 0 36px',width:36,minWidth:0,maxWidth:36,height:30,padding:'0 4px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'},id:'connection-ui-open-workspace',disabled:busy||state.status!=='ready',onClick:()=>{setBusy(true);setFailed(false);void ctx.connectionWorkspaceUi.openSsh({target:{hostname:'127.0.0.1',port:${port},username:'fixture',authType:'keyboardInteractive'}}).then(id=>{setWorkspaceTerminal(id);const facts=ctx.terminalsModel.getSnapshot();if(facts.status!=='ready')throw new Error('Missing admitted terminal');setWorkspaceConnection(facts.baseline.sessions.find(value=>value.id===id).connectionId);}).catch(()=>setFailed(true)).finally(()=>setBusy(false));}},'Open SSH workspace'),React.createElement('button',{type:'button',style:{flex:'0 0 36px',width:36,minWidth:0,maxWidth:36,height:30,padding:'0 4px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'},id:'connection-ui-open-history',disabled:busy||!history,onClick:()=>{setBusy(true);setFailed(false);setWorkspaceTerminal('');void ctx.connectionWorkspaceUi.openHistory(history.id,{},'"v'+history.version+'"').then(id=>{setWorkspaceTerminal(id);const facts=ctx.terminalsModel.getSnapshot();if(facts.status!=='ready')throw new Error('Missing admitted history terminal');setWorkspaceConnection(facts.baseline.sessions.find(value=>value.id===id).connectionId);}).catch(()=>setFailed(true)).finally(()=>setBusy(false));}},'Open history workspace'),React.createElement('button',{type:'button',style:{flex:'0 0 36px',width:36,minWidth:0,maxWidth:36,height:30,padding:'0 4px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'},id:'connection-ui-close-workspace',disabled:busy||!workspaceConnection,onClick:()=>{setBusy(true);setFailed(false);void model.closeConnection(workspaceConnection).then(()=>setWorkspaceConnection('')).catch(()=>setFailed(true)).finally(()=>setBusy(false));}},'Close SSH workspace'),React.createElement('button',{type:'button',style:{flex:'0 0 36px',width:36,minWidth:0,maxWidth:36,height:30,padding:'0 4px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'},id:'connection-ui-close-ready',disabled:busy,onClick:()=>{setBusy(true);void Promise.all((state.status==='ready'?state.baseline.connections:[]).filter(value=>value.state==='ready').map(value=>model.closeConnection(value.id))).catch(()=>setFailed(true)).finally(()=>setBusy(false));}},'Close ready fixture connections'));});});}};}});\n`,
  );
}
