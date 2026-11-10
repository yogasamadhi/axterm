/** Production anchors must directly declare every Bundle in the templates they launch. */
export function assertProfileBundleDependencies(
  manifest,
  templates,
  profiles = Object.keys(templates),
) {
  if (!manifest || typeof manifest !== 'object' || !templates || typeof templates !== 'object')
    throw new Error('PROFILE_BUNDLE_DEPENDENCY_INVALID');
  for (const profile of profiles) {
    const bundles = templates[profile]?.bundles;
    if (!Array.isArray(bundles)) throw new Error('PROFILE_TEMPLATE_UNAVAILABLE');
    for (const name of bundles)
      if (
        typeof name !== 'string' ||
        typeof manifest.dependencies?.[name] !== 'string' ||
        !manifest.dependencies[name]
      )
        throw new Error('PROFILE_BUNDLE_DEPENDENCY_MISSING: ' + profile + ': ' + name);
  }
}
