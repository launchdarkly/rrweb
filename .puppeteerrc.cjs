const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Changes the cache location for Puppeteer.
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
  // Only pin a specific revision when not using system Chrome
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? {}
    : { browserRevision: '115.0.5763.0' }),
};
