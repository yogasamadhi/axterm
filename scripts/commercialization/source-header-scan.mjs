import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const sourceCodeExtension = /\.(?:rs|c|cc|cpp|h|hpp|s|js|ts)$/iu;
const copyrightLine =
  /^\s*(?:\/\/[/!]?|\/\*+|\*|#)\s*(?:(?:Portions?|Some portions?)\s+)?copyright\b/iu;
const spdxLine = /SPDX-License-Identifier/iu;

export function isCandidateHeaderLine(text) {
  return copyrightLine.test(text) || spdxLine.test(text);
}

export function sourceCodeFiles(directory) {
  const paths = [];
  function visit(parent, relativePath = '') {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const relative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(parent, entry.name), relative);
      else if (entry.isFile() && sourceCodeExtension.test(entry.name)) paths.push(relative);
      else if (entry.isSymbolicLink() && relativePath)
        throw new Error(`Unexpected linked source file: ${directory}/${relative}`);
    }
  }
  visit(directory);
  return paths.sort();
}

export function sourceHeaderLines(bytes) {
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes))
    throw new Error('Non-UTF-8 source file with candidate legal header');
  return bytes
    .toString('utf8')
    .split(/\r?\n/u)
    .flatMap((text, index) =>
      isCandidateHeaderLine(text)
        ? [{ line: index + 1, text, kind: spdxLine.test(text) ? 'spdx' : 'copyright' }]
        : [],
    );
}
