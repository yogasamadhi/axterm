/* eslint-disable @typescript-eslint/no-require-imports */
const { randomBytes } = require('node:crypto')
module.exports = () => randomBytes(5).toString('hex').slice(0, 7)
