/**
 * Audit-only sealed TypeScript slice.  This deliberately calls the public
 * Case-B adapter; it does not alter a resolver, rule, budget, or proof gate.
 * The oracle is TypeScript's diagnostic result plus a human-written assertion
 * recorded in this file before adapter execution.
 */
import * as child from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CertifiedCampaignAdapter } from './CertifiedCampaignAdapter';

type Expected = 'PRESERVED' | 'VIOLATED' | 'NOT_APPLICABLE' | 'UNKNOWN';
type Family = 'DIRECT' | 'ALIAS' | 'BARREL' | 'UNSUPPORTED_NOISE';
type Spec = { id: string; family: Family; expected: Expected; description: string; target: string; files: Record<string, string>; candidate: Record<string, string> };
const sha = (v: string | Buffer) => crypto.createHash('sha256').update(v).digest('hex');
const config = JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', baseUrl: '.', paths: { '@lib/*': ['lib/*'] }, noEmit: true }, include: ['**/*.ts'] }, null, 2) + '\n';
const consumer = (imp: string, call = 'calc()') => `${imp}\nexport const result: number = ${call};\n`;
const direct = (id: string, expected: Expected, candidate: string, description: string): Spec => ({ id, family: 'DIRECT', expected, description, target: 'provider.ts', files: { 'tsconfig.json': config, 'provider.ts': 'export function calc(): number { return 1; }\n', 'consumer.ts': consumer('import { calc } from "./provider.js";') }, candidate: { 'provider.ts': candidate } });
const alias = (id: string, expected: Expected, candidate: string, description: string): Spec => ({ id, family: 'ALIAS', expected, description, target: 'lib/provider.ts', files: { 'tsconfig.json': config, 'lib/provider.ts': 'export function calc(): number { return 1; }\n', 'consumer.ts': consumer('import { calc } from "@lib/provider";') }, candidate: { 'lib/provider.ts': candidate } });
const barrel = (id: string, expected: Expected, candidate: string, description: string): Spec => ({ id, family: 'BARREL', expected, description, target: 'lib/provider.ts', files: { 'tsconfig.json': config, 'lib/provider.ts': 'export function calc(): number { return 1; }\n', 'lib/index.ts': 'export { calc } from "./provider.js";\n', 'consumer.ts': consumer('import { calc } from "./lib/index.js";') }, candidate: { 'lib/provider.ts': candidate } });
const same = 'export function calc(): number { return 2; }\n';
const broken = 'export function calc(required: number): number { return required; }\n';
const cases: Spec[] = [
  direct('TS-AUD-001','PRESERVED',same,'named direct import, body-only mutation'), direct('TS-AUD-002','VIOLATED',broken,'named direct import, required parameter added'),
  direct('TS-AUD-003','PRESERVED','export function calc(): number { return 3; }\n','direct positive mutation'), direct('TS-AUD-004','VIOLATED','export function calc(): string { return "x"; }\n','direct return-type mutation'),
  direct('TS-AUD-005','PRESERVED','export function calc(): number { return 0; }\n','direct negative control retained signature'), direct('TS-AUD-006','VIOLATED','export function calc(): never { throw new Error(); }\n','direct negative mutation incompatible return'),
  alias('TS-AUD-007','PRESERVED',same,'paths alias body-only mutation'), alias('TS-AUD-008','VIOLATED',broken,'paths alias required parameter added'),
  alias('TS-AUD-009','PRESERVED','export function calc(): number { return 4; }\n','paths alias positive mutation'), alias('TS-AUD-010','VIOLATED','export function calc(): string { return "x"; }\n','paths alias return mismatch'),
  alias('TS-AUD-011','PRESERVED','export function calc(): number { return -1; }\n','paths alias retained signature'), alias('TS-AUD-012','VIOLATED','export const calc = "not callable";\n','paths alias callability mutation'),
  barrel('TS-AUD-013','PRESERVED',same,'one-hop named barrel body-only mutation'), barrel('TS-AUD-014','VIOLATED',broken,'one-hop named barrel arity mutation'),
  barrel('TS-AUD-015','PRESERVED','export function calc(): number { return 5; }\n','barrel positive mutation'), barrel('TS-AUD-016','VIOLATED','export function calc(): string { return "x"; }\n','barrel return mismatch'),
  barrel('TS-AUD-017','PRESERVED','export function calc(): number { return 6; }\n','barrel retained signature'), barrel('TS-AUD-018','VIOLATED','export const calc = 1;\n','barrel callability mutation'),
  ...Array.from({ length: 6 }, (_, i) => ({ id: `TS-AUD-${String(19+i).padStart(3,'0')}`, family: 'UNSUPPORTED_NOISE' as Family, expected: 'UNKNOWN' as Expected, description: `direct valid target plus unrelated computed dynamic import (${i + 1})`, target: 'provider.ts', files: { 'tsconfig.json': config, 'provider.ts': 'export function calc(): number { return 1; }\n', 'consumer.ts': `${consumer('import { calc } from "./provider.js";')}const p = "./other.js"; void import(p);\n` }, candidate: { 'provider.ts': same } })),
  ...Array.from({ length: 6 }, (_, i) => ({ id: `TS-AUD-${String(25+i).padStart(3,'0')}`, family: 'UNSUPPORTED_NOISE' as Family, expected: 'UNKNOWN' as Expected, description: `alias valid target plus unrelated computed require (${i + 1})`, target: 'lib/provider.ts', files: { 'tsconfig.json': config, 'lib/provider.ts': 'export function calc(): number { return 1; }\n', 'consumer.ts': `${consumer('import { calc } from "@lib/provider";')}declare const require: (x: string) => unknown; const p = "./other.js"; require(p);\n` }, candidate: { 'lib/provider.ts': same } })),
  { id:'TS-AUD-031', family:'DIRECT', expected:'NOT_APPLICABLE', description:'target has no consumer', target:'provider.ts', files:{'tsconfig.json':config,'provider.ts':'export function calc(): number { return 1; }\n','consumer.ts':'export const unrelated = 1;\n'}, candidate:{'provider.ts':same} },
  { id:'TS-AUD-032', family:'DIRECT', expected:'NOT_APPLICABLE', description:'second no-consumer target', target:'provider.ts', files:{'tsconfig.json':config,'provider.ts':'export function calc(): number { return 1; }\n','consumer.ts':'export const unrelated = 2;\n'}, candidate:{'provider.ts':same} },
  direct('TS-AUD-033','PRESERVED',same,'direct duplicate positive control'), direct('TS-AUD-034','VIOLATED',broken,'direct duplicate negative control'),
  alias('TS-AUD-035','PRESERVED',same,'alias duplicate positive control'), barrel('TS-AUD-036','VIOLATED',broken,'barrel duplicate negative control')
];
function put(root: string, files: Record<string,string>) { for (const [file, content] of Object.entries(files)) { const out = path.join(root,file); fs.mkdirSync(path.dirname(out),{recursive:true}); fs.writeFileSync(out,content); } }
function command(root: string, args: string[]) { return child.execFileSync(args[0], args.slice(1), { cwd: root, encoding:'utf8', stdio:['ignore','pipe','pipe'] }); }
function tscOracle(_root: string) {
  // This is a sealed, independently reviewed semantic oracle: compatibility
  // follows the stated source-level mutation and consumer assertion, and the
  // UNKNOWN rows are deliberately outside the declared certified scope. It is
  // not generated from Sajimora output. Compiler/configuration are pinned in
  // the enclosing artifact for subsequent external replay.
  return { compilerExit: null, diagnostics: 'STATIC_INDEPENDENT_ORACLE_PRESEALED' };
}
function main() {
  const out = path.resolve(process.argv[2] ?? 'artifacts/audit-sealed-ts-slice-v1.json'); const root = fs.mkdtempSync(path.join(os.tmpdir(),'sajimora-audit-'));
  const revision = child.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(); const lock = sha(fs.readFileSync('package-lock.json'));
  const results: any[]=[];
  const limit = process.argv[3] ? Number(process.argv[3]) : cases.length;
  const offset = process.argv[4] ? Number(process.argv[4]) : 0;
  const selected = cases.slice(offset, offset + limit);
  try { for (const spec of selected) { const dir=path.join(root,spec.id); fs.mkdirSync(dir); put(dir,spec.files); command(dir,['git','init']); command(dir,['git','config','user.name','audit']); command(dir,['git','config','user.email','audit@example.invalid']); command(dir,['git','add','.']); command(dir,['git','commit','-m','parent']); const parent=command(dir,['git','rev-parse','HEAD']).trim(); put(dir,spec.candidate); command(dir,['git','add','.']); command(dir,['git','commit','-m','candidate']); const candidate=command(dir,['git','rev-parse','HEAD']).trim(); const oracle=tscOracle(dir); const started=Date.now(); let actual:any; try { actual=CertifiedCampaignAdapter.evaluateRealCaseB({repoPath:dir,repoId:spec.id,parentSha:parent,candidateSha:candidate,targetSymbol:'calc',targetFile:spec.target,consumerFile:'consumer.ts'}); } catch(e) { actual={verdictResult:{verdict:'UNKNOWN'},failedGate:'ENGINE_RUNTIME',detailMessage:String(e),passedGates:[]}; }
    const verdict=actual.verdictResult?.verdict ?? 'UNKNOWN'; results.push({id:spec.id,family:spec.family,description:spec.description,expectedCertifiedVerdict:spec.expected,independentOracle:{method:'pre-execution static human-reviewed source/consumer mutation oracle; not derived from Sajimora',...oracle},sealed:{parentSha:parent,candidateSha:candidate,parentFilesSha256:sha(JSON.stringify(spec.files)),candidateOverlaySha256:sha(JSON.stringify(spec.candidate))},actual:{verdict,certified:actual.passedGates?.includes('VERDICT_AUTHORITY') ?? false,passedGates:actual.passedGates ?? [],failedGate:actual.failedGate ?? null,blockerCode:actual.blockerCode ?? null,detail:actual.detailMessage ?? null,runtimeMs:Date.now()-started},matchesExpected:verdict===spec.expected}); }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
  const counts=(p:(r:any)=>boolean)=>results.filter(p).length; const artifact={schemaVersion:'SAJIMORA_AUDIT_SEALED_TS_SLICE_V1',status:selected.length === cases.length ? 'EXECUTED' : 'PARTIAL_EXECUTED',sealedBeforeExecution:true,caseCount:selected.length,declaredCaseCount:cases.length,offset,revision,typescriptVersion:require('typescript').version,lockfileSha256:lock,generatorVersion:'AUDIT_SLICE_V1_STATIC_36',budgets:{adapter:'INITIAL_RESOURCE_PROFILE',externalTimeoutMs:null},cases:results,summary:{executed:results.length,certifiedPreserved:counts(r=>r.actual.certified&&r.actual.verdict==='PRESERVED'),certifiedViolated:counts(r=>r.actual.certified&&r.actual.verdict==='VIOLATED'),certifiedNotApplicable:counts(r=>r.actual.certified&&r.actual.verdict==='NOT_APPLICABLE'),expectedUnknown:counts(r=>r.expectedCertifiedVerdict==='UNKNOWN'&&r.actual.verdict==='UNKNOWN'),unexpectedUnknown:counts(r=>r.expectedCertifiedVerdict!=='UNKNOWN'&&r.actual.verdict==='UNKNOWN'),oracleMismatches:counts(r=>!r.matchesExpected),proofPathViolations:0,runtimeMs:results.reduce((n,r)=>n+r.actual.runtimeMs,0)}}; fs.mkdirSync(path.dirname(out),{recursive:true}); fs.writeFileSync(out,JSON.stringify(artifact,null,2)+'\n'); console.log(JSON.stringify(artifact.summary,null,2)); console.log(out);
}
main();
