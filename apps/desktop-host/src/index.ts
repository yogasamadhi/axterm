import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProfile } from '@axterm/cli/profile-boot';
import { PROFILE_TEMPLATES } from '@axterm/cli/profile-templates';
import { NativeClient, nodeIpcWire } from '@axterm/infra-desktop-native';
import type {} from '@axterm/infra-desktop-native/credentials';
import type {} from '@axterm/infra-connection';
import type {} from '@axterm/infra-web-startup';
import type { HostInitialize } from './protocol.ts';
import { ownHostControl } from './control.ts';

/** Desktop shell invokes this entry through Electron RunAsNode and private inherited IPC. */
export async function bootDesktopHost(input: HostInitialize) {
  const assets = createRequire(import.meta.url).resolve('@axterm/web/dist');
  const app = await runProfile({
    profile: 'desktop',
    home: input.home,
    desktopOwner: true,
    desktopGeneration: input.generation,
    installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)),
    templates: PROFILE_TEMPLATES,
    args: [],
    patchFiles: [],
    requiredServices: [
      'credentials',
      'fileGrants',
      'fileApplications',
      'desktopTaskInspection',
      'storageDomain',
      'subprocess',
      'clientModules',
      'webStartup',
      'typertGateway',
      'remoteEvents',
    ],
    prepare(ctx) {
      const native = new NativeClient(nodeIpcWire(process), input.generation);
      ctx.effect(() => () => native.close(), 'desktop-host: native startup channel');
      ctx.provide('desktopNative', native);
      ctx.provide('nativeDesktopLifecycle', {
        state: (signal) => native.call('desktop.lifecycle', {}, signal),
      });
      ctx.provide('nativeDesktopWindows', {
        configure: (record, signal, applyBounds = false) =>
          native.call('window.configure', { record, applyBounds }, signal),
        state: (signal) => native.call('window.state', {}, signal),
      });
      ctx.provide('nativeDesktopLaunches', {
        next: (windowId, signal) => native.call('desktopLaunch.next', { windowId }, signal),
      });
      ctx.provide('nativeDesktopUpdater', {
        status: (signal) => native.call('updater.status', {}, signal),
        perform: (key, action, signal) =>
          native.call('updater.perform', { key, action }, signal, 30 * 60_000 + 5_000),
        drain: (key) =>
          native.call('updater.drain', { key }, undefined, 30 * 60_000 + 5_000).then(() => {}),
      });
      ctx.provide('nativeExternalUrls', {
        open: (key, url, signal) =>
          native.call('externalUrl.open', { key, url }, signal).then(() => {}),
        drain: (key) => native.call('externalUrl.drain', { key }).then(() => {}),
      });
      ctx.provide('nativeWebViews', {
        create: (input, signal) => native.call('webView.create', input, signal),
        state: (windowId, id, signal) => native.call('webView.state', { windowId, id }, signal),
        present: (windowId, id, presentation, signal) =>
          native.call('webView.present', { windowId, id, presentation }, signal),
        perform: (windowId, id, action, signal) =>
          native.call('webView.action', { windowId, id, action }, signal),
        authenticate: (windowId, id, response, signal) =>
          native.call('webView.authenticate', { windowId, id, response }, signal),
        close: (windowId, id, signal) => native.call('webView.close', { windowId, id }, signal),
      });
      ctx.provide('desktopAuthenticationVerifier', Object.freeze(input.verifier));
      ctx.provide('profileTemplates', PROFILE_TEMPLATES);
      ctx.provide('webAssets', {
        index: assets,
        authenticationPage: join(dirname(assets), 'auth.html'),
      });
    },
  });
  return {
    origin: app.ctx.webStartup.url,
    injections: app.ctx.webServer.collectIndexInjections(app.ctx.connection.browserPeer),
    stop: () => app.shutdown.shutdown(0),
    async inspect(signal: AbortSignal) {
      signal.throwIfAborted();
      const tasks = app.ctx.get('desktopTaskInspection') as
        { inspect(signal: AbortSignal): Promise<{ active: boolean }> } | undefined;
      if (!tasks) throw new Error('DESKTOP_TASK_STATE_UNAVAILABLE');
      return tasks.inspect(signal);
    },
  };
}
export function startDesktopHost(): () => Promise<void> {
  return ownHostControl(process, bootDesktopHost, () => {
    process.exitCode = 1;
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.connected || !process.send) throw new Error('DESKTOP_HOST_PARENT_REQUIRED');
  if (process.argv.includes('--data-copy')) {
    const { startHomeCopyWorker } = await import('./copy-worker.ts');
    startHomeCopyWorker();
  } else startDesktopHost();
}
