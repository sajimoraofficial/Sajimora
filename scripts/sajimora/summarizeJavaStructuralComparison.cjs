const fs = require('node:fs');
const path = require('node:path');
const {isDeepStrictEqual: equal} = require('node:util');
const directory = path.resolve(process.argv[2]);
const comparison = JSON.parse(fs.readFileSync(path.join(directory, 'structural-comparison.json'), 'utf8'));
const reports = comparison.reports.map(report => {
  const result = {name: report.name, mismatchedFiles: report.mismatchedFiles, missingLegacyClasses: 0,
    missingOrChangedLegacyMembers: 0, extraRustClasses: 0, extraRustMembers: 0,
    classMetadataDifferenceFiles: 0, importDifferenceFiles: 0};
  const lines = fs.readFileSync(path.join(directory, report.name, 'structural-mismatches.jsonl'), 'utf8').trim();
  for (const line of lines ? lines.split('\n') : []) {
    const row = JSON.parse(line);
    if (!equal(row.rustImports, row.legacyImports)) result.importDifferenceFiles++;
    let classMetadataDiff = false;
    for (const legacy of row.legacy) {
      const rust = row.rust.find(value => value.name === legacy.name);
      if (!rust) { result.missingLegacyClasses++; continue; }
      if (!equal(rust.annotations, legacy.annotations) || rust.kind !== legacy.kind) classMetadataDiff = true;
      for (const kind of ['fields', 'methods']) {
        for (const member of legacy[kind]) {
          if (!rust[kind].some(value => equal(value, member))) result.missingOrChangedLegacyMembers++;
        }
      }
    }
    if (classMetadataDiff) result.classMetadataDifferenceFiles++;
    for (const rust of row.rust) {
      const legacy = row.legacy.find(value => value.name === rust.name);
      if (!legacy) { result.extraRustClasses++; continue; }
      for (const kind of ['fields', 'methods']) {
        for (const member of rust[kind]) {
          if (!legacy[kind].some(value => equal(value, member))) result.extraRustMembers++;
        }
      }
    }
  }
  return result;
});
const output = {scope: 'Differences within the explicitly limited structural projection; extra Rust facts require source adjudication and do not establish semantic parity.', reports};
fs.writeFileSync(path.join(directory, 'structural-difference-summary.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
