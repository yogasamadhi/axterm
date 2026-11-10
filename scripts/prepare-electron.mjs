import { createRequire } from 'node:module';
import { stat } from 'node:fs/promises';

// Electron 44 materializes its development executable on first require(). Do it
// once during installation, before parallel test workers can race extraction.
const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const executable = desktopRequire('electron');
if (typeof executable !== 'string' || !(await stat(executable)).isFile())
  throw new Error('Electron development executable was not prepared');
console.info(
  `Prepared Electron ${desktopRequire('electron/package.json').version} development executable.`,
);
