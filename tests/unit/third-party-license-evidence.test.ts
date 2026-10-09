import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNoVncSourceNotices } from '../../scripts/commercialization/generate-novnc-source-notices.mjs';
import { verifyNoVncSourceArchive } from '../../scripts/commercialization/verify-novnc-source-archive.mjs';
import { buildSpiceSourceNotices } from '../../scripts/commercialization/generate-spice-source-notices.mjs';
import { verifySpiceSourceArchive } from '../../scripts/commercialization/verify-spice-source-archive.mjs';

const installedNoVnc = resolve('apps/desktop/node_modules/@novnc/novnc');
const installedSpice = resolve('apps/desktop/node_modules/spice-client');
const installedXtermSerialize = resolve('apps/desktop/node_modules/@xterm/addon-serialize');
const installedIronRdp = resolve('apps/desktop/node_modules/@devolutions/iron-remote-desktop-rdp');
const installedXtermHeadless = resolve('packages/runtime/node_modules/@xterm/headless');
const installedDrizzleOrm = resolve('packages/runtime/node_modules/drizzle-orm');
const installedHonoOpenApi = resolve('packages/runtime/node_modules/@hono/zod-openapi');
const installedTweetNacl = resolve('node_modules/.bun/tweetnacl@0.14.5/node_modules/tweetnacl');
const installedIsarray = resolve('node_modules/.bun/isarray@1.0.0/node_modules/isarray');

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('third-party license source evidence', () => {
  it('preserves the exact isarray 1.0.0 README license from its pinned publisher source', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(installedIsarray, 'package.json'), 'utf8'),
    ) as {
      name: string;
      version: string;
      license: string;
      repository: { url: string };
    };
    expect(manifest).toMatchObject({
      name: 'isarray',
      version: '1.0.0',
      license: 'MIT',
      repository: { url: 'git://github.com/juliangruber/isarray.git' },
    });
    expect(sha256(await readFile(resolve(installedIsarray, 'package.json')))).toBe(
      '93165ce56e458216c18240cd961a522af5b18e51da06f55d88ac552234455d95',
    );
    expect(sha256(await readFile(resolve(installedIsarray, 'index.js')))).toBe(
      '9b8c691372802da788c9c5f4e1ca2f1ed0b88ab8722176c2aea15e38ec86d249',
    );
    expect(
      (await readdir(installedIsarray)).some((name) => /^licen[cs]e(?:[._-]|$)/iu.test(name)),
    ).toBe(false);
    const readme = await readFile(resolve(installedIsarray, 'README.md'));
    expect(sha256(readme)).toBe('ff138e683771b187f3629c383db72ee7d632009010a36d08e18e8d2a34222ec7');
    expect(await readFile(resolve('licenses/isarray-README.txt'))).toEqual(readme);
    expect(readme.toString('utf8')).toContain('Copyright (c) 2013 Julian Gruber');
    const notice = await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    expect(notice).toContain('licenses/isarray-README.txt');
    const evidence = await readFile(
      resolve('docs/implementation/evidence/IR11-ISARRAY-README-SOURCE-2026-09-25.md'),
      'utf8',
    );
    expect(evidence).toContain('2a23a281f369e9ae06394c0fb4d2381355a6ba33');
  });

  it('pins transfer-library publisher metadata without hiding its Legacy Prototype development link', async () => {
    const lockfile = await readFile(resolve('bun.lock'), 'utf8');
    const evidence = await readFile(
      resolve('docs/implementation/evidence/IR02-TRANSFER-PUBLISHER-SOURCE-2026-09-24.md'),
      'utf8',
    );
    for (const entry of [
      {
        name: 'zmodem2',
        version: '1.4.0',
        repository: 'git+https://github.com/zxdong262/zmodem2-js.git',
        commit: 'b9f03ed3cdc362610dc76ce9401c7e02397ee0c8',
        manifestSha256: '66b7e0b83092c6199c8bc022a49ace47c28e1fc13fcc319b90616888cb2ab423',
        licenseSha256: 'd1f16458bcc7a33ec2752ecc65314736cfca713337dec5cde6505504b8201b02',
        readmeSha256: '38e6d4275211507a32ef9bd782e1a8f4b6d01d362ea363916d63f94fa919adaa',
      },
      {
        name: 'trzsz2',
        version: '1.2.0',
        repository: 'git+https://github.com/zxdong262/trzsz2.git',
        commit: 'd8ec536dab4fe86ee41acb6db8ae89d55e29153a',
        manifestSha256: '1a639cb7ea1e7f9d4628ce3a5a47ef2b8f4b9b06aed16e7584fa3020b8d1d47b',
        licenseSha256: '10adae8a4911e6f69c53417e564594a425a281eb85f4e115e80c0dd568624d2f',
        readmeSha256: '21790ef20853d0be9943235c1fadde9436de0d38b769dc58e5bc98a90c207c11',
      },
    ]) {
      const directory = resolve('packages/runtime/node_modules', entry.name);
      const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
        license: string;
        author: string;
        repository: { url: string };
        devDependencies?: Record<string, string>;
      };
      expect(manifest).toMatchObject({
        name: entry.name,
        version: entry.version,
        license: 'MIT',
        author: expect.stringContaining('ZHAO Xudong'),
        repository: { url: entry.repository },
      });
      expect(sha256(await readFile(resolve(directory, 'package.json')))).toBe(entry.manifestSha256);
      expect(sha256(await readFile(resolve(directory, 'LICENSE')))).toBe(entry.licenseSha256);
      expect(sha256(await readFile(resolve(directory, 'README.md')))).toBe(entry.readmeSha256);
      expect(evidence).toContain(entry.commit);
    }
    const trzszManifest = JSON.parse(
      await readFile(resolve('packages/runtime/node_modules/trzsz2/package.json'), 'utf8'),
    ) as { devDependencies: Record<string, string> };
    const publisherOnlyDependency = ['@elect', 'erm/ssh2'].join('');
    expect(trzszManifest.devDependencies[publisherOnlyDependency]).toBe('^1.17.0');
    expect(lockfile).not.toContain(`"${publisherOnlyDependency}"`);
    expect(lockfile).toContain(
      'sha512-2PG/XvD43I5LKKG09GSsC1irZW5pDTq/5yA29JP118gRv2o3vu+N69x1MzTjFi++O4Nm5nSRdpdZn3Z6D5EneA==',
    );
    expect(lockfile).toContain(
      'sha512-wJ/Z2CVaY0nnPG6Ev4IxzRyceya1o77V08zRsxSgNNeYxZ1kTaeQxHonLxsO+edaE/KhAiJZ404CI0xO3CrCWQ==',
    );
  });

  it('pins published transfer source maps to the reviewed source-file hashes', async () => {
    const record = JSON.parse(
      await readFile(
        resolve('docs/implementation/evidence/IR02-TRANSFER-SOURCE-MAP-2026-09-24.json'),
        'utf8',
      ),
    ) as {
      schemaVersion: number;
      packages: Array<{
        name: string;
        version: string;
        cjsBundleSha256: string;
        cjsSourceMapSha256: string;
        patchedEsmTransferSha256?: string;
        patchedEsmBufferSha256?: string;
        sources: Array<{ path: string; sha256: string }>;
      }>;
    };
    expect(record.schemaVersion).toBe(1);
    expect(record.packages.map(({ name }) => name)).toEqual(['zmodem2', 'trzsz2']);
    for (const entry of record.packages) {
      const packageRoot = resolve('packages/runtime/node_modules', entry.name);
      const sourceMapBytes = await readFile(resolve(packageRoot, 'dist/cjs-full/index.cjs.map'));
      const bundleBytes = await readFile(resolve(packageRoot, 'dist/cjs-full/index.cjs'));
      expect(sha256(sourceMapBytes)).toBe(entry.cjsSourceMapSha256);
      expect(sha256(bundleBytes)).toBe(entry.cjsBundleSha256);
      const sourceMap = JSON.parse(sourceMapBytes.toString('utf8')) as {
        file: string;
        sources: string[];
        sourcesContent: string[];
      };
      expect(sourceMap.file).toBe('index.cjs');
      expect(sourceMap.sources).toEqual(entry.sources.map(({ path }) => `../../${path}`));
      expect(sourceMap.sourcesContent).toHaveLength(entry.sources.length);
      for (const [index, source] of entry.sources.entries()) {
        const content = sourceMap.sourcesContent[index];
        if (content === undefined) throw new Error(`Missing embedded source: ${source.path}`);
        expect(sha256(Buffer.from(content, 'utf8'))).toBe(source.sha256);
        const esmMap = JSON.parse(
          await readFile(
            resolve(packageRoot, 'dist/esm', `${basename(source.path, '.ts')}.js.map`),
            'utf8',
          ),
        ) as { sources: string[]; sourcesContent: string[] };
        expect(esmMap.sources).toEqual([`../../${source.path}`]);
        expect(esmMap.sourcesContent).toEqual([content]);
      }
      if (entry.patchedEsmTransferSha256) {
        expect(sha256(await readFile(resolve(packageRoot, 'dist/esm/transfer.js')))).toBe(
          entry.patchedEsmTransferSha256,
        );
      }
      if (entry.patchedEsmBufferSha256) {
        expect(sha256(await readFile(resolve(packageRoot, 'dist/esm/buffer.js')))).toBe(
          entry.patchedEsmBufferSha256,
        );
      }
    }
  });

  it('keeps the current transfer-wrapper comparison tied to present Axterm bytes', async () => {
    const evidence = await readFile(
      resolve(
        'docs/implementation/evidence/IR02-TRANSFER-LEGACY_PROTOTYPE-REFERENCE-2026-09-24.md',
      ),
      'utf8',
    );
    const current = evidence.split('## 2026-09-25 current-wrapper repeat')[1];
    expect(current).toBeDefined();
    for (const name of ['xmodem', 'zmodem', 'trzsz']) {
      const path = resolve('packages/runtime/src/adapters/terminal-transfer', `${name}.ts`);
      expect(current).toContain(sha256(await readFile(path)));
    }
  });

  it('retains the upstream Rust attribution for the shipped zmodem2 port', async () => {
    const notice = await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    const installed = await readFile(
      resolve('packages/runtime/node_modules/zmodem2/LICENSE'),
      'utf8',
    );
    expect(notice).toContain('Copyright (c) 2026 ZHAO Xudong <zxdong@gmail.com>');
    expect(installed).toContain('Copyright (c) 2026 ZHAO Xudong <zxdong@gmail.com>');
    expect(notice).toContain('Copyright (c) 2017-2020 Alexey Arbuzov');
    expect(notice).toContain('Copyright (c) 2023-2025 Jarkko Sakkinen');
  });

  it('identifies the local trzsz2 receive-safety patch without claiming third-party code as Axterm-owned', async () => {
    const notice = await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    const patch = await readFile(resolve('patches/trzsz2@1.2.0.patch'), 'utf8');
    const publisherReadme = await readFile(
      resolve('packages/runtime/node_modules/trzsz2/README.md'),
      'utf8',
    );
    const originalLicense = await readFile(resolve('licenses/trzsz-js-LICENSE.txt'), 'utf8');
    expect(notice).toContain('Copyright (c) 2024 trzsz2 contributors');
    expect(publisherReadme).toContain('This project is based on [trzsz-js]');
    expect(sha256(Buffer.from(originalLicense))).toBe(
      '9fcfcc727eea90aa6a1568c598a8950c761ed811903684443a762e8aaf9e8492',
    );
    expect(originalLicense).toContain('Copyright (c) 2023 Lonny Wong');
    expect(originalLicense).toContain('Permission is hereby granted, free of charge');
    expect(notice).toContain('Copyright (c) 2023 Lonny Wong');
    expect(notice).toContain('licenses/trzsz-js-LICENSE.txt');
    expect(notice).toContain('patches/trzsz2@1.2.0.patch');
    expect(notice).toContain('modified third-party component');
    expect(patch).toContain('clearTimeout(receiveTimer)');
    expect(patch).toContain('TRZSZ binary chunk exceeds limit');
    expect(patch).toContain('TRZSZ protocol line exceeds limit');
    expect(patch).toContain('TRZSZ receive buffer exceeds limit');
    expect(patch).toContain('this.bufArray = this.bufArray.slice(this.bufHead)');
    expect(patch).toContain('MAX_BUFFERED_CHUNKS = 4096');
  });

  it('identifies the local node-pty patch and retains its installed copyright chain', async () => {
    const notice = await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    const installed = await readFile(
      resolve('packages/runtime/node_modules/node-pty/LICENSE'),
      'utf8',
    );
    const patch = await readFile(resolve('patches/node-pty@1.1.0.patch'), 'utf8');
    for (const copyright of [
      'Copyright (c) 2012-2015, Christopher Jeffrey',
      'Copyright (c) 2016, Daniel Imms',
      'Copyright (c) 2018 - present Microsoft Corporation',
    ]) {
      expect(installed).toContain(copyright);
      expect(notice).toContain(copyright);
    }
    expect(notice).toContain('patches/node-pty@1.1.0.patch');
    expect(notice).toContain('modified third-party component');
    expect(patch).toContain('posix_openpt(O_RDWR)');
    expect(patch).toContain('close(low_fds[count - 1])');
  });

  it('retains the mapped xterm.js 6.0.0 MIT notice for addon-serialize', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(installedXtermSerialize, 'package.json'), 'utf8'),
    ) as { name: string; version: string; license: string; commit: string };
    expect(manifest).toMatchObject({
      name: '@xterm/addon-serialize',
      version: '0.14.0',
      license: 'MIT',
      commit: 'f447274f430fd22513f6adbf9862d19524471c04',
    });
    expect(sha256(await readFile(resolve(installedXtermSerialize, 'src/SerializeAddon.ts')))).toBe(
      'a1ed69d294d0e013aafb4e70c9a9a66c36550a410946eddb03a47d66b92a0405',
    );
    expect(sha256(await readFile(resolve('licenses/xterm-addon-serialize-LICENSE.txt')))).toBe(
      'b569f629d00f2626a8100df2a1798210535621e42164dfd426a6fe5aac7b0ccd',
    );
    const notice = await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    expect(notice).toContain('licenses/xterm-addon-serialize-LICENSE.txt');
    expect(notice).toContain(manifest.commit);
  });

  it('identifies the independent IronRDP package and its Apache-2.0 distribution option', async () => {
    const desktop = JSON.parse(await readFile(resolve('apps/desktop/package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(desktop.dependencies['@devolutions/iron-remote-desktop-rdp']).toBe('0.7.0');
    expect(desktop.dependencies).not.toHaveProperty('ironrdp-wasm');
    const manifest = JSON.parse(
      await readFile(resolve(installedIronRdp, 'package.json'), 'utf8'),
    ) as {
      name: string;
      version: string;
      license: string;
      repository: { url: string };
    };
    expect(manifest).toMatchObject({
      name: '@devolutions/iron-remote-desktop-rdp',
      version: '0.7.0',
      license: 'MIT OR Apache-2.0',
      repository: { url: 'git+https://github.com/Devolutions/IronRDP.git' },
    });
    expect(sha256(await readFile(resolve(installedIronRdp, 'package.json')))).toBe(
      '5bf67de9f67a913960387500752cc79cc353366326603eafa4ba11542a165dab',
    );
    expect(sha256(await readFile(resolve(installedIronRdp, 'iron-remote-desktop-rdp.js')))).toBe(
      'b008f0e258fd9485c6f2b07747116d4fcbbe51053ce995abd048fb2b79636332',
    );
    expect(sha256(await readFile(resolve('licenses/IronRDP-LICENSE-APACHE.txt')))).toBe(
      'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    );
    expect(sha256(await readFile(resolve('licenses/IronRDP-RUST-ROOT-LICENSES.txt')))).toBe(
      '4f90cf224ed4e9b0a4e9f6fb2428c98eeccc2f2ab17c063d0543aba266337a96',
    );
    expect(
      sha256(await readFile(resolve('licenses/IronRDP-MISSING-CRATE-ROOT-LICENSES.txt'))),
    ).toBe('7768aaf3d75c05f6c75923fbecad728e3c9325c05268098db3a6ac8e8b2851b0');
    expect(sha256(await readFile(resolve('licenses/tracing-core-spin-LICENSE.txt')))).toBe(
      '58545fed1565e42d687aecec6897d35c6d37ccb71479a137c0deb2203e125c79',
    );
    expect(sha256(await readFile(resolve('licenses/IronRDP-SOURCE-HEADER-ATTRIBUTIONS.txt')))).toBe(
      'd90d38584895a626cdfb61f600e8eb4670d0f1734206b5c0c7cdd52a10712084',
    );
    expect(await readFile(resolve('licenses/IronRDP-LICENSE-APACHE.txt'))).not.toEqual(
      await readFile(resolve('LICENSE')),
    );
    const notice = await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    expect(notice).toContain('@devolutions/iron-remote-desktop-rdp 0.7.0');
    expect(notice).toContain('Alexandr Yusuk');
    expect(notice).toContain('Benoit Cortier');
    expect(notice).toContain('under the Apache-2.0 option');
    expect(notice).toContain('licenses/IronRDP-LICENSE-APACHE.txt');
    expect(notice).toContain('licenses/IronRDP-RUST-ROOT-LICENSES.txt');
    expect(notice).toContain('licenses/IronRDP-MISSING-CRATE-ROOT-LICENSES.txt');
    expect(notice).toContain('licenses/tracing-core-spin-LICENSE.txt');
    expect(notice).toContain('licenses/IronRDP-SOURCE-HEADER-ATTRIBUTIONS.txt');
    expect(notice).toContain('e45f68c7e52297ca50d33b44c0ace36c9940fbe6');
  });

  it('maps the xterm.js 6.0.0 source license to the headless package without treating it as bundled provenance proof', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(installedXtermHeadless, 'package.json'), 'utf8'),
    ) as { name: string; version: string; license: string };
    expect(manifest).toMatchObject({
      name: '@xterm/headless',
      version: '6.0.0',
      license: 'MIT',
    });
    const notice = await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    expect(notice).toContain('@xterm/headless 6.0.0');
    expect(notice).toContain('licenses/xterm-addon-serialize-LICENSE.txt for both packages');
  });

  it('retains the Microsoft MIT notice for VS Code sources embedded in the published xterm headless bundle', async () => {
    const bundle = await readFile(
      resolve(installedXtermHeadless, 'lib-headless/xterm-headless.js'),
    );
    const sourceMap = await readFile(
      resolve(installedXtermHeadless, 'lib-headless/xterm-headless.js.map'),
    );
    expect(sha256(bundle)).toBe('17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed');
    expect(bundle.toString('utf8')).toContain('//# sourceMappingURL=xterm-headless.js.map');
    expect(sha256(sourceMap)).toBe(
      '780e782badc8189491a469c9277b783e01911882ea84417b31e71294ea927d98',
    );
    const parsed = JSON.parse(sourceMap.toString('utf8')) as {
      sources: string[];
      sourcesContent: string[];
    };
    expect(parsed.sources).toHaveLength(57);
    expect(parsed.sourcesContent).toHaveLength(parsed.sources.length);
    const vscodeSources = parsed.sources
      .map((name, index) => ({ name, content: parsed.sourcesContent[index] }))
      .filter(({ name }) =>
        /^webpack:\/\/@xterm\/xterm\/\.\/out\/vs\/base\/common\/[^/]+\.js$/u.test(name),
      );
    expect(vscodeSources).toHaveLength(11);
    for (const { content } of vscodeSources) {
      expect(content).toContain('Copyright (c) Microsoft Corporation. All rights reserved.');
      expect(content).toContain(
        'Licensed under the MIT License. See License.txt in the project root for license information.',
      );
    }
    expect(sha256(await readFile(resolve('licenses/xterm-headless-vscode-LICENSE.txt')))).toBe(
      '9480271317925265e806a9a196aaa33410a962fa9d4d1e248a4a5187bc8c9df9',
    );
    const notice = await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    expect(notice).toContain('11');
    expect(notice).toContain('Copyright (c) Microsoft Corporation. All rights reserved.');
    expect(notice).toContain('licenses/xterm-headless-vscode-LICENSE.txt');
  });

  it('preserves the exact official Drizzle ORM 0.45.2 Apache source-license text', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(installedDrizzleOrm, 'package.json'), 'utf8'),
    ) as { name: string; version: string; license: string; author: string };
    expect(manifest).toMatchObject({
      name: 'drizzle-orm',
      version: '0.45.2',
      license: 'Apache-2.0',
      author: 'Drizzle Team',
    });
    expect(sha256(await readFile(resolve('licenses/drizzle-orm-LICENSE.txt')))).toBe(
      'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    );
    const notice = await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    expect(notice).toContain('drizzle-orm 0.45.2');
    expect(notice).toContain('licenses/drizzle-orm-LICENSE.txt');
  });

  it('attributes the two Hono MIT middlewares to their byte-matched tagged READMEs', async () => {
    const installedHonoValidator = resolve(
      dirname(await realpath(installedHonoOpenApi)),
      'zod-validator',
    );
    const notice = await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    for (const { directory, name, version, readmeHash, sourceCommit } of [
      {
        directory: installedHonoOpenApi,
        name: '@hono/zod-openapi',
        version: '1.6.3',
        readmeHash: '526d11cb80f13a2b8a77754e274e64efbf13dec7073bc52db45197e4ed361778',
        sourceCommit: 'bc7d9e67119f870b5275569b371676663c74c976',
      },
      {
        directory: installedHonoValidator,
        name: '@hono/zod-validator',
        version: '0.9.1',
        readmeHash: '6d10c6e36fd42589bc10aa2ae7507eebe4d9601ba45e8a3fee6348f3eec3462d',
        sourceCommit: '8de0f1ea32b76d40df0ec4a06ed5af2e100ccbfd',
      },
    ]) {
      const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
        license: string;
      };
      expect(manifest).toMatchObject({ name, version, license: 'MIT' });
      const readme = await readFile(resolve(directory, 'README.md'));
      expect(sha256(readme)).toBe(readmeHash);
      expect(readme.toString('utf8')).toContain('Yusuke Wada <https://github.com/yusukebe>');
      expect(readme.toString('utf8')).toMatch(/## License\s+MIT/u);
      expect(notice).toContain(`${name} ${version}`);
      expect(notice).toContain(sourceCommit);
    }
    expect(notice).toContain('Yusuke Wada');
    expect(notice).toContain('Permission is hereby granted');
    expect(notice).toContain('no package-specific copyright holder or year');
  });

  it('preserves TweetNaCl.js authors and credited public-domain source authors', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(installedTweetNacl, 'package.json'), 'utf8'),
    ) as {
      name: string;
      version: string;
      license: string;
    };
    expect(manifest).toMatchObject({ name: 'tweetnacl', version: '0.14.5', license: 'Unlicense' });
    expect(await readFile(resolve(installedTweetNacl, 'README.md'), 'utf8')).toContain(
      'See AUTHORS.md file.',
    );
    const authors = await readFile(resolve(installedTweetNacl, 'AUTHORS.md'));
    expect(sha256(authors)).toBe(
      '8feb6d2a264181d5c3ec1fd41cd5d70052bb319f7a0dcaf71bd7305eba61c635',
    );
    expect(await readFile(resolve('licenses/tweetnacl-AUTHORS.txt'))).toEqual(authors);
    expect(sha256(await readFile(resolve(installedTweetNacl, 'LICENSE')))).toBe(
      '88d9b4eb60579c191ec391ca04c16130572d7eedc4a86daa58bf28c6e14c9bcd',
    );
    const notice = await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    expect(notice).toContain('tweetnacl 0.14.5');
    expect(notice).toContain('licenses/tweetnacl-AUTHORS.txt');
    expect(notice).toContain('Poly1305-donna');
  });

  it.each([
    ['index.js.map', 'cc0da45244d87553b49ff5df0e2e90b61fc7aed4980a7fe8524879bf9be20c34'],
    [
      'sqlite-core/index.js.map',
      '2326471de09d72a35ca9abd7ff3abcc41696b03b9023037ff95ac55d85ae0319',
    ],
    [
      'sqlite-core/dialect.js.map',
      'fcc401a3f3e40ce865b3da9fc2c13bca2ede65a882a72fccd231c539003e1bb5',
    ],
  ])('pins a Drizzle %s source-map sample to official tag 0.45.2', async (file, expectedHash) => {
    const map = JSON.parse(await readFile(resolve(installedDrizzleOrm, file), 'utf8')) as {
      sourcesContent: string[];
    };
    expect(map.sourcesContent).toHaveLength(1);
    const sourceContent = map.sourcesContent[0];
    if (!sourceContent) throw new Error(`Missing source content in ${file}`);
    expect(sha256(Buffer.from(sourceContent, 'utf8'))).toBe(expectedHash);
  });

  it.each([
    ['noVNC-LICENSE.txt', resolve(installedNoVnc, 'LICENSE.txt')],
    ['noVNC-AUTHORS.txt', resolve(installedNoVnc, 'AUTHORS')],
    ['MPL-2.0.txt', resolve(installedNoVnc, 'docs/LICENSE.MPL-2.0')],
    ['BSD-2-Clause.txt', resolve(installedNoVnc, 'docs/LICENSE.BSD-2-Clause')],
    ['BSD-3-Clause.txt', resolve(installedNoVnc, 'docs/LICENSE.BSD-3-Clause')],
    ['noVNC-pako-LICENSE.txt', resolve(installedNoVnc, 'vendor/pako/LICENSE')],
    ['spice-client-LICENSE.txt', resolve(installedSpice, 'LICENSE')],
  ])('keeps %s byte-for-byte identical to its installed package', async (name, source) => {
    expect(await readFile(resolve('licenses', name))).toEqual(await readFile(source));
  });

  it('preserves noVNC DES source attribution verbatim', async () => {
    const source = await readFile(resolve(installedNoVnc, 'core/crypto/des.js'), 'utf8');
    const end = source.indexOf('*/') + 2;
    expect(end).toBeGreaterThan(2);
    expect(await readFile(resolve('licenses/noVNC-DES-NOTICE.txt'), 'utf8')).toBe(
      `${source.slice(0, end)}\n`,
    );
  });

  it('preserves the distinct copyright of noVNC embedded pako', async () => {
    const inflator = await readFile(resolve(installedNoVnc, 'core/inflator.js'), 'utf8');
    const deflator = await readFile(resolve(installedNoVnc, 'core/deflator.js'), 'utf8');
    const notice = await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    expect(inflator).toContain('../vendor/pako/lib/zlib/inflate.js');
    expect(deflator).toContain('../vendor/pako/lib/zlib/deflate.js');
    expect(notice).toContain('licenses/noVNC-pako-LICENSE.txt');
    expect(notice).toContain('Copyright (C) 2014-2016 by Vitaly Puzrin');
  });

  it('ships the author file referenced by the noVNC root notice', async () => {
    const license = await readFile(resolve(installedNoVnc, 'LICENSE.txt'), 'utf8');
    const notice = await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    expect(license).toContain('(./AUTHORS)');
    expect(notice).toContain('licenses/noVNC-AUTHORS.txt');
  });

  it('maps the installed RFB import graph to reproducible noVNC source headers', async () => {
    const inventory = await buildNoVncSourceNotices();
    expect(inventory.modules).toHaveLength(52);
    expect(inventory.coreCount).toBe(42);
    expect(inventory.pakoCount).toBe(10);
    expect(inventory.modules.find(({ path }) => path === 'core/base64.js')?.header).toContain(
      'mozilla-central/raw-file/',
    );
    expect(inventory.modules.find(({ path }) => path === 'core/crypto/des.js')?.header).toContain(
      'Copyright (C) 1999 AT&T Laboratories Cambridge',
    );
    expect(await readFile(resolve('licenses/noVNC-SOURCE-NOTICES.txt'), 'utf8')).toBe(
      inventory.content,
    );
    expect(await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8')).toContain(
      'licenses/noVNC-SOURCE-NOTICES.txt',
    );
  });

  it('ships the locked published noVNC tarball with every installed RFB/Pako source', async () => {
    const archive = await readFile(resolve('licenses/noVNC-1.7.0-source.tgz'));
    expect(await verifyNoVncSourceArchive(archive)).toMatchObject({
      files: 66,
      matchingRfbSources: 52,
      sha256: '32689f18d6abe96bc6530828a6bd0b9ae33bda07c083a6575ed255b5a8f2e903',
    });
    const tampered = Buffer.from(archive);
    tampered[256] = tampered[256]! ^ 1;
    await expect(verifyNoVncSourceArchive(tampered)).rejects.toThrow(
      'differs from the reviewed npm tarball',
    );
    const guide = await readFile(resolve('licenses/noVNC-SOURCE-README.txt'), 'utf8');
    expect(guide).toContain('32689f18d6abe96bc6530828a6bd0b9ae33bda07c083a6575ed255b5a8f2e903');
    expect(guide).toContain('52 noVNC and embedded');
  });

  it('preserves the embedded spice-client source-map attributions, not just its root LGPL label', async () => {
    const inventory = await buildSpiceSourceNotices();
    const sources = inventory.sources as Array<{ path: string; header: string | null }>;
    expect(sources).toHaveLength(30);
    expect(sources.find(({ path }) => path === 'src/spice/thirdparty/jsbn.ts')?.header).toContain(
      'Copyright (c) 2003-2005  Tom Wu',
    );
    expect(sources.find(({ path }) => path === 'src/spice/thirdparty/sha1.ts')?.header).toContain(
      'Copyright (c) 1998 - 2009, Paul Johnston & Contributors',
    );
    const keyboardHeader = sources.find(({ path }) => path === 'src/spice/atKeynames.ts')?.header;
    expect(keyboardHeader).toContain('Copyright 1990,91 by Thomas Roell');
    expect(keyboardHeader).toContain('Copyright (c) 1994-2003 by The XFree86 Project, Inc.');
    expect(await readFile(resolve('licenses/spice-client-SOURCE-NOTICES.txt'), 'utf8')).toBe(
      inventory.content,
    );
    expect(await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8')).toContain(
      'licenses/spice-client-SOURCE-NOTICES.txt',
    );
  });

  it('pins a publisher source archive with all mapped SPICE sources and build inputs', async () => {
    const archive = await readFile(resolve('licenses/spice-client-1.2.0-source.tar'));
    expect(await verifySpiceSourceArchive(archive)).toMatchObject({
      files: 50,
      matchingMappedSources: 30,
      upstreamCommit: 'aed3b4f841db65a9ab015e174d69ff4fccbb197f',
    });
    const tampered = Buffer.from(archive);
    tampered[1024] = tampered[1024]! ^ 1;
    await expect(verifySpiceSourceArchive(tampered)).rejects.toThrow(
      'differs from the reviewed commit snapshot',
    );
    const sourceReadme = await readFile(resolve('licenses/spice-client-SOURCE-README.txt'), 'utf8');
    expect(sourceReadme).toContain(
      'a30adf3706f5a03ede1fdcd0785cea4330f86af2c9bbbc75165384ccfcfd9a26',
    );
    expect(sourceReadme).toContain('aed3b4f841db65a9ab015e174d69ff4fccbb197f');
  });

  it.each([
    ['GPL-3.0.txt', '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986'],
    ['LGPL-3.0.txt', 'e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118'],
  ])('pins the reviewed GNU text %s', async (name, checksum) => {
    expect(
      createHash('sha256')
        .update(await readFile(resolve('licenses', name)))
        .digest('hex'),
    ).toBe(checksum);
  });
});
