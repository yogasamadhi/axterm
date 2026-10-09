import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const buildDirectory = resolve(repositoryRoot, 'apps/desktop/build');
const svgPath = resolve(buildDirectory, 'icon.svg');
const pngPath = resolve(buildDirectory, 'icon.png');
const png512Path = resolve(buildDirectory, 'icon-512.png');
const icoPath = resolve(buildDirectory, 'icon.ico');
const icnsPath = resolve(buildDirectory, 'icon.icns');
const iconVariantPaths = [pngPath, png512Path, icoPath, icnsPath];

const mode = process.argv[2];
if (mode !== undefined && mode !== '--check') {
  throw new Error('Usage: node scripts/commercialization/generate-application-icons.mjs [--check]');
}
const checkOnly = mode === '--check';

function run(command, arguments_) {
  execFileSync(command, arguments_, { stdio: 'inherit' });
}

function resize(source, size, output) {
  run('sips', ['-z', String(size), String(size), source, '--out', output]);
}

function writeIco(outputPath, entries) {
  const dataOffset = 6 + entries.length * 16;
  let offset = dataOffset;
  const header = Buffer.alloc(dataOffset);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  for (const [index, { size, content }] of entries.entries()) {
    const entryOffset = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entryOffset);
    header.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(content.byteLength, entryOffset + 8);
    header.writeUInt32LE(offset, entryOffset + 12);
    offset += content.byteLength;
  }

  writeFileSync(outputPath, Buffer.concat([header, ...entries.map(({ content }) => content)]));
}

if (process.platform !== 'darwin') {
  throw new Error(
    'Application icon variants are regenerated with the macOS sips and iconutil tools.',
  );
}

const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'axterm-iconset-'));
const iconsetDirectory = resolve(temporaryDirectory, 'Axterm.iconset');
const generatedPngPath = resolve(temporaryDirectory, 'icon.png');
const generatedPng512Path = resolve(temporaryDirectory, 'icon-512.png');
const generatedIcoPath = resolve(temporaryDirectory, 'icon.ico');
const generatedIcnsPath = resolve(temporaryDirectory, 'icon.icns');
const generatedVariantPaths = [
  generatedPngPath,
  generatedPng512Path,
  generatedIcoPath,
  generatedIcnsPath,
];
const namedVariantPaths = new Map(
  iconVariantPaths.map((path, index) => [path, generatedVariantPaths[index]]),
);
const iconsetEntries = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];
const icoSizes = [16, 24, 32, 48, 64, 128, 256];

try {
  run('sips', ['-s', 'format', 'png', svgPath, '--out', generatedPngPath]);
  resize(generatedPngPath, 512, generatedPng512Path);

  run('mkdir', ['-p', iconsetDirectory]);
  for (const [size, file] of iconsetEntries)
    resize(generatedPngPath, size, resolve(iconsetDirectory, file));
  run('iconutil', ['-c', 'icns', iconsetDirectory, '-o', generatedIcnsPath]);

  const icoEntries = icoSizes.map((size) => {
    const output = resolve(temporaryDirectory, `icon-${size}.png`);
    resize(generatedPngPath, size, output);
    return { size, content: readFileSync(output) };
  });
  writeIco(generatedIcoPath, icoEntries);

  if (checkOnly) {
    const staleVariants = iconVariantPaths.filter((path) => {
      const generatedPath = namedVariantPaths.get(path);
      return (
        !generatedPath ||
        !existsSync(path) ||
        !readFileSync(path).equals(readFileSync(generatedPath))
      );
    });
    if (staleVariants.length > 0) {
      throw new Error(
        `Application icon variants differ from icon.svg: ${staleVariants.map((path) => basename(path)).join(', ')}. Run bun run icons:generate on macOS.`,
      );
    }
    console.log('Application icon variants match icon.svg.');
  } else {
    for (const [path, generatedPath] of namedVariantPaths) copyFileSync(generatedPath, path);
    console.log(
      `Regenerated ${basename(pngPath)}, ${basename(png512Path)}, ${basename(icoPath)} and ${basename(icnsPath)} from icon.svg.`,
    );
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
