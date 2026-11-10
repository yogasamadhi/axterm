const validation = Object.freeze({
  purpose: 'migration-validation',
  productCutover: false,
  migrationValidation: true,
  name: 'axterm-level3-validation',
  appId: 'dev.axterm.migration.validation',
  productName: 'Axterm Level3 Validation',
  executableName: 'axterm-level3-validation',
});
const product = Object.freeze({
  purpose: 'desktop-application',
  productCutover: true,
  migrationValidation: false,
  name: 'axterm',
  appId: 'dev.axterm.desktop',
  productName: 'Axterm',
  executableName: 'axterm',
});
export function packageIdentity(production = false) {
  if (typeof production !== 'boolean') throw Error('Invalid desktop package mode');
  return production ? product : validation;
}
/** The marker describes artifact mode, not completed acceptance or a Git operation. */
export function desktopPackageIdentity(record, manifest) {
  const identity = [validation, product].find((value) => value.purpose === record?.purpose);
  if (
    !identity ||
    record.productCutover !== identity.productCutover ||
    (manifest &&
      (manifest.main !== 'lib/shell/main.js' ||
        manifest.axterm?.migrationValidation !== identity.migrationValidation ||
        (identity.productCutover && manifest.name !== identity.name)))
  )
    throw Error('Invalid new-architecture desktop package identity');
  return identity;
}
