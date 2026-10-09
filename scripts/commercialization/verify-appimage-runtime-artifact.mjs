/** Bind the AppImage actually executed by Playwright to the release hash manifest. */
export function verifyAppImageRuntimeArtifact(manifest, expectedVersion, observed) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.platform !== 'linux-x64' ||
    manifest?.product?.name !== 'axterm' ||
    manifest?.product?.version !== expectedVersion ||
    !Array.isArray(manifest?.artifacts)
  ) {
    throw new Error('AppImage runtime manifest has the wrong product, version or platform');
  }
  const appImages = manifest.artifacts.filter(
    (artifact) => typeof artifact?.path === 'string' && artifact.path.endsWith('.AppImage'),
  );
  if (appImages.length !== 1) {
    throw new Error(`Expected one AppImage in the runtime manifest; found ${appImages.length}`);
  }
  const [artifact] = appImages;
  if (
    artifact.path !== observed.name ||
    artifact.bytes !== observed.bytes ||
    artifact.sha256 !== observed.sha256
  ) {
    throw new Error('The executed AppImage bytes do not match the release hash manifest');
  }
  return artifact;
}
