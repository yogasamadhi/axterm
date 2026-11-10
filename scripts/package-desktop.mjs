import { packageIdentity } from './desktop-package-identity.mjs';
import { mkdir, mkdtemp, lstat, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageLevel3Desktop } from './stage-level3-desktop.mjs';
import { prepareLevel3Native } from './prepare-level3-native.mjs';
import { packageLevel3Desktop } from './package-level3-desktop.mjs';
import { packageLevel3Installers } from './package-level3-installers.mjs';
const root = resolve(import.meta.dirname, '..');

export async function packageOptions(args) {
  let directoryOnly = false,
    product = false,
    output;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--dir' && !directoryOnly) directoryOnly = true;
    else if (args[index] === '--product' && !product) product = true;
    else if (args[index] === '--output' && output === undefined) {
      output = args[++index];
      if (!output) throw Error('Package output requires an absolute directory');
    } else throw Error(`Unknown or repeated package option: ${args[index]}`);
  }
  if (output !== undefined) {
    if (!isAbsolute(output)) throw Error('Package output must be an existing absolute directory');
    const info = await lstat(output);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(output)).length)
      throw Error('Package output must be an empty non-symlink directory');
    output = await realpath(output);
    const repository = await realpath(root);
    const inside = (parent, path) => path === parent || path.startsWith(parent + sep);
    if (
      inside(repository, output) &&
      !inside(join(repository, 'out'), output) &&
      !inside(join(repository, 'release'), output)
    )
      throw Error('Package output cannot be a source root');
  }
  return { directoryOnly, output, product };
}
export async function packageDesktop(options) {
  const identity = packageIdentity(options.product === undefined ? false : options.product);
  let output = options.output;
  if (!output) {
    const parent = join(root, 'release');
    await mkdir(parent, { recursive: true });
    output = await mkdtemp(join(parent, `${identity.name}-${process.platform}-${process.arch}-`));
  }
  const scratch = join(root, 'out');
  await mkdir(scratch, { recursive: true });
  const work = await mkdtemp(join(scratch, 'level3-package-'));
  const stage = join(work, 'stage');
  await mkdir(stage);
  await stageLevel3Desktop(stage, { product: identity.productCutover });
  await prepareLevel3Native(stage);
  const application = options.directoryOnly
    ? join(output, 'application')
    : join(work, 'application');
  await mkdir(application);
  const app = await packageLevel3Desktop(stage, application);
  const artifacts = options.directoryOnly ? [] : await packageLevel3Installers(app, output);
  const result = {
    purpose: identity.purpose,
    productCutover: identity.productCutover,
    app,
    packageResult: join(application, 'LEVEL3_PACKAGE_RESULT.json'),
    artifacts,
  };
  await writeFile(
    join(output, 'LEVEL3_DISTRIBUTION_RESULT.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = await packageOptions(process.argv.slice(2));
  console.log(await packageDesktop(options));
}
