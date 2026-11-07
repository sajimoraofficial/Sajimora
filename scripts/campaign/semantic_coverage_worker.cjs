const path = require('node:path');
require('../test-runtime/windows-userinfo-shim.cjs');
require('tsx/cjs/api').register();
require(path.resolve(__dirname, 'semantic_coverage_worker.ts'));
