// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/boot/app-boot/src/plugin-compatibility.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Evaluate plugin axterm requirements (`engines.axterm`, else axterm peers) without importing plugin code. */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

/** Unmet axterm requirements and the exact plugin/runtime exemption decision. */
export interface PluginCompatibility {
  name: string;
  version: string;
  runtimeVersion: string;
  /** Only requirements the running axterm version does not satisfy: `engines.axterm`, or axterm peer package names. */
  requirements: Record<string, string>;
  exempted: boolean;
}

function objectOf(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function runtimeVersionOf(value: unknown): string {
  if (typeof value !== 'string' || semver.valid(value) === null) {
    throw new Error(
      `Invalid axterm runtime version: ${JSON.stringify(value)}; expected a semantic version`,
    );
  }
  return value;
}

function identityField(manifest: Record<string, unknown>, field: 'name' | 'version'): string {
  const value = Object.hasOwn(manifest, field) ? manifest[field] : undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `Plugin manifest ${field} must be a non-empty string when axterm requirements are unmet`,
    );
  }
  return value;
}

/**
 * Read this app-boot package's version in both source and bundled installations.
 * @returns the validated runtime semantic version, preserving its exact spelling.
 * @throws if package.json cannot be read or its version is missing or invalid.
 */
export function getAxtermRuntimeVersion(): string {
  // The executable's virtual filesystem intercepts string paths, not URL arguments.
  const filename = fileURLToPath(new URL('../package.json', import.meta.url));
  const manifest = objectOf(JSON.parse(fs.readFileSync(filename, 'utf8')), 'app-boot package.json');
  return runtimeVersionOf(Object.hasOwn(manifest, 'version') ? manifest.version : undefined);
}

function satisfies(runtimeVersion: string, range: string): boolean {
  return (
    range.trim() !== '' && semver.satisfies(runtimeVersion, range, { includePrerelease: true })
  );
}

export type RuntimePublicVersions = Readonly<Record<string, string | undefined>>;
const PUBLIC_PACKAGES = new Set([
  '@axterm/plugin-api',
  '@axterm/engine-api',
  '@axterm/ui',
  '@axterm/remote-generator',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/schemastery',
  ...['loader', 'include', 'group', 'timer', 'hmr', 'logger-console'].map(
    (name) => `@deepseek-ai/cordis-plugin-${name}`,
  ),
]);

function installedPublicVersions(): RuntimePublicVersions {
  const require = createRequire(import.meta.url);
  return Object.fromEntries(
    [...PUBLIC_PACKAGES].map((name) => {
      try {
        const manifest = objectOf(
          JSON.parse(fs.readFileSync(require.resolve(`${name}/package.json`), 'utf8')),
          'Public package manifest',
        );
        return [name, runtimeVersionOf(manifest.version)];
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND')
          return [name, undefined];
        throw error;
      }
    }),
  );
}

function unmetRequirements(
  fields: Record<string, unknown>,
  runtimeVersion: string,
  versions: RuntimePublicVersions,
): Record<string, string> {
  const engines = Object.hasOwn(fields, 'engines')
    ? objectOf(fields.engines, 'Plugin manifest engines')
    : {};
  if (Object.hasOwn(engines, 'axterm')) {
    const range = engines.axterm;
    if (typeof range !== 'string')
      throw new Error('Plugin manifest engines.axterm must be a string');
    return satisfies(runtimeVersion, range) ? {} : { 'engines.axterm': range };
  }
  if (!Object.hasOwn(fields, 'peerDependencies')) return {};
  const dependencies = objectOf(fields.peerDependencies, 'Plugin manifest peerDependencies');
  const unmet: Record<string, string> = {};
  for (const [name, range] of Object.entries(dependencies)) {
    if (typeof range !== 'string') {
      throw new Error(`Plugin manifest peerDependencies[${JSON.stringify(name)}] must be a string`);
    }
    if (!PUBLIC_PACKAGES.has(name)) continue;
    const installed = versions[name];
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range)
      ? (installed ?? '')
      : range;
    if (installed === undefined || !satisfies(installed, requirement)) unmet[name] = range;
  }
  return unmet;
}

/**
 * Check the plugin's axterm requirements against the runtime. An own `engines.axterm` range decides alone and
 * peerDependencies are ignored; otherwise each public SDK and Cordis peer must match its own installed package version.
 * Prereleases participate in ranges. For peers only, workspace:^, workspace:~, and workspace:* refer to
 * the current runtime; other empty or invalid ranges, including any workspace: `engines.axterm`, are unmet.
 * @param manifest - parsed plugin package.json; inherited fields are ignored.
 * @param exemptions - exact plugin name@version keys mapped to exact runtime versions.
 * @param runtimeVersion - running axterm version, defaulting to this app-boot package.
 * @returns unmet requirements and exemption status, or undefined when every requirement is met.
 * @throws for malformed manifest engines or peer fields, invalid runtime versions, or missing identity on a mismatch.
 */
export function evaluatePluginCompatibility(
  manifest: object,
  exemptions: Readonly<Record<string, readonly string[]>> = {},
  runtimeVersion = getAxtermRuntimeVersion(),
  versions?: RuntimePublicVersions,
): PluginCompatibility | undefined {
  runtimeVersionOf(runtimeVersion);
  const fields = objectOf(manifest, 'Plugin manifest');
  const requirements = unmetRequirements(
    fields,
    runtimeVersion,
    Object.hasOwn(objectOf(fields.engines ?? {}, 'Plugin manifest engines'), 'axterm')
      ? {}
      : (versions ?? installedPublicVersions()),
  );
  if (Object.keys(requirements).length === 0) return undefined;
  const name = identityField(fields, 'name');
  const version = identityField(fields, 'version');
  const key = `${name}@${version}`;
  const exemptedVersions = Object.hasOwn(exemptions, key) ? exemptions[key] : undefined;
  const exempted = exemptedVersions?.includes(runtimeVersion) === true;
  return { name, version, runtimeVersion, requirements, exempted };
}

/**
 * Describe unmet requirements, their risk, and the exact-version remedy.
 * Surfaces with their own grant mechanism or locale render the structured result themselves.
 * @param issue - incompatible plugin/runtime result, including exempted mismatches.
 * @returns an English diagnostic for logs and stderr.
 */
export function pluginCompatibilityWarning(issue: PluginCompatibility): string {
  const key = `${issue.name}@${issue.version}`;
  return (
    `Plugin ${key} is incompatible with axterm ${issue.runtimeVersion}: requirements ${JSON.stringify(issue.requirements)}. ` +
    'Running it may cause crashes or data loss. ' +
    'Update the plugin or install a plugin version compatible with this axterm runtime. ' +
    `To accept this risk explicitly, grant the exact-version exemption for ${key} on axterm ${issue.runtimeVersion} with \`axterm plugin allow-version\` or the plugin manager, then retry the installation or restart axterm. ` +
    `Exact-version exemption: ${issue.exempted ? 'active' : 'not active'}.`
  );
}
