import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Physical files are visited once; aliases are checked, recorded and never traversed. */
export function inventoryDirectoryApplication(directory) {
  const root = realpathSync(directory);
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Application root must not be a link');
  const files = [],
    links = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const absolute = join(path, entry.name);
      const name = relative(root, absolute).split(sep).join('/');
      if (entry.isSymbolicLink()) {
        const target = realpathSync(absolute);
        if (target !== root && !target.startsWith(root + sep))
          throw new Error('Application link escapes the runtime closure: ' + name);
        links.push({ path: name, target: readlinkSync(absolute) });
      } else if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const bytes = readFileSync(absolute);
        files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
      } else throw new Error('Unsupported application entry: ' + name);
    }
  }
  visit(root);
  const identity = { format: 'axterm-directory-application-v1', files, links };
  return { ...identity, sha256: hash(JSON.stringify(identity)), root: resolve(directory) };
}
