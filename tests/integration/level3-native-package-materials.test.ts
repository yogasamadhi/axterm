import { normalizeElectronLocale } from '../../scripts/electron-locale-families.mjs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { resolveLevel3PackagedArtifact } from '../fixtures/level3-packaged-artifact';
import { inventoryPackagedResources } from '../../scripts/commercialization/packaged-license-inventory.mjs';
import { missingPackagedComponents } from '../../scripts/commercialization/generate-component-index.mjs';
import { mismatchedPackagedLicenseTexts } from '../../scripts/commercialization/generate-license-texts.mjs';

import { verifyNoVncPackagedBundle } from '../../scripts/commercialization/generate-novnc-source-notices.mjs';
import { verifySpicePackagedBundle } from '../../scripts/commercialization/generate-spice-source-notices.mjs';
const result = process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
const artifact = () => resolveLevel3PackagedArtifact({ result });

it.skipIf(!result)(
  'retains original external legal materials, every actual dependency notice and exact prepared native addons in the new package',
  async () => {
    const packaged = (await artifact())!;
    const inventory = inventoryPackagedResources(packaged.resourcesDirectory);
    expect(await verifyNoVncPackagedBundle(packaged.resourcesDirectory)).toMatchObject({
      sources: 52,
    });
    expect(await verifySpicePackagedBundle(packaged.resourcesDirectory)).toMatchObject({
      sources: 30,
    });
    const legal = join(packaged.resourcesDirectory, '..');
    for (const [source, target] of [
      ['LICENSE', 'LICENSE.axterm'],
      ['THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.txt'],
      ...[
        'THIRD_PARTY_COMPONENTS.json',
        'THIRD_PARTY_LICENSE_TEXTS.json',
        'AXTERM_PRODUCTION_DEPENDENCIES.spdx.json',
      ].map((name) => ['compliance/' + name, name]),
    ])
      expect(await readFile(join(legal, target!))).toEqual(await readFile(resolve(source!)));
    const index = JSON.parse(await readFile(join(legal, 'THIRD_PARTY_COMPONENTS.json'), 'utf8'));
    const texts = JSON.parse(await readFile(join(legal, 'THIRD_PARTY_LICENSE_TEXTS.json'), 'utf8'));
    expect(missingPackagedComponents(index, inventory.packages)).toEqual([]);
    expect(mismatchedPackagedLicenseTexts(texts, inventory.packages)).toEqual([]);
    const originalLicenseFiles = (await readdir(resolve('licenses'))).sort();
    expect((await readdir(join(legal, 'licenses'))).sort()).toEqual(originalLicenseFiles);
    for (const name of originalLicenseFiles)
      expect(await readFile(join(legal, 'licenses', name))).toEqual(
        await readFile(resolve('licenses', name)),
      );
    expect(inventory.electronRuntimeLegalFiles).toHaveLength(2);
    expect(inventory).toHaveProperty('nativePrebuildFiles', []);
    const marker = JSON.parse(
      await readFile(join(packaged.appDirectory, 'LEVEL3_PACKAGE.json'), 'utf8'),
    );
    expect(marker.nativePreparation.modules.sort()).toEqual([
      '@serialport/bindings-cpp',
      'node-pty',
    ]);
    for (const file of marker.nativePreparation.files) {
      expect(
        createHash('sha256')
          .update(await readFile(join(packaged.appDirectory, file.path)))
          .digest('hex'),
      ).toBe(file.sha256);
    }
    const appRequire = createRequire(join(packaged.appDirectory, 'package.json'));
    for (const name of ['node-pty', '@serialport/bindings-cpp']) {
      const packageFile = appRequire.resolve(name + '/package.json');
      await expect(access(join(packageFile, '../prebuilds'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  },
  30_000,
);

it.skipIf(!result)(
  'keeps exactly the original four selected Electron locale families in the new package',
  async () => {
    const packaged = (await artifact())!;
    const names =
      process.platform === 'darwin'
        ? (
            await readdir(
              join(
                packaged.artifactRoot,
                'Contents/Frameworks/Electron Framework.framework/Resources',
              ),
            )
          )
            .filter((name) => name.endsWith('.lproj'))
            .map((name) => name.slice(0, -6))
        : (await readdir(join(packaged.artifactRoot, 'locales')))
            .filter((name) => name.endsWith('.pak'))
            .map((name) => name.slice(0, -4));
    const matches = (wanted: string, resource: string) => {
      const actual = normalizeElectronLocale(resource);
      return wanted === 'en'
        ? /^en(?:[-_]|$)/i.test(actual)
        : wanted === 'zh-CN'
          ? /^(?:zh[-_]CN|zh[-_]Hans)$/i.test(actual)
          : wanted === 'zh-TW'
            ? /^(?:zh[-_]TW|zh[-_]Hant)$/i.test(actual)
            : wanted === actual;
    };
    const languages = ['en', 'ja', 'zh-CN', 'zh-TW'];
    expect(names).not.toEqual([]);
    for (const language of languages)
      expect(names.some((locale) => matches(language, locale))).toBe(true);
    expect(names.every((locale) => languages.some((language) => matches(language, locale)))).toBe(
      true,
    );
  },
);

it.skipIf(!result || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'uses the packaged native exclusive-publish helper without replacing existing bytes',
  async () => {
    const packaged = (await artifact())!;
    const script = `
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const {createRequire} = require('node:module');
    const requireApp = createRequire(${JSON.stringify(join(packaged.appDirectory, 'package.json'))});
    const requireNative = createRequire(requireApp.resolve('@axterm/infra-desktop-native'));
    const {publishFileExclusive} = requireNative('@openclaw/fs-safe/durability');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axterm-l3-native-publish-'));
    (async()=>{try{
      const source=path.join(root,'.received.part'),target=path.join(root,'received.bin');
      fs.writeFileSync(source,Buffer.from([0,1,2,255]));
      const receipt=await publishFileExclusive({sourcePath:source,targetPath:target,strategy:'rename-noreplace'});
      const collisionSource=path.join(root,'.collision.part');fs.writeFileSync(collisionSource,'collision');
      let collisionCode=null;try{await publishFileExclusive({sourcePath:collisionSource,targetPath:target,strategy:'rename-noreplace'});}catch(error){collisionCode=error.code;}
      process.stdout.write(JSON.stringify({method:receipt.method,directorySync:receipt.directorySync.status,finalHex:fs.readFileSync(target).toString('hex'),sourceExists:fs.existsSync(source),collisionCode,collisionSource:fs.readFileSync(collisionSource,'utf8')}));
    }finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(()=>{process.stderr.write('Native publish verification failed');process.exitCode=1;});`;
    const { stdout } = await promisify(execFile)(packaged.executablePath, ['-e', script], {
      cwd: packaged.artifactRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '',
        NODE_PATH: '',
        PATH: '/usr/bin:/bin',
      },
    });
    expect(JSON.parse(stdout)).toEqual({
      method: 'rename-noreplace',
      directorySync: 'synced',
      finalHex: '000102ff',
      sourceExists: false,
      collisionCode: 'EEXIST',
      collisionSource: 'collision',
    });
  },
  10_000,
);
