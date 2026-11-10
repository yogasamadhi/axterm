import type { ProfileTemplate } from './profile-boot.ts';
/** Application-owned catalog shared by both launchers and installed-Profile management. */
const applicationBundles = Object.freeze([
  '@axterm/bundle-base',
  '@axterm/bundle-web',
  '@axterm/bundle-catalog',
  '@axterm/bundle-configuration',
  '@axterm/bundle-terminals',
  '@axterm/bundle-connections',
  '@axterm/bundle-files',
  '@axterm/bundle-transfers',
  '@axterm/bundle-remote-desktop',
  '@axterm/bundle-automation',
  '@axterm/bundle-workspace',
  '@axterm/bundle-engine-pi',
  '@axterm/bundle-ai',
  '@axterm/bundle-plugins',
  '@axterm/bundle-market',
]);
export const PROFILE_TEMPLATES: Readonly<Record<string, ProfileTemplate>> = Object.freeze({
  web: Object.freeze({ bundles: applicationBundles }),
  desktop: Object.freeze({ bundles: applicationBundles }),
  headless: Object.freeze({
    bundles: Object.freeze(['@axterm/bundle-base', '@axterm/bundle-headless']),
  }),
});
