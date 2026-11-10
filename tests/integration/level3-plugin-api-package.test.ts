import { execFile } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it } from 'vitest';

const execute = promisify(execFile);

/** Read a small locally-produced SDK tarball; no production archive extraction uses this helper. */
function packageEntries(bytes: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(bytes, { maxOutputLength: 4 * 1024 * 1024 });
  const files = new Map<string, Buffer>();
  const string = (start: number, length: number) =>
    tar
      .subarray(start, start + length)
      .toString('utf8')
      .split('\0')[0]!;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = string(offset, 100);
    if (!name) break;
    const prefix = string(offset + 345, 155);
    const path = prefix ? prefix + '/' + name : name;
    const size = Number.parseInt(string(offset + 124, 12).trim(), 8) || 0;
    if (tar[offset + 156] === 0 || tar[offset + 156] === 48)
      files.set(path, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

let fixture: { root: string; environment: NodeJS.ProcessEnv; uiFiles: Map<string, Buffer> };
let cleanupRoot: string | undefined;
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-sdk-package-'));
  cleanupRoot = root;

  const packed = join(root, 'packed');
  await mkdir(packed);
  await execute(
    process.execPath,
    [
      resolve('node_modules/pnpm/bin/pnpm.cjs'),
      '--filter',
      '@axterm/plugin-api',
      '--filter',
      '@axterm/ui',
      '--filter',
      '@axterm/engine-api',
      'pack',
      '--pack-destination',
      packed,
    ],
    { cwd: resolve('.'), timeout: 8000, maxBuffer: 256 * 1024 },
  );
  const archive = (await readdir(packed)).find(
    (name) => name.includes('plugin-api') && name.endsWith('.tgz'),
  )!;
  const files = packageEntries(await readFile(join(packed, archive)));
  const manifest = JSON.parse(files.get('package/package.json')!.toString('utf8'));
  expect(manifest.name).toBe('@axterm/plugin-api');
  expect(manifest.private).toBe(false);
  expect(manifest.license).toBe('(MIT AND Apache-2.0)');
  expect(manifest.peerDependencies['@deepseek-ai/cordis']).not.toContain('workspace:');
  expect(Object.keys(manifest.dependencies)).toEqual(['zod']);
  for (const required of [
    'lib/index.js',
    'lib/brand.js',
    'lib/credentials.js',
    'lib/subprocess.js',
    'lib/types/subprocess.d.ts',
    'lib/types/host/subprocess.d.ts',
    'lib/saved-credentials.js',
    'lib/types/saved-credentials.d.ts',
    'lib/types/host/saved-credentials.d.ts',
    'lib/types/credentials.d.ts',
    'lib/types/host/credentials.d.ts',
    'lib/storage.js',
    'lib/terminals.js',
    'lib/desktop.js',
    'lib/catalog.js',
    'lib/configuration.js',
    'lib/ai.js',
    'lib/types/ai.d.ts',
    'lib/configuration-sync.js',
    'lib/types/configuration-sync.d.ts',
    'lib/types/schemas/axterm-sync.d.ts',
    'lib/configuration-portable.js',
    'lib/types/configuration-portable.d.ts',
    'lib/types/schemas/axterm-configuration.d.ts',
    'lib/connections.js',
    'lib/files.js',
    'lib/transfers.js',
    'lib/types/transfers.d.ts',
    'lib/types/host/transfers.d.ts',
    'lib/types/files.d.ts',
    'lib/types/host/files.d.ts',
    'lib/types/host/remote-files.d.ts',
    'lib/types/catalog.d.ts',
    'lib/types/configuration.d.ts',
    'lib/types/connections.d.ts',
    'lib/types/schemas/command-history.d.ts',
    'lib/types/schemas/terminal-themes.d.ts',
    'lib/types/storage.d.ts',
    'lib/types/index.d.ts',
    'lib/types/brand.d.ts',
    'LICENSE',
    'LICENSE.AXTERM',
    'SOURCE.json',
  ])
    expect(files.has('package/' + required)).toBe(true);
  expect(files.get('package/LICENSE')!.toString('utf8')).toContain('Copyright (c) 2026 DeepSeek');
  expect(files.get('package/LICENSE.AXTERM')!.toString('utf8')).toBe(
    await readFile('LICENSE', 'utf8'),
  );
  expect(JSON.parse(files.get('package/SOURCE.json')!.toString('utf8')).firstParty.license).toBe(
    'Apache-2.0',
  );
  expect(
    [...files.keys()].some(
      (name) =>
        name.includes('/src/') ||
        name.includes('/node_modules/') ||
        /\/lib\/types\/.*\.js$/.test(name),
    ),
  ).toBe(false);
  const sdk = join(root, 'node_modules/@axterm/plugin-api');
  for (const [name, bytes] of files) {
    const relative = name.slice('package/'.length);
    if (!name.startsWith('package/') || relative.split('/').includes('..'))
      throw new Error('Unexpected SDK archive path');
    const destination = join(sdk, relative);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  const uiArchive = (await readdir(packed)).find(
    (name) => name.includes('axterm-ui-') && name.endsWith('.tgz'),
  )!;
  const uiFiles = packageEntries(await readFile(join(packed, uiArchive)));
  const uiManifest = JSON.parse(uiFiles.get('package/package.json')!.toString('utf8'));
  expect(uiManifest.private).toBe(false);
  expect(uiManifest.license).toBe('(MIT AND Apache-2.0)');
  expect(uiFiles.get('package/LICENSE.AXTERM')!.toString()).toBe(await readFile('LICENSE', 'utf8'));
  expect(JSON.parse(uiFiles.get('package/SOURCE.json')!.toString()).firstParty.license).toBe(
    'Apache-2.0',
  );
  expect(uiManifest.dependencies).toEqual({
    '@axterm/plugin-api': '0.10.0',
    'radix-ui': '1.8.1',
    'class-variance-authority': '0.7.1',
  });
  expect(uiFiles.get('package/lib/controls.js')!.toString()).not.toMatch(
    /from\s+["']\\0?axterm-css:|axterm-level3|\/Volumes\//,
  );
  for (const name of ['lib/controls.js', 'lib/types/client/controls.d.ts'])
    expect(uiFiles.has('package/' + name)).toBe(true);
  for (const [name, bytes] of uiFiles) {
    const relative = name.slice('package/'.length);
    if (!name.startsWith('package/') || relative.split('/').includes('..'))
      throw new Error('Unexpected UI SDK archive path');
    if (relative.endsWith('.d.ts')) {
      expect(bytes.toString()).not.toMatch(/@axterm\/infra-|node:/);
    }
    const destination = join(root, 'node_modules/@axterm/ui', relative);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  const engineArchive = (await readdir(packed)).find(
    (name) => name.includes('engine-api') && name.endsWith('.tgz'),
  )!;
  const engineFiles = packageEntries(await readFile(join(packed, engineArchive)));
  const engineManifest = JSON.parse(engineFiles.get('package/package.json')!.toString());
  expect(engineManifest.name).toBe('@axterm/engine-api');
  expect(engineManifest.private).toBe(false);
  expect(engineManifest.license).toBe('Apache-2.0');
  expect(engineManifest.peerDependencies['@deepseek-ai/cordis']).not.toContain('workspace:');
  expect(engineManifest.dependencies).toEqual({ zod: '4.4.3' });
  expect(engineFiles.get('package/LICENSE')!.toString()).toBe(await readFile('LICENSE', 'utf8'));
  for (const required of [
    'lib/index.js',
    'lib/host.js',
    'lib/types/index.d.ts',
    'lib/types/host/index.d.ts',
    'README.md',
    'SOURCE.json',
  ])
    expect(engineFiles.has('package/' + required)).toBe(true);
  for (const [name, bytes] of engineFiles) {
    const relative = name.slice('package/'.length);
    if (
      !name.startsWith('package/') ||
      relative.split('/').includes('..') ||
      /(?:^|\/)src\//.test(relative)
    )
      throw new Error('Unexpected Engine SDK archive path');
    expect(bytes.toString()).not.toMatch(/@axterm\/infra-|@workspace\/|axterm-level3|\/Volumes\//);
    const destination = join(root, 'node_modules/@axterm/engine-api', relative);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  // Supply only built framework artifacts and declared third-party dependencies, without repository links.
  for (const name of ['cordis', 'cosmokit']) {
    const source = resolve('packages/framework', name);
    const target = join(root, 'node_modules/@deepseek-ai', name);
    await mkdir(target, { recursive: true });
    await cp(join(source, 'lib'), join(target, 'lib'), { recursive: true });
    await cp(join(source, 'package.json'), join(target, 'package.json'));
    await cp(join(source, 'LICENSE'), join(target, 'LICENSE'));
  }
  for (const [name, location] of [
    ['zod', 'packages/api/plugin-api/node_modules/zod'],
    ['react', 'apps/web/node_modules/react'],
    ['@types/react', 'packages/api/ui/node_modules/@types/react'],

    ['@standard-schema/spec', 'packages/framework/cordis/node_modules/@standard-schema/spec'],
  ])
    await cp(await realpath(location!), join(root, 'node_modules', name!), { recursive: true });
  const reactTypes = await realpath('packages/api/ui/node_modules/@types/react');
  for (const name of ['csstype', '@types/prop-types']) {
    const dependency = dirname(
      createRequire(join(reactTypes, 'package.json')).resolve(`${name}/package.json`),
    );
    await cp(dependency, join(root, 'node_modules', name), { recursive: true });
  }
  // Preserve the actual dependency graph, including different nested versions, entirely
  // inside the independent consumer. No link points back to the source checkout/store.
  const copied = new Map<string, string>([
    [await realpath('apps/web/node_modules/react'), join(root, 'node_modules/react')],
    [await realpath('apps/web/node_modules/react-dom'), join(root, 'node_modules/react-dom')],
    [
      await realpath('packages/api/ui/node_modules/@types/react'),
      join(root, 'node_modules/@types/react'),
    ],
    [
      await realpath('packages/api/ui/node_modules/@types/react-dom'),
      join(root, 'node_modules/@types/react-dom'),
    ],
  ]);
  async function copyDependency(name: string, from: string, modules: string): Promise<void> {
    let manifestPath: string;
    const require = createRequire(join(from, 'package.json'));
    try {
      manifestPath = require.resolve(name + '/package.json');
    } catch {
      let directory = dirname(require.resolve(name));
      for (;;) {
        try {
          const candidate = join(directory, 'package.json');
          if (JSON.parse(await readFile(candidate, 'utf8')).name === name) {
            manifestPath = candidate;
            break;
          }
        } catch {
          // Continue toward the owning manifest when an exported entry is nested.
        }
        const parent = dirname(directory);
        if (parent === directory) throw new Error('Missing dependency manifest: ' + name);
        directory = parent;
      }
    }
    const source = await realpath(dirname(manifestPath));
    let target = copied.get(source);
    const fresh = !target;
    if (!target) {
      target = join(root, 'node_modules/.sdk-closure', String(copied.size));
      copied.set(source, target);
      await cp(source, target, { recursive: true });
    }
    const link = join(modules, name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(
      relative(dirname(link), target),
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    if (!fresh) return;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await copyDependency(dependency, source, join(target, 'node_modules'));
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      if (Object.hasOwn(manifest.dependencies ?? {}, dependency)) continue;
      try {
        await copyDependency(dependency, source, join(target, 'node_modules'));
      } catch (error) {
        if (!manifest.peerDependenciesMeta?.[dependency]?.optional) throw error;
      }
    }
  }
  for (const name of ['radix-ui', 'class-variance-authority'])
    await copyDependency(name, resolve('packages/api/ui'), join(root, 'node_modules'));
  await cp(
    await realpath('apps/web/node_modules/react-dom'),
    join(root, 'node_modules/react-dom'),
    { recursive: true },
  );
  const reactDomRequire = createRequire(resolve('apps/web/node_modules/react-dom/package.json'));
  for (const name of ['scheduler', 'loose-envify'])
    await copyDependency(
      name,
      dirname(reactDomRequire.resolve('react-dom/package.json')),
      join(root, 'node_modules'),
    );
  await cp(
    await realpath('packages/api/ui/node_modules/@types/react-dom'),
    join(root, 'node_modules/@types/react-dom'),
    { recursive: true },
  );
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'independent-sdk-consumer', private: true, type: 'module' }),
  );
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        skipLibCheck: false,
        types: [],
        lib: ['ES2024', 'DOM'],
        outDir: 'build',
      },
      include: ['consumer.ts'],
    }),
  );
  await writeFile(
    join(root, 'consumer.ts'),
    `
    import {Remote,remoteMethods,brandString,type Branded} from '@axterm/plugin-api';
    import {engineRunInputSchema,engineEventSchema,EngineError,type EngineDescriptor} from '@axterm/engine-api';
    const engineInput=engineRunInputSchema.parse({runId:'run',providerId:'configured',model:'model',system:'visible',prompt:'hello',context:''});
    if(engineInput.tools!==false || engineEventSchema.safeParse({type:'thinking',text:'hidden'}).success || new EngineError('missing').code!=='missing')throw new Error('Engine SDK contract mismatch');
    function rejectClientEngine(ctx:import('@deepseek-ai/cordis').Context){
      // @ts-expect-error Client contracts do not expose Host execution services.
      return ctx.engines;
    }
    void rejectClientEngine;
    function rejectClientPackageExecution(ctx:import('@deepseek-ai/cordis').Context){
      // @ts-expect-error Browser contracts do not expose Profile package execution.
      return ctx.pluginManager;
    }
    void rejectClientPackageExecution;
    import type {PluginInspection,PendingPluginBuild} from '@axterm/plugin-api/plugins';
    const inspectedPlugin:PluginInspection={manifest:{name:'external-sdk',version:'1.0.0'},spec:'external-sdk@1.0.0'};
    const pendingBuild:PendingPluginBuild={id:'opaque',name:'external-sdk',version:'1.0.0'};void inspectedPlugin;void pendingBuild;
    const descriptors:EngineDescriptor[]=[];void descriptors;

    import {defineDomain as rootDomain,StorageError as RootStorageError} from '@axterm/plugin-api';
    import {defineDomain,StorageError} from '@axterm/plugin-api/storage';
    import {createTerminalSchema} from '@axterm/plugin-api/terminals';
    import type {TerminalCommandOutcome} from '@axterm/plugin-api/terminals';
    import type {ConnectionClientActions,ConnectionCommandOutcome} from '@axterm/plugin-api/connections';
    import type {ConfigurationClientActions} from '@axterm/plugin-api/configuration';
    import type {TransferClientActions} from '@axterm/plugin-api/transfers';
    import type {CatalogClientActions,CreateSshBookmarkInput} from '@axterm/plugin-api/catalog';
    import type {AiRunCommandOutcome} from '@axterm/plugin-api/ai';
    import type {ConnectionWorkspaceUi} from '@axterm/ui/workspace';
    function publicWorkspaceOwners(ctx:import('@deepseek-ai/cordis').Context){
      const settings:ConfigurationClientActions=ctx.configurationActions;
      const catalog:CatalogClientActions=ctx.catalogActions;
      const runOutcome:AiRunCommandOutcome={status:'accepted',id:'opaque'};
      function saveReviewed(input:CreateSshBookmarkInput){return catalog.createSshBookmark('key',input,'"v1"');}
      // @ts-expect-error Selected Catalog capability does not expose private model commands.
      catalog.deleteHost('key','id','v1');
      void saveReviewed;void runOutcome;
      const connections:ConnectionClientActions=ctx.connectionActions;
      const workspace:ConnectionWorkspaceUi=ctx.connectionWorkspaceUi;
      const terminalOutcome:TerminalCommandOutcome={status:'pending'};
      const connectionOutcome:ConnectionCommandOutcome={status:'accepted',id:'opaque'};
      void settings.setConnectionHistoryEnabled('explicit-key',true,'"v1"');
      void settings.setDefaultTerminalProfile('explicit-key',null,'"v1"');
      void settings.setFileManagerPreferences('explicit-key',{showHiddenFiles:true},'"v1"');
      void connections.listFtpConnections();
      const transfers:TransferClientActions=ctx.transferActions;
      void transfers.clearCompleted('explicit-key');
      void connections.getCommandOutcome('generation','explicit-key');
      void workspace.openHistory('history-id',{},'"v1"');
      // @ts-expect-error Internal Configuration model methods are not public capabilities.
      settings.updateSettings('key',{},'"v1"');
      return [terminalOutcome,connectionOutcome];
    }
    void publicWorkspaceOwners;

    import {previewFileRenameSchema,renameBaselineSchema} from '@axterm/plugin-api/automation';
    if(previewFileRenameSchema.parse({grantId:'public-grant'}).template!=='{name}-{n}.{ext}' || !renameBaselineSchema)throw new Error('Rename SDK contract mismatch');
    import type {TypertResource,TypertResourceId,TypertResourceKind,TypertResourceMap} from '@axterm/plugin-api';
    declare module '@axterm/plugin-api' {interface TypertResourceMap {externalSdk:TypertResource<number>}}
    const terminalId:TypertResourceId<TypertResourceMap['terminal']>='terminal-one';
    const externalId:TypertResourceId<TypertResourceMap['externalSdk']>=1;
    const resourceKinds:TypertResourceKind[]=['terminal','externalSdk'];
    // @ts-expect-error Terminal and independently augmented resources retain separate id types.
    const wrongTerminal:TypertResourceId<TypertResourceMap['terminal']>=externalId;
    if(createTerminalSchema.parse({kind:'local',cols:80,rows:24}).cols!==80 || !terminalId || resourceKinds.length!==2)throw new Error('Terminal SDK contract mismatch');
    import {credentialRef,credentialKey,parseCredentialKey,credentialKeyScope,credentialKeyId,encodeOpaqueCredentialRef,decodeOpaqueCredentialRef,type CredentialRef,type CredentialKey} from '@axterm/plugin-api/credentials';
    const credential=credentialRef('PUBLIC_API_KEY');const record=credentialKey('external-plugin','account');
    // @ts-expect-error Reference and record addresses retain distinct nominal identities.
    const wrongRef:CredentialRef=record;
    // @ts-expect-error No ordinary string is a validated record address.
    const wrongKey:CredentialKey='external-plugin/account';
    if(credential!=='PUBLIC_API_KEY' || parseCredentialKey(record)!==record || credentialKeyScope(record)!=='external-plugin' || credentialKeyId(record)!=='account')throw new Error('Credential SDK identity mismatch');
    if(decodeOpaqueCredentialRef(encodeOpaqueCredentialRef('cred_opaque-original'))!=='cred_opaque-original')throw new Error('Opaque mapping changed');
    void wrongRef;void wrongKey;
    function rejectClientResolution(ctx:import('@deepseek-ai/cordis').Context){
      // @ts-expect-error The Client face does not opt into Host credential resolution.
      return ctx.credentials;
    }
    void rejectClientResolution;
    import {AXTERM_ENV_PREFIX,SubprocessExecutableNotFoundError} from '@axterm/plugin-api/subprocess';
    if(AXTERM_ENV_PREFIX!=='AXTERM_' || new SubprocessExecutableNotFoundError().name!=='SubprocessExecutableNotFoundError')throw new Error('Subprocess SDK identity mismatch');
    function rejectClientSubprocess(ctx:import('@deepseek-ai/cordis').Context){
      // @ts-expect-error Browser consumers cannot opt into Host process execution.
      return ctx.subprocess;
    }
    void rejectClientSubprocess;
    import {z} from 'zod';
    import {SlotCore,type Slots} from '@axterm/ui';
    import {Button,Input,Dialog,Select,Tabs,Tooltip,controlsCssText,type ButtonProps,type DialogContentProps,type SelectItemProps} from '@axterm/ui/controls';
    import {createElement} from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
    const buttonProps:ButtonProps={variant:'primary',size:'small','aria-label':'SDK button'};
    const dialogProps:DialogContentProps={closeLabel:'Close'}; const itemProps:SelectItemProps={value:'sdk'};
    const markup=renderToStaticMarkup(createElement(Button,buttonProps,'SDK button'));
    if(!markup.includes('SDK button') || !controlsCssText.includes('--ax-color-primary') || !Input || !Dialog || !Select || !Tabs || !Tooltip || !dialogProps.closeLabel || !itemProps.value)throw new Error('Public controls missing');
    // @ts-expect-error Public variants reject unknown styles.
    const invalidButton:ButtonProps={variant:'invented'};
    void invalidButton;
    import type {LocaleService,ThemeService,PresentationPreferencePort} from '@axterm/ui/presentation';
    declare module '@axterm/ui' {interface LocaleNamespaceMap {'sdk.presentation':'greeting'}}
    function consumePresentation(locale:LocaleService,theme:ThemeService){
      const remove=locale.register('sdk.presentation',{en:{greeting:'Hello'},ja:{greeting:'こんにちは'},'zh-CN':{greeting:'你好'},'zh-TW':{greeting:'您好'}});
      const t=locale.bind('sdk.presentation');const greeting:string=t('greeting');
      // @ts-expect-error The selected namespace retains its dictionary key union.
      t('unknown');
      // @ts-expect-error Typed registrations require all four product languages.
      locale.register('sdk.presentation',{en:{greeting:'Hello'}});
      const port:PresentationPreferencePort<string>={getSnapshot:()=>({available:true,value:'dark'}),subscribe:()=>()=>{},write:async()=>{}};
      const detach=theme.attachPreference(port);void detach;remove();return greeting;
    }
    void consumePresentation;


    import type {Context} from '@deepseek-ai/cordis';
    import type { WorkspaceUi, WorkspaceSessionOwner } from '@axterm/ui/workspace';
    function consumeWorkspace(ctx:Context, view:WorkspaceSessionOwner){const ui:WorkspaceUi=ctx.workspaceUi;return {active:ui.getSnapshot().activeTabId===view.tabId};}
    void consumeWorkspace;
    import type {ObservableSnapshot} from '@axterm/plugin-api';
    import type {ObservableSnapshot as UiObservable} from '@axterm/ui/store-contract';
    const source:ObservableSnapshot<boolean>={getSnapshot:()=>true,subscribe:()=>()=>{}};
    const uiSource:UiObservable<boolean>=source;
    const core=new SlotCore(); core.register({name:'root'},()=>null);
    if(core.entries('root').length!==1 || !uiSource.getSnapshot())throw new Error('UI SDK contract mismatch');
    function registerExternalUi(ctx:Context){const slots:Slots=ctx.slots;return slots.register({name:'root'},()=>null);}
    void registerExternalUi;
    const domain=defineDomain({owner:'fixture',name:'settings',version:1,tables:{},global:{schema:z.object({title:z.string()}),initial:{title:'ready'}}});
    if(defineDomain!==rootDomain || StorageError!==RootStorageError || domain.global.initial.title!=='ready')throw new Error('Storage SDK identity mismatch');
    const relational=defineDomain({kind:'relational',owner:'fixture',name:'facts',version:1,tables:['facts'],migrations:[{version:1,sql:'CREATE TABLE facts(id TEXT)'}]});
    if(relational.kind!=='relational')throw new Error('Relational SDK declaration mismatch');
    import {idSchema as catalogId, createHostSchema, type CatalogBaseline} from '@axterm/plugin-api/catalog';
    import {idSchema as terminalIdSchema} from '@axterm/plugin-api/terminals';
    import {settingsSchema} from '@axterm/plugin-api/configuration';
    import {syncProfileInputSchema,syncRunReceiptSchema,type SyncBaseline} from '@axterm/plugin-api/configuration-sync';
    const sync:SyncBaseline={generation:'fixture',cursor:0,profiles:[],runs:[]};
    if(!syncProfileInputSchema || !syncRunReceiptSchema || sync.profiles.length)throw new Error('Sync SDK contract mismatch');
    if(catalogId!==terminalIdSchema || !createHostSchema.safeParse({name:'Independent',hostname:'fixture.example',username:'operator'}).success || !settingsSchema)throw new Error('Catalog SDK identity mismatch');
    type IndependentCatalogHost = CatalogBaseline['hosts'][number];
    const catalogHostName: IndependentCatalogHost['name'] = 'Public Host';
    if(!catalogHostName)throw new Error('Missing public Catalog type');
    import {createConnectionSchema,connectionInteractionResponseSchema,createFtpConnectionSchema} from '@axterm/plugin-api/connections';
    import type {TypertRemoteEvent} from '@axterm/plugin-api';
    declare module '@deepseek-ai/cordis' {interface Events {'fixture/external-sdk'():void}}
    declare module '@axterm/plugin-api' {interface TypertRemoteEventSelection {'fixture/external-sdk':true}}
    const connectionResource:TypertResourceKind='connection';
    const publicEvents:TypertRemoteEvent[]=['connections/history-recording-failed','fixture/external-sdk'];
    if(!createConnectionSchema.safeParse({target:{hostname:'fixture.example',username:'operator'}}).success || !connectionInteractionResponseSchema.safeParse({accepted:false}).success || !connectionResource || publicEvents.length!==2)throw new Error('Connection SDK contract mismatch');
    import {terminalProfileInputSchema,commandHistoryPageQuerySchema,terminalThemeInputSchema,DEFAULT_TERMINAL_APPEARANCE as terminalDefault} from '@axterm/plugin-api/terminals';
    const ftpInput=createFtpConnectionSchema.parse({bookmarkId:'11111111-1111-4111-8111-111111111111'});
    if(!ftpInput.bookmarkId)throw new Error('FTP SDK contract mismatch');
    import {DEFAULT_TERMINAL_APPEARANCE as connectionDefault} from '@axterm/plugin-api/connections';
    const factKinds:TypertResourceKind[]=['terminalProfile','terminalTheme','commandHistory'];
    if(terminalDefault!==connectionDefault || terminalProfileInputSchema.parse({name:'SDK profile'}).fontSize!==16 || commandHistoryPageQuerySchema.parse({limit:1}).limit!==1 || !terminalThemeInputSchema || factKinds.length!==3)throw new Error('Terminal facts SDK contract mismatch');
    import {fileGrantRequestSchema,grantedDirectoryPathSchema,grantedEntryCreateRequestSchema,type FileGrant,type GrantedEntryCreate} from '@axterm/plugin-api/files';
    const fileKind:TypertResourceKind='fileGrant';
    const fileId:FileGrant['grantId']='public-grant';
    const createdEntry:GrantedEntryCreate={name:'SDK file',type:'file'};
    if(grantedEntryCreateRequestSchema.parse(createdEntry).path!=='')throw new Error('File input defaults mismatch');
    if(!fileGrantRequestSchema.safeParse({kind:'open-file'}).success || grantedDirectoryPathSchema.safeParse('../escape').success || !fileKind || !fileId)throw new Error('File SDK contract mismatch');
    import {brandString as subpathBrand,type Branded as SubpathBranded} from '@axterm/plugin-api/brand';
    type Id=Branded<'public-id'>;
    const value=brandString<Id>('one');const same:SubpathBranded<'public-id'>=value;
    // @ts-expect-error Different public brands must remain non-interchangeable.
    const wrong:Branded<'other-id'>=value;
    class Probe{@Remote echo(input:Id):Id{return input;}}
    const probe=new Probe();
    if(brandString!==subpathBrand || probe.echo(same)!=='one' || remoteMethods(probe)[0]?.method!=='echo')throw new Error('SDK identity mismatch');
    import {aiProviderInputSchema,aiRunSchema,type AiProvider} from '@axterm/plugin-api/ai';
    const aiProvider=aiProviderInputSchema.parse({name:'Imported',baseUrl:'http://127.0.0.1:1234',credentialRef:'REFERENCE_ONLY',enabled:true});
    const engine:AiProvider['engineId']=aiProvider.engineId;
    if(engine!=='pi' || aiProviderInputSchema.safeParse({...aiProvider,apiKey:'literal'}).success)throw new Error('AI public contract mismatch');
    void aiRunSchema;
    console.log('independent-sdk-ok');
  `,
  );
  const environment = {
    ...process.env,
    NODE_PATH: '',
    NODE_OPTIONS: '',
    AXTERM_HOME: join(root, 'home'),
  };

  const nodeTypes = await realpath('node_modules/@types/node');
  await cp(nodeTypes, join(root, 'node_modules/@types/node'), { recursive: true });
  const undiciTypes = dirname(
    createRequire(join(nodeTypes, 'package.json')).resolve('undici-types/package.json'),
  );
  await cp(undiciTypes, join(root, 'node_modules/undici-types'), { recursive: true });
  await writeFile(
    join(root, 'host-consumer.ts'),
    `
      import type { Context } from '@deepseek-ai/cordis';
      import type {PluginManagerService} from '@axterm/plugin-api/host';
      function selectedPackageOwner(ctx:Context){
        const manager:PluginManagerService=ctx.pluginManager;
        void manager.list();
        // @ts-expect-error Shared-service shutdown is not a consumer capability.
        manager.close();
      }
      void selectedPackageOwner;
      import type {EngineProvider,EnginesService} from '@axterm/engine-api/host';
      import {engineExecutionOptionsSchema,type EngineExecutionOptions} from '@axterm/engine-api';
      import {engineRunInputSchema} from '@axterm/engine-api';
      async function consumeEngine(ctx:Context){
        const engines:EnginesService=ctx.engines;
        const provider:EngineProvider={label:'Independent engine',capabilities:{cancellation:true,tools:false,resume:false},openSession:async()=>({run:async(input,context)=>{context.signal.throwIfAborted();await context.emit({type:'delta',text:input.prompt});await context.emit({type:'completed'});},close:async()=>{}})};
        const remove=engines.register('independent',provider);
        const stop=ctx.on('engines/changed',(id:string)=>{void id;});
        const session=await engines.openSession('independent',{sessionId:'app-session'},new AbortController().signal);
        try {const run=session.run(engineRunInputSchema.parse({runId:'app-run',providerId:'configured',model:'model',system:'',prompt:'visible',context:''}),{event:async()=>{}});await run.done;const options:EngineExecutionOptions=engineExecutionOptionsSchema.parse({configuration:{credentialRef:'PUBLIC_REFERENCE'}});await session.run(engineRunInputSchema.parse({runId:'bound-app-run',providerId:'configured',model:'model',system:'',prompt:'visible',context:''}),{event:async()=>{}},options).done;} finally {await session.close();await remove();stop();}
      }
      void consumeEngine;
      import type {SubprocessService,SubprocessHandle,SubprocessTerminalHandle} from '@axterm/plugin-api/host';
      async function consumeSubprocess(ctx:Context,signal:AbortSignal){
        const service:SubprocessService=ctx.subprocess;
        const executable=await service.resolveExecutable('configured-program',undefined,signal);
        const child:SubprocessHandle=service.spawn({argv:[executable],windowsVerbatimArguments:false,cwd:'/owned-workspace',graceMs:1000,signal,stdio:{stdin:'ignore',stdout:{maxBytes:1024},stderr:{maxBytes:1024}}});
        try{await child.done;child.collected.stdout?.readFrom(0);}finally{await child.dispose();}
        const terminal:SubprocessTerminalHandle=await service.spawnTerminal({argv:[executable],cwd:'/owned-workspace',rows:24,cols:80,terminalType:'xterm',graceMs:1000,signal,binary:true});
        try{await terminal.write(new Uint8Array([1]));}finally{await terminal.terminate();}
      }
      void consumeSubprocess;
      function consumeWorkspace(ctx:Context,id:string){
        const text:string=ctx.terminals.recentOutput(id);const cwd:string|null=ctx.terminals.workingDirectory(id);
        const target=ctx.connections.executionTarget(id);const generation:number=target.generation;
        void text;void cwd;void generation;
      }
      void consumeWorkspace;

      import type { ConnectionsApplication, RemoteFileLease, CredentialsService } from '@axterm/plugin-api/host';
      import {credentialRef,credentialKey,type CredentialRecord,type CredentialRef} from '@axterm/plugin-api/credentials';
      async function consumeCredentials(ctx:Context){
        const saved:import('@axterm/plugin-api/host').SavedCredentialsService|undefined=ctx.credentials.saved;
        if(saved){const items=await saved.list();const metadata:readonly import('@axterm/plugin-api/saved-credentials').SavedCredentialMetadata[]=items;void metadata;}
        const credentials:CredentialsService=ctx.credentials;const ref=credentialRef('PUBLIC_API_KEY');
        const stop=ctx.on('credentials/reference-updated',(changed:CredentialRef)=>{void changed;});
        await credentials.set(ref,'host-only-fixture');
        const resolved=await credentials.resolve(ref);const info=await credentials.describe(ref);
        const key=credentialKey('external-plugin','account');
        await credentials.modifyRecord(key,async(current:CredentialRecord|undefined)=>current??{kind:'api-key',key:'host-only-fixture'});
        await credentials.readRecord(key);await credentials.describeRecord(key);await credentials.listRecords();
        await credentials.deleteRecord(key);await credentials.unset(ref);stop();return {configured:info.configured,source:resolved?.source};
      }
      void consumeCredentials;
      import type { RemoteFileTarget } from '@axterm/plugin-api/files';
      import { remoteDesktopSessionSchema } from '@axterm/plugin-api/remote-desktop';
      import { quickCommandTreeSchema } from '@axterm/plugin-api/automation';
      async function consume(ctx: Context, target: RemoteFileTarget, signal: AbortSignal) {
        const local = await ctx.files.open('fixture-grant', 'read', signal);
        try { const source = await local.read(local.path); source.destroy(); }
        finally { await local.close(); }
        const task = ctx.transfers.create(crypto.randomUUID(), { direction: 'upload', target, grantId: 'fixture-grant', remotePath: '/target' });
        const metadata = ctx.transfers.get(task.id);
        ctx.transfers.cancel(crypto.randomUUID(), metadata.id);
        const owner: ConnectionsApplication = ctx.connections;
        const profiles = owner.listTunnelProfiles();
        const tunnels = owner.listTunnels();
        void profiles; void tunnels;
        const route = await owner.openStream({ target: { host: '127.0.0.1', port: 3389 }, proxy: { mode: 'direct' }, username: '', jumpHostId: null, timeoutMs: 1000 }, signal);
        route.stream.destroy(); await route.close();
        void remoteDesktopSessionSchema;
        const commands = ctx.automation.getQuickCommands(); quickCommandTreeSchema.parse(commands);
        const remove = ctx.terminals.addOutputObserver({ receive() {}, closed() {} }); remove();
        const ports = await owner.listSerialPorts();
        void ports;
        const lease: RemoteFileLease = await owner.openFiles(target, signal);
        try { return await lease.filesystem.stat('/'); }
        finally { await lease.close(); }
      }
      void consume;
    `,
  );
  await writeFile(
    join(root, 'tsconfig.host.json'),
    JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { types: ['node'], noEmit: true },
      include: ['host-consumer.ts'],
    }),
  );

  await writeFile(
    join(root, 'leaf-consumer.ts'),
    `
      import {PresentationPreference,type PresentationPreferencePort} from '@axterm/ui/preference';
      import {EngineError,engineRunInputSchema} from '@axterm/engine-api';
      import {SubprocessExecutableNotFoundError,AXTERM_ENV_PREFIX} from '@axterm/plugin-api/subprocess';
      void SubprocessExecutableNotFoundError;void AXTERM_ENV_PREFIX;
      void EngineError;void engineRunInputSchema;
      const state={available:true,value:'en'};
      const port:PresentationPreferencePort<string>={getSnapshot:()=>state,subscribe:()=>()=>{},write:async()=>{}};
      const binding=new PresentationPreference<string>(()=>{});const stop=binding.attach(port);
      void stop;
    `,
  );
  await writeFile(
    join(root, 'tsconfig.leaf.json'),
    JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { types: ['node'], lib: ['ES2024'], noEmit: true },
      include: ['leaf-consumer.ts'],
    }),
  );

  fixture = { root, environment, uiFiles };
});
afterAll(async () => {
  if (cleanupRoot) await rm(cleanupRoot, { recursive: true, force: true });
});

