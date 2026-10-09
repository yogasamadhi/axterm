/* eslint-disable @typescript-eslint/no-require-imports */
const { randomBytes } = require('node:crypto');

// Used only for private, same-directory transfer staging names. A 128-bit
// nonce makes collisions negligible; exclusive creation remains mandatory.
module.exports = function transferNonce() {
  return randomBytes(16).toString('hex');
};
