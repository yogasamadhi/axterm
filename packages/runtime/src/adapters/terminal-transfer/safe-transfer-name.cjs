const MAX_NAME_BYTES = 255;
const MAX_INPUT_CODE_UNITS = 4096;
// Transfer names must never introduce path separators or control characters.
// eslint-disable-next-line no-control-regex
const INVALID_PATH_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/gu;
const WINDOWS_DEVICE_STEM = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/iu;

function prefixWithinBytes(value, budget) {
  let result = '';
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > budget) break;
    result += character;
    used += bytes;
  }
  return result;
}

function fitFileSystemLimit(value, limit) {
  if (Buffer.byteLength(value, 'utf8') <= limit) return value;

  const lastDot = value.lastIndexOf('.');
  const extension = lastDot > 0 ? value.slice(lastDot) : '';
  const extensionBytes = Buffer.byteLength(extension, 'utf8');
  const keepExtension = extensionBytes > 0 && extensionBytes < limit;
  const stem = keepExtension ? value.slice(0, lastDot) : value;
  const suffix = keepExtension ? extension : '';
  const prefix = prefixWithinBytes(stem, limit - Buffer.byteLength(suffix, 'utf8'));
  return prefix ? prefix + suffix : prefixWithinBytes(value, limit);
}

module.exports = function safeTransferName(value, reservedBytes = 0) {
  if (typeof value !== 'string' || value.length === 0) return 'unnamed';

  const bounded = value.slice(0, MAX_INPUT_CODE_UNITS);
  const complete = /[\ud800-\udbff]$/u.test(bounded) ? bounded.slice(0, -1) : bounded;
  const name = complete
    .normalize('NFC')
    .replace(INVALID_PATH_CHARACTERS, '_')
    .trimStart()
    .replace(/[.\s]+$/gu, '');
  if (!name || name === '.' || name === '..') return 'unnamed';

  const stem = name.split('.', 1)[0].trimEnd();
  const limit = Math.max(1, MAX_NAME_BYTES - Math.max(0, Math.floor(reservedBytes)));
  return fitFileSystemLimit(WINDOWS_DEVICE_STEM.test(stem) ? `_${name}` : name, limit);
};
