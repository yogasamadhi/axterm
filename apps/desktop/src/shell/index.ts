import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { prepareShellHome } from './data-copy.ts';
import {
  parseDesktopCommandLine,
  DESKTOP_COMMAND_LINE_HELP,
  DESKTOP_DEEP_LINK_SCHEMES,
  extractDesktopDeepLinks,
  type DesktopCommandLineResult,
} from './command-line.ts';
import type { DesktopShell } from './application.ts';
import { app, protocol } from 'electron';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveShellHome, resolveLegacyShellSource } from './home-policy.ts';
const bootstrapHome = mkdtempSync(join(tmpdir(), 'axterm-desktop-bootstrap-'));
app.setPath('userData', bootstrapHome);
app.once('quit', () => {
  try {
    rmSync(bootstrapHome, { recursive: true, force: true });
  } catch {
    console.error('DESKTOP_BOOTSTRAP_CLEANUP_FAILED');
  }
});
// Electron waits for its entry module before ready; never await ready at module scope.
async function boot(): Promise<void> {
  if (process.argv.includes('--axterm-native-panel')) {
    if (!process.connected || !process.send) app.exit(1);
    else await import('./native-panel.ts');
  } else {
    const initial = parseDesktopCommandLine(process.argv.slice(1));
    if (initial.kind === 'help' || initial.kind === 'version') {
      const version = JSON.parse(
        await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
      ) as { version: string };
      process.stdout.write(
        (initial.kind === 'help' ? DESKTOP_COMMAND_LINE_HELP : version.version) + '\n',
      );
      app.exit(0);
    } else {
      const early: { parsed: DesktopCommandLineResult; secondary: boolean }[] = [];
      let activeShell: DesktopShell | undefined;
      const capture = (parsed: DesktopCommandLineResult, secondary = false) => {
        if (activeShell) return;
        if (early.length >= 32) {
          console.error('DESKTOP_CLI_QUEUE_REJECTED');
          return;
        }
        early.push({ parsed, secondary });
      };
      const earlyUrl = (event: Electron.Event, source: string) => {
        event.preventDefault();
        if (!extractDesktopDeepLinks([source]).length) return;
        capture(parseDesktopCommandLine([source]));
      };
      const earlyInstance = (_event: Electron.Event, argv: string[], cwd: string) =>
        capture(parseDesktopCommandLine(argv, cwd), true);
      app.on('open-url', earlyUrl);
      app.on('second-instance', earlyInstance);
      protocol.registerSchemesAsPrivileged([
        {
          scheme: 'axterm-app',
          privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true,
          },
        },
      ]);
      function startupFailed(): void {
        console.error('DESKTOP_SHELL_STARTUP_FAILED');
        app.exit(1);
      }
      try {
        const manifest = JSON.parse(
          await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
        ) as {
          axterm?: { migrationValidation?: boolean };
        };
        const home = await resolveShellHome(
          process.env.AXTERM_HOME,
          app.isPackaged,
          undefined,
          manifest.axterm?.migrationValidation === true,
        );
        const require = createRequire(import.meta.url);
        const source = resolveLegacyShellSource(
          process.env.AXTERM_LEGACY_HOME,
          app.isPackaged,
          manifest.axterm?.migrationValidation === true,
          join(app.getPath('appData'), 'Axterm'),
        );
        if (
          !(await prepareShellHome({
            home,
            ...(source ? { source } : {}),
            bootstrap: bootstrapHome,
            entry: require.resolve('@axterm/desktop-host'),
            environment: { ...process.env },
          }))
        )
          app.quit();
        else
          void app
            .whenReady()
            .then(async () => {
              if (app.isPackaged || process.env.AXTERM_REGISTER_PROTOCOLS === '1')
                for (const scheme of DESKTOP_DEEP_LINK_SCHEMES)
                  app.setAsDefaultProtocolClient(scheme);
              const require = createRequire(import.meta.url);
              const { DesktopShell } = await import('./application.ts');
              const shell = new DesktopShell({
                home,
                webRoot: dirname(require.resolve('@axterm/web/dist')),
                hostEntry: require.resolve('@axterm/desktop-host'),
                preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
                environment: { ...process.env },
              });
              activeShell = shell;
              app.off('open-url', earlyUrl);
              app.off('second-instance', earlyInstance);
              await shell.start();
              shell.receiveCommandLine({ ...initial, newWindow: false });
              for (const request of early.splice(0))
                shell.receiveCommandLine(request.parsed, request.secondary);
            })
            .catch(startupFailed);
      } catch {
        startupFailed();
      }
    }
  }
}
void boot().catch(() => {
  console.error('DESKTOP_SHELL_STARTUP_FAILED');
  app.exit(1);
});
