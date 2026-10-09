import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateUpdateFeedRecord } from './update-feed-record.mjs';

const defaultSourceRecordPath = resolve(
  import.meta.dirname,
  '../../compliance/UPDATE_FEED_RECORD.json',
);
const packagedFileName = 'AXTERM_UPDATE_FEED.json';

export function verifyPackagedUpdateFeed(
  resourcesPath,
  { sourceRecordPath = defaultSourceRecordPath, activeRequired = false } = {},
) {
  const violations = [];
  let sourceBytes;
  let packagedBytes;
  try {
    sourceBytes = readFileSync(sourceRecordPath);
    violations.push(
      ...validateUpdateFeedRecord(JSON.parse(sourceBytes.toString('utf8')), { activeRequired }),
    );
  } catch (error) {
    violations.push(
      `Source update-feed record cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const packagedPath = resolve(resourcesPath, packagedFileName);
  try {
    const entry = lstatSync(packagedPath);
    if (!entry.isFile() || entry.isSymbolicLink())
      violations.push('Packaged update-feed record must be a regular file, not a link');
    else packagedBytes = readFileSync(packagedPath);
  } catch (error) {
    violations.push(
      `Packaged update-feed record cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (sourceBytes && packagedBytes && !sourceBytes.equals(packagedBytes))
    violations.push('Packaged update-feed record bytes differ from the reviewed source record');
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2 || (args.length === 2 && args[1] !== '--active')) {
    console.error(
      'Usage: node scripts/commercialization/verify-packaged-update-feed.mjs <resources-directory> [--active]',
    );
    process.exitCode = 2;
  } else {
    const violations = verifyPackagedUpdateFeed(args[0], {
      activeRequired: args[1] === '--active',
    });
    if (violations.length) {
      for (const violation of violations) console.error(violation);
      process.exitCode = 1;
    } else {
      console.log(`Verified packaged update-feed record: ${resolve(args[0], packagedFileName)}`);
    }
  }
}