async function compile(name: string): Promise<void> {
  const { root, environment } = fixture;
  await execute(
    process.execPath,
    [resolve('node_modules/typescript/bin/tsc'), '-p', join(root, name)],
    { cwd: root, env: environment, timeout: 8000, maxBuffer: 256 * 1024 },
  ).catch((error: unknown) => {
    const details = error as { stdout?: string; stderr?: string };
    throw new Error(
      'Independent SDK compilation failed: ' + (details.stdout ?? '') + (details.stderr ?? ''),
      { cause: error },
    );
  });
}
it('distributes one canonical Remote/brand identity to a source-free independent browser consumer', async () => {
  const { root, environment } = fixture;
  await compile('tsconfig.json');
  const { stdout } = await execute(process.execPath, [join(root, 'build/consumer.js')], {
    cwd: root,
    env: environment,
    timeout: 4000,
    maxBuffer: 256 * 1024,
  });
  expect(stdout.trim()).toBe('independent-sdk-ok');
});
it('exposes selected Host service contracts to a strict independent Host consumer', async () => {
  await compile('tsconfig.host.json');
});
it('loads framework-free SDK leaves without React, DOM or Host resolution capabilities', async () => {
  await compile('tsconfig.leaf.json');
  expect(fixture.uiFiles.get('package/lib/preference.js')!.toString()).not.toMatch(/^import\s/m);
});
