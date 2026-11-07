const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const v8 = require('node:v8');
const {createHash} = require('node:crypto');
const {isDeepStrictEqual} = require('node:util');
const directory = path.resolve(process.argv[2] || '');
const measurements = JSON.parse(fs.readFileSync(path.join(directory, 'measurements.json'), 'utf8'));
const references = {
  'thingsboard-java': 'rust/audit/thingsboard-pilot/semantic-milestone/backend.json',
  'thingsboard-typescript': 'rust/audit/thingsboard-pilot/semantic-milestone/frontend.json',
  'fineract-java': 'rust/audit/holdout/semantic/backend.json',
  'mifos-typescript': 'rust/audit/holdout/semantic/frontend.json',
};
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ['service','serviceId','targetServiceId'].includes(key) ? '<benchmark-service>' : normalize(item)]));
}
const rows = measurements.map(measurement => {
  const folder = path.join(directory, measurement.name);
  const log = fs.readFileSync(path.join(folder, 'stderr.log'), 'utf8');
  const artifactPath = path.join(folder, 'artifact.json');
  const artifact = fs.existsSync(artifactPath) ? JSON.parse(fs.readFileSync(artifactPath, 'utf8')) : null;
  const reference = JSON.parse(fs.readFileSync(references[measurement.name], 'utf8'));
  const stagePath = path.join(folder, 'stages.jsonl');
  const stages = fs.existsSync(stagePath) ? fs.readFileSync(stagePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const durations = [];
  for (let index = 1; index < stages.length; index++) durations.push({from: stages[index-1].stage, to: stages[index].stage, elapsedMs: stages[index].elapsedMs-stages[index-1].elapsedMs});
  const items = artifact && (artifact.payload.endpoints || artifact.payload.clientContracts);
  return {...measurement, snapshotMs: Number(log.match(/Snapshot captured in (\d+)ms/)?.[1] || 0), loggedExtractionMs: Number(log.match(/(?:extracted \d+ endpoints in|Extraction complete in) (\d+)ms/)?.[1] || 0), entries: items?.length ?? null, blockers: artifact?.completeness.blockers.length ?? null,
    sourceCounts: stages.find(stage => stage.stage === 'source-counts')?.counts ?? null, stages, durations,
    parity: {reference: references[measurement.name], payloadIgnoringServiceLabelsEqual: artifact ? isDeepStrictEqual(normalize(artifact.payload), normalize(reference.payload)) : false, completenessEqual: artifact ? isDeepStrictEqual(artifact.completeness, reference.completeness) : false}};
});
const summary = {environment: {node: process.version,platform: process.platform,architecture: process.arch,logicalCpus: os.cpus().length,totalMemoryBytes: os.totalmem(),defaultV8HeapLimitBytes: v8.getHeapStatistics().heap_size_limit}, scope:'Full current contract source exporters, fresh processes. This path does not populate the existing SQLite semantic database. Parsing, type resolution and extraction overlap; checkpoint durations are pipeline stages, not isolated algorithm costs.', rows};
const sourceFiles = [];
function collect(folder) {
  for (const entry of fs.readdirSync(folder, {withFileTypes: true})) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) collect(file);
    else if (/\.(ts|cjs|ps1|json)$/.test(entry.name)) sourceFiles.push(file);
  }
}
for (const folder of ['packages/analysis/src','packages/core/src','scripts/sajimora','scripts/test-runtime']) collect(folder);
sourceFiles.push('package.json','package-lock.json','tsconfig.json');
const manifest = Object.fromEntries(sourceFiles.sort().filter(file => fs.existsSync(file)).map(file => [file.replace(/\\/g,'/'),createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
fs.writeFileSync(path.join(directory, 'source-manifest.json'), JSON.stringify({recordedAt: new Date().toISOString(),note:'Post-run source hashes; repository contents are uncommitted. Benchmark commands and frozen input revisions are in measurements.json.',sha256:manifest}, null, 2));
fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
const report = ['# Cold source-extraction baseline — 2026-10-04', '', summary.scope, '', '| Run | Cold time | Sampled tree RSS peak | Private bytes peak | Entries | Blockers | Payload parity* |', '|---|---:|---:|---:|---:|---:|---|', ...rows.map(row => `| ${row.name} | ${(row.elapsedMs/1000).toFixed(2)} s | ${(row.sampledTreePeakRssBytes/1024**3).toFixed(2)} GiB | ${(row.sampledTreePeakPrivateBytes/1024**3).toFixed(2)} GiB | ${row.entries} | ${row.blockers} | ${row.parity.payloadIgnoringServiceLabelsEqual && row.parity.completenessEqual ? 'PASS' : 'REVIEW'} |`), '', '*Service/serviceId/targetServiceId labels are normalized because benchmark CLI labels differ from the checkpoint. All remaining payload and completeness fields are compared.', '', 'Cold means a fresh analyzer process without a persisted index. The OS filesystem cache was not cleared. Runs are sequential, one observation per repository/language; these are not statistical medians or fully cold-disk benchmarks.', '', 'Memory is sampled across the exporter and discovered descendants every 200 ms plus sampler overhead. Short-lived children may be missed; summed RSS can count shared pages more than once. Private bytes are committed private memory, not resident memory. The root process OS peak is recorded separately.', '', 'See summary.json for checkpoint timings, memory, source file/byte/physical-line counts where recorded, revision IDs, commands and environment. Physical lines include comments and blank lines. Existing incompleteness remains advisory; performance results do not qualify production accuracy.', '', 'No SQLite write cost is claimed: the measured current export path does not write a SQLite index. Seal/write checkpoints cover JSON artifact creation.', ''];
for (const row of rows) {
  if (!row.stages.length) continue;
  report.push(`## ${row.name}`, '', '| Source extension | Files | Git blob bytes | Physical lines |', '|---|---:|---:|---:|');
  for (const [extension, counts] of Object.entries(row.sourceCounts || {})) report.push(`| .${extension} | ${counts.files} | ${counts.bytes} | ${counts.physicalLines} |`);
  report.push('', '| Checkpoint interval | Time | RSS at end | JS heap used at end |', '|---|---:|---:|---:|');
  for (const duration of row.durations) {
    const stage = row.stages.find(item => item.stage === duration.to);
    report.push(`| ${duration.from} → ${duration.to} | ${(duration.elapsedMs/1000).toFixed(3)} s | ${(stage.rss/1024**3).toFixed(2)} GiB | ${(stage.heapUsed/1024**3).toFixed(2)} GiB |`);
  }
  report.push('');
}
fs.writeFileSync(path.join(directory, 'RESULTS.md'), report.join('\n'));
console.log(JSON.stringify(rows.map(row => ({name:row.name,seconds:row.elapsedMs/1000,rssGiB:row.sampledTreePeakRssBytes/1024**3,parity:row.parity})), null, 2));
