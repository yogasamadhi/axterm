// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/boot/app-boot/src/bundle-platform.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Host operating-system admission for optional bundle layers. */

const NODE_PLATFORMS: readonly string[] = Object.freeze([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd',
] satisfies NodeJS.Platform[]);

/** A valid bundle declaration excludes the operating system running AXTERM. */
export class UnsupportedBundlePlatformError extends Error {
  /**
   * @param platforms Node platform names supported by the bundle.
   * @param platform Operating system of the AXTERM Host.
   */
  constructor(platforms: readonly string[], platform: string) {
    super(
      `Bundle supports Host platforms ${platforms.join(', ')}; the AXTERM Host is running ${platform}`,
    );
    this.name = 'UnsupportedBundlePlatformError';
  }
}

/**
 * Validate package metadata and reject an unsupported Host before selecting or composing a bundle.
 * @param platforms The optional `axterm.bundle.platforms` field read from package.json.
 * @param platform Operating system of the AXTERM Host, from Node's `process.platform`.
 * @throws When the declaration is malformed or excludes the Host; omission allows every platform.
 */
export function assertBundlePlatform(platforms: unknown, platform: string): void {
  if (platforms === undefined) return;
  if (
    !Array.isArray(platforms) ||
    platforms.length === 0 ||
    !platforms.every(
      (value): value is string => typeof value === 'string' && NODE_PLATFORMS.includes(value),
    )
  ) {
    throw new Error('axterm.bundle.platforms must be a nonempty list of Node platform names');
  }
  if (!platforms.includes(platform)) throw new UnsupportedBundlePlatformError(platforms, platform);
}
