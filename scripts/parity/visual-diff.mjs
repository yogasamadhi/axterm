import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { readJson, repositoryRoot } from './baseline.mjs';

function option(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function validateMask(mask, width, height) {
  if (
    !Number.isInteger(mask.x) ||
    !Number.isInteger(mask.y) ||
    !Number.isInteger(mask.width) ||
    !Number.isInteger(mask.height) ||
    mask.x < 0 ||
    mask.y < 0 ||
    mask.width < 1 ||
    mask.height < 1 ||
    mask.x + mask.width > width ||
    mask.y + mask.height > height
  )
    throw new Error(`Mask is outside ${width}x${height}: ${JSON.stringify(mask)}`);
}

function applyMasks(reference, candidate, masks) {
  for (const mask of masks) {
    validateMask(mask, reference.width, reference.height);
    for (let y = mask.y; y < mask.y + mask.height; y += 1) {
      for (let x = mask.x; x < mask.x + mask.width; x += 1) {
        const offset = (y * reference.width + x) * 4;
        candidate.data[offset] = reference.data[offset];
        candidate.data[offset + 1] = reference.data[offset + 1];
        candidate.data[offset + 2] = reference.data[offset + 2];
        candidate.data[offset + 3] = reference.data[offset + 3];
      }
    }
  }
}

export async function comparePngFiles({
  referencePath,
  candidatePath,
  diffPath,
  masks = [],
  threshold = 0.1,
  maxDifferenceRatio = 0.05,
}) {
  const [referenceBuffer, candidateBuffer] = await Promise.all([
    readFile(referencePath),
    readFile(candidatePath),
  ]);
  const reference = PNG.sync.read(referenceBuffer);
  const candidate = PNG.sync.read(candidateBuffer);
  if (reference.width !== candidate.width || reference.height !== candidate.height)
    throw new Error(
      `Image dimensions differ for ${basename(referencePath)}: ` +
        `${reference.width}x${reference.height} vs ${candidate.width}x${candidate.height}`,
    );
  applyMasks(reference, candidate, masks);
  const diff = new PNG({ width: reference.width, height: reference.height });
  const differencePixels = pixelmatch(
    reference.data,
    candidate.data,
    diff.data,
    reference.width,
    reference.height,
    { threshold, includeAA: false },
  );
  const pixels = reference.width * reference.height;
  const differenceRatio = differencePixels / pixels;
  await mkdir(dirname(diffPath), { recursive: true });
  await writeFile(diffPath, PNG.sync.write(diff));
  return {
    referencePath,
    candidatePath,
    diffPath,
    width: reference.width,
    height: reference.height,
    pixels,
    differencePixels,
    differenceRatio,
    similarityRatio: 1 - differenceRatio,
    maxDifferenceRatio,
    passed: differenceRatio <= maxDifferenceRatio,
  };
}

async function pngFiles(directory) {
  const files = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.png')
        files.push(relative(directory, path));
    }
  }
  await visit(directory);
  return files.sort();
}

export async function compareDirectories({
  referenceDirectory,
  candidateDirectory,
  outputDirectory,
  masks = [],
  threshold = 0.1,
  maxDifferenceRatio = 0.05,
}) {
  const files = await pngFiles(referenceDirectory);
  if (!files.length) throw new Error(`No reference PNG files in ${referenceDirectory}`);
  const results = [];
  for (const file of files) {
    results.push(
      await comparePngFiles({
        referencePath: resolve(referenceDirectory, file),
        candidatePath: resolve(candidateDirectory, file),
        diffPath: resolve(outputDirectory, file),
        masks,
        threshold,
        maxDifferenceRatio,
      }),
    );
  }
  const summary = {
    referenceDirectory,
    candidateDirectory,
    outputDirectory,
    files: results.length,
    passed: results.every((result) => result.passed),
    worstDifferenceRatio: Math.max(...results.map((result) => result.differenceRatio)),
    lowestSimilarityRatio: Math.min(...results.map((result) => result.similarityRatio)),
    minimumSimilarityRatio: 1 - maxDifferenceRatio,
    results,
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function main() {
  const referenceDirectory = option('reference');
  const candidateDirectory = option('candidate');
  const outputDirectory = option('output', resolve(repositoryRoot, 'test-results/parity-diff'));
  if (!referenceDirectory || !candidateDirectory)
    throw new Error(
      'Usage: bun run parity:diff -- --reference <dir> --candidate <dir> [--output <dir>]',
    );
  const manifestPath = option(
    'manifest',
    resolve(repositoryRoot, 'tests/parity/electerm-scenarios.json'),
  );
  const manifest = readJson(resolve(manifestPath));
  const summary = await compareDirectories({
    referenceDirectory: resolve(referenceDirectory),
    candidateDirectory: resolve(candidateDirectory),
    outputDirectory: resolve(outputDirectory),
    masks: manifest.visualPolicy.maskRegions,
    threshold: Number(option('threshold', manifest.visualPolicy.pixelThreshold)),
    maxDifferenceRatio: Number(option('max-ratio', manifest.visualPolicy.pixelDifferenceRatio)),
  });
  console.log(
    `Compared ${summary.files} screenshots; worst difference ` +
      `${(summary.worstDifferenceRatio * 100).toFixed(3)}%; lowest similarity ` +
      `${(summary.lowestSimilarityRatio * 100).toFixed(3)}%.`,
  );
  if (!summary.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
