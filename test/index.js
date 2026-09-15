/**
 * test/index.js
 * Default entry point for test suite: delegates directly to test/run-all.js
 */

const { main } = require('./run-all');

if (require.main === module) {
    main();
}

module.exports = { main };
