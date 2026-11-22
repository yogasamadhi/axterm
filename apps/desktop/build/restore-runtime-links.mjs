import { lstatSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const resources = import.meta.dirname;
const app = realpathSync(join(resources, 'app'));
const packages = join(app, 'node_modules') + sep;
const instances = join(packages, '.axterm') + sep;
const links = JSON.parse(readFileSync(join(resources, 'axterm-runtime-links.json'), 'utf8'));

for (const [name, destination] of links) {
  const link = resolve(app, name);
  const target = resolve(app, destination);
  const parent = dirname(link);
  if (
    !link.startsWith(packages) ||
    !target.startsWith(instances) ||
    realpathSync(parent) !== parent ||
    realpathSync(target) !== target ||
    !lstatSync(target).isDirectory()
  )
    throw Error('Invalid Axterm runtime dependency path');

  const existing = lstatSync(link, { throwIfNoEntry: false });
  if (!existing) symlinkSync(target, link, 'junction');
  else if (!existing.isSymbolicLink() || realpathSync(link) !== target)
    throw Error('Existing path conflicts with an Axterm runtime dependency');
}
