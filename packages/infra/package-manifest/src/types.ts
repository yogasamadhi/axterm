// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/util/package-manifest/src/types.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * Shared declarations for package.json fields and plugin display metadata.
 * Each reader owns JSON validation and resolved defaults.
 * @module @axterm/infra-package-manifest/types
 */

/** Package identity and metadata; local profile readers may accept a partial declaration. */
export interface AxtermPackageManifest {
  /** Published npm package name. */
  name: string;
  /** Published npm package version. */
  version: string;
  /** Package summary for discovery and display. */
  description?: string;
  /** SVG, PNG, JPEG, or WebP file relative to this manifest's directory, at most 256 KiB and contained there after realpath resolution. */
  icon?: string;
  /** Prevent npm publication, for example for local profile projects. */
  private?: boolean;
  /** Packages installed alongside this package. */
  dependencies?: Record<string, string>;
  /** Packages that may be absent when installation or platform checks skip them. */
  optionalDependencies?: Record<string, string>;
  /** Compatible versions of packages supplied by the consuming project. */
  peerDependencies?: Record<string, string>;
  /** Runtime requirements; AXTERM compatibility is declarative until a reader enforces it. */
  engines?: AxtermEnginesManifest;
  /** AXTERM-specific author declarations. */
  axterm?: AxtermManifest;
}

/** Public author fields under `package.json.axterm`; a package may declare several roles. */
export interface AxtermManifest {
  /** Manifest format version, independent of the npm package and Session format versions. */
  manifestVersion?: 1;
  /** Bundle metadata consumed by the profile launcher. */
  bundle?: AxtermBundleManifest;
  /** Profile metadata consumed by the profile launcher. */
  profile?: AxtermProfileManifest;
  /** Client module loading and build metadata. */
  client?: AxtermClientManifest;
}

/** Literal text or translations indexed by lowercase language id, with a required English fallback. */
export type LocalizedText = string | { readonly en: string; readonly [locale: string]: string };

/** Validated plugin display fields and diagnostics from exported locales, manifests, or icon files. */
export interface PluginLocalizedMeta {
  /** Display title; omission preserves the consumer's technical-name fallback. */
  readonly title?: LocalizedText;
  /** Display introduction after locale and package-field fallback. */
  readonly description?: LocalizedText;
  /** Base64 image data URL from a package root's manifest icon or an exported `<specifier>/icon`; render as an image, not inline markup. */
  readonly icon?: string;
  /** Unmodified local metadata diagnostic; the plugin remains manageable. */
  readonly error?: string;
}

/** Runtime version requirements under `package.json.engines`. */
export interface AxtermEnginesManifest {
  /** Compatible AXTERM versions as a SemVer range, including an exact version. */
  axterm?: string;
  /** Compatible Node.js versions. */
  node?: string;
  /** Compatible npm versions. */
  npm?: string;
  /** Requirements for additional runtimes or package managers. */
  [engine: string]: string | undefined;
}

/** The configuration layer exported by a bundle package. */
export interface AxtermBundleManifest {
  /** Supported Node Host platform names; omission allows every operating system. */
  platforms?: string[];
  /** One patch file path, or an ordered list applied in sequence, each relative to the declaring package root. */
  patch: string | string[];
  /** Show the bundle in GUI lists before the profile enables or installs it; omission means true. */
  listedByDefault?: boolean;
}

/** The bundle composition declared by a profile directory. */
export interface AxtermProfileManifest {
  /** Ordered bundle layer list, using installed package names. */
  bundles?: string[];
}

/** Client module declaration read by client-modules and the client build. */
export interface AxtermClientManifest {
  /** Client platform identifier; the Web consumer selects `web`. */
  platform: string;
  /** Informational package-name dependencies, not Cordis service injection. */
  inject?: string[];
  /** Boot phase-one registration barrier; absent means the shared application batch. */
  immediately?: boolean;
  /**
   * Exact module-table requests beyond the implicit client baseline, including
   * subpaths such as `<pkg>/client`; absent means baseline externals only.
   * Type-only imports are erased and create no module request.
   */
  external?: string[];
}
