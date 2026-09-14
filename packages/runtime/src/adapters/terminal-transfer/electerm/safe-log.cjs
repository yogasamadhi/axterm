// Axterm deliberately drops upstream protocol logs because they may contain local paths.
const noop = () => {}
module.exports = { debug: noop, info: noop, warn: noop, error: noop }
