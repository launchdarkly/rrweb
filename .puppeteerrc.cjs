const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Changes the cache location for Puppeteer.
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
  // Skip browserRevision when using PUPPETEER_EXECUTABLE_PATH (CI uses a
  // single Chrome binary for all puppeteer versions via this env var).
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? {}
    : { browserRevision: '115.0.5763.0' }),
};
