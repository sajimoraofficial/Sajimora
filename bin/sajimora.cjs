#!/usr/bin/env node
const path = require('node:path');
const fs = require('node:fs');

const distAnalyze = path.resolve(__dirname, '../dist/analyze.cjs');
if (fs.existsSync(distAnalyze)) {
  require(distAnalyze);
} else {
  require('../scripts/test-runtime/windows-userinfo-shim.cjs');
  require('tsx/cjs/api').register();
  const analyzeScript = path.resolve(__dirname, '../scripts/sajimora/analyze.ts');
  process.argv = [process.argv[0], analyzeScript, ...process.argv.slice(2)];
  require(analyzeScript);
}

