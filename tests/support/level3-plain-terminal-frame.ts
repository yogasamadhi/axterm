import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { installTerminalFrameFixture } from './level3-terminal-frame.ts';

/** Artifact-only UI controls for actual Telnet bytes and native Serial enumeration. */
export async function installPlainTerminalFrameFixture(
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
  );
  await writeFile(path, JSON.stringify(manifest));
  const frame = join(profile, 'node_modules/@fixture/frame/client.browser.js');
  let source = await readFile(frame, 'utf8');
  source = source.replace(
    "'terminalsModel','connection'",
    "'terminalsModel','connection','catalogModel','connectionsModel'",
  );
  source = source.replace(
    'const [id,setId]=React.useState(null);',
    "const [id,setId]=React.useState(null);const [serialCount,setSerialCount]=React.useState('pending');const catalog=ctx.catalogModel;const catalogState=React.useSyncExternalStore(catalog.subscribe,catalog.getSnapshot);",
  );
  source = source.replace(
    "'data-terminal-probe':state.status",
    "'data-terminal-probe':state.status,'data-catalog-state':catalogState.status,'data-serial-count':serialCount",
  );
  source = source.replace(
    "const session=await model.create({kind:'local',cols:80,rows:24});setId(session.id);",
    `const state=catalog.getSnapshot();if(state.status!=='ready')throw new Error('catalog unavailable');setSerialCount(String((await ctx.connectionsModel.listSerialPorts()).length));const bookmark=await catalog.createBookmark(crypto.randomUUID(),{protocol:'telnet',hostId:null,title:'Packaged Telnet',telnet:{hostname:'127.0.0.1',port:${input.port},username:'fixture',credentialRef:${JSON.stringify(input.credentialRef)}}},state.baseline.bookmarks.etag);const session=await model.create({kind:'telnet',bookmarkId:bookmark.ids[0],cols:80,rows:24});setId(session.id);`,
  );
  source = source.replace(
    /channel\.current\?\.sendInput\("(?:[^"\\]|\\.)*"\)/,
    'channel.current?.sendInput("AXTERM_PACKAGED_TELNET_OK\\r")',
  );
  new Script(source);
  await writeFile(frame, source);
}
