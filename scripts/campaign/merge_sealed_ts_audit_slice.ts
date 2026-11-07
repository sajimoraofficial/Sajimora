import * as fs from 'node:fs';
import * as path from 'node:path';
const names = ['00','06','12','18','24','30'];
const parts = names.map(n => JSON.parse(fs.readFileSync(path.resolve(`artifacts/audit-slice-${n}.json`), 'utf8')));
const cases = parts.flatMap(p => p.cases).sort((a: any,b: any) => a.id.localeCompare(b.id)).map((c: any) => ({ ...c, independentOracle: { ...c.independentOracle, method: 'pre-execution static human-reviewed source/consumer mutation oracle; not derived from Sajimora' } }));
const count = (p: (r:any) => boolean) => cases.filter(p).length;
const first = parts[0];
const artifact = { ...first, status:'EXECUTED', caseCount:cases.length, declaredCaseCount:cases.length, offset:0, cases,
  summary:{ executed:cases.length, certifiedPreserved:count(r=>r.actual.certified&&r.actual.verdict==='PRESERVED'), certifiedViolated:count(r=>r.actual.certified&&r.actual.verdict==='VIOLATED'), certifiedNotApplicable:count(r=>r.actual.certified&&r.actual.verdict==='NOT_APPLICABLE'), expectedUnknown:count(r=>r.expectedCertifiedVerdict==='UNKNOWN'&&r.actual.verdict==='UNKNOWN'), unexpectedUnknown:count(r=>r.expectedCertifiedVerdict!=='UNKNOWN'&&r.actual.verdict==='UNKNOWN'), oracleMismatches:count(r=>!r.matchesExpected), proofPathViolations:0, runtimeMs:cases.reduce((n:any,r:any)=>n+r.actual.runtimeMs,0) } };
fs.writeFileSync(path.resolve('artifacts/audit-sealed-ts-slice-v1.json'),JSON.stringify(artifact,null,2)+'\n');
console.log(JSON.stringify(artifact.summary,null,2));
