import {
  createSshBookmarkSchema,
  createBookmarkSchema,
  type CreateSshBookmarkInput,
  type CreateBookmarkInput,
} from '@axterm/plugin-api/catalog';
/** Validate the entire draft before Vault admission. A provisional proxy reference is used only in this local validation copy. */
export function validateSshSaveInput(
  input: CreateSshBookmarkInput,
  newProxy: boolean,
): CreateSshBookmarkInput {
  const copy = structuredClone(input);
  const proxy = copy.host.proxy;
  const provisional =
    newProxy &&
    proxy?.mode === 'custom' &&
    !!proxy.endpoint.username &&
    !proxy.endpoint.credentialRef;
  if (provisional && proxy?.mode === 'custom')
    proxy.endpoint.credentialRef = 'catalog-validation-only';
  const parsed = createSshBookmarkSchema.parse(copy);
  if (provisional && parsed.host.proxy.mode === 'custom')
    parsed.host.proxy.endpoint.credentialRef = null;
  return parsed;
}
export function validateProtocolSaveInput(
  input: CreateBookmarkInput,
  newProxy: boolean,
): CreateBookmarkInput {
  const copy = structuredClone(input);
  const settings =
    copy.protocol === 'rdp'
      ? copy.rdp
      : copy.protocol === 'vnc'
        ? copy.vnc
        : copy.protocol === 'spice'
          ? copy.spice
          : undefined;
  const proxy = settings?.proxy;
  const provisional =
    newProxy &&
    proxy?.mode === 'custom' &&
    !!proxy.endpoint.username &&
    !proxy.endpoint.credentialRef;
  if (provisional && proxy?.mode === 'custom')
    proxy.endpoint.credentialRef = 'catalog-validation-only';
  const parsed = createBookmarkSchema.parse(copy);
  const validated =
    parsed.protocol === 'rdp'
      ? parsed.rdp
      : parsed.protocol === 'vnc'
        ? parsed.vnc
        : parsed.protocol === 'spice'
          ? parsed.spice
          : undefined;
  if (provisional && validated?.proxy.mode === 'custom')
    validated.proxy.endpoint.credentialRef = null;
  return parsed;
}
