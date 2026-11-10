import { writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { Connection as SshServerConnection } from 'ssh2';
import type * as Ssh2 from 'ssh2';
const { Server: SshServer } = createRequire(resolve('packages/plugins/connections/package.json'))(
  'ssh2',
) as typeof Ssh2;
export async function startReconnectSshFixture(
  hostKey: string | Buffer,
  requestedPort = 0,
  hiddenBracketedPaste = false,
) {
  const connections = new Set<SshServerConnection>();
  let receivedText = '';
  let integrationReleaseRequested = false;
  let pendingIntegrationReply: (() => void) | undefined;
  const server = new SshServer({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection);
    // Rejecting an unknown/changed host key intentionally closes the client
    // during key exchange. ssh2 reports that expected peer abort as an error
    // event on the server-side connection.
    connection.on('error', (error) => {
      if (error.message !== 'KEY_EXCHANGE_FAILED') throw error;
    });
    connection.once('close', () => connections.delete(connection));
    connection.on('authentication', (context) => {
      if (context.method === 'none') context.accept();
      else context.reject(['none']);
    });
    connection.on('ready', () => {
      connection.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptCommand) => {
          const stream = acceptCommand();
          stream.write(hiddenBracketedPaste ? '/bin/bash\n' : '/bin/sh\n');
          stream.exit(0);
          stream.end();
        });
        session.on('pty', (acceptPty) => acceptPty?.());
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.write(
            hiddenBracketedPaste
              ? '\r\nD04_NETWORK_FIXTURE_READY\r\n\u001b[?25l\u001b[?2004h\r\nold$ '
              : '\r\nD04_NETWORK_FIXTURE_READY\r\n$ ',
          );
          let integrationReplied = false;
          stream.on('data', (chunk: Buffer) => {
            receivedText = `${receivedText}${chunk.toString('utf8')}`.slice(-64 * 1024);
            if (
              hiddenBracketedPaste &&
              !integrationReplied &&
              receivedText.includes('AXTERM_SHELL_INTEGRATION')
            ) {
              integrationReplied = true;
              const reply = () => stream.write('echoed bootstrap\r\n\u001b]633;A\u0007new$ ');
              if (integrationReleaseRequested) reply();
              else pendingIntegrationReply = reply;
              return;
            }
            stream.write(chunk);
          });
        });
      });
    });
  });
  server.listen(requestedPort, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('D04 SSH fixture did not bind');
  return {
    port: address.port,
    connectionCount: () => connections.size,
    receivedText: () => receivedText,
    releaseIntegration() {
      integrationReleaseRequested = true;
      pendingIntegrationReply?.();
      pendingIntegrationReply = undefined;
    },
    async stop() {
      const closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      for (const connection of connections) connection.end();
      await closed;
    },
  };
}

/** Headless setup through actual Catalog/Connections owners, never the retired DB implementation. */
export async function seedOwnedSshPasteFixtures(
  home: string,
  entries: readonly (readonly [string, number])[],
  key: { algorithm: string; fingerprint: string; publicKey: string },
): Promise<void> {
  const seed = resolve(home, 'seed-owned-hosts.mjs');
  await writeFile(
    seed,
    `import {runProfile} from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-boot.js')).href)};
const home=${JSON.stringify(home)};
const app=await runProfile({profile:'headless',home,installAnchor:${JSON.stringify(resolve('apps/cli/package.json'))},templates:{headless:{bundles:['@axterm/bundle-base','@axterm/bundle-catalog','@axterm/bundle-configuration','@axterm/bundle-terminals','@axterm/bundle-connections']}},patchFiles:[],args:[],requiredServices:['catalogController','connectionsController']});
try {const catalog=app.ctx.catalogController;
for(const [name,port] of ${JSON.stringify(entries)}) {
const receipt=catalog.createHost(crypto.randomUUID(),{name,hostname:'127.0.0.1',port,username:'operator',authType:'agent',sshAgent:{enabled:false,path:null}});const host=catalog.getHost(receipt.ids[0]);
const connections=app.ctx.connectionsController,generation=app.ctx.runtimeIdentity.generation,expected=${JSON.stringify(key)};
const connection=await connections.createConnection(crypto.randomUUID(),generation,{hostId:host.id});
const deadline=Date.now()+8000;
while(connections.getConnection(connection.id).state!=='ready') {
 if(Date.now()>deadline) throw Error('Owned fixture handshake deadline');
 for(const interaction of connections.listInteractions().filter(value=>value.connectionId===connection.id)) {
 const presented=interaction.presentation;
 if(interaction.kind!=='unknownHostKey'||presented?.kind!=='sshHostKey'||presented.hostname!=='127.0.0.1'||presented.port!==port||presented.algorithm!==expected.algorithm||presented.fingerprint!==expected.fingerprint) throw Error('Fixture public identity differs');
 connections.respondInteraction(interaction.id,{accepted:true,remember:true});
 }
 await new Promise(done=>setTimeout(done,10));
}
const saved=connections.listKnownHostKeys().find(value=>value.host==='127.0.0.1'&&value.port===port);
if(saved?.publicKey!==expected.publicKey) throw Error('Fixture public key differs');
await connections.closeConnection(generation,connection.id);
catalog.createBookmark(crypto.randomUUID(),{protocol:'ssh',hostId:host.id,title:name},catalog.getBookmarkTree().etag);
}} finally {await app.shutdown.shutdown(0);}`,
    { mode: 0o600 },
  );
  try {
    await promisify(execFile)(process.execPath, ['--expose-internals', seed], {
      cwd: home,
      env: { ...process.env, HOME: home, ZDOTDIR: home, AXTERM_HOME: home },
      timeout: 15000,
    });
  } finally {
    await rm(seed, { force: true });
  }
}
