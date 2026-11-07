const path = require('node:path');
require('./windows-userinfo-shim.cjs');
require('tsx/cjs/api').register();
const target = process.argv[2];
if (!target) throw new Error('Missing TypeScript command entrypoint.');
process.argv.splice(1, 1); // expose argv as: node, entrypoint, command arguments
require(path.resolve(target));
