import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {ArtifactComparisonEngine} from '../../packages/analysis/src/sajimora/cross-language/ArtifactComparisonEngine';
import {sealEnvelope,canonicalJson} from '../../packages/analysis/src/sajimora/cross-language/ContractArtifactEnvelope';

const root=path.resolve(__dirname,'../..');
const binary=process.env.SAJIMORA_BINARY || path.join(root,'rust/target/release/sajimora.exe');
const fixture=(name:string)=>JSON.parse(fs.readFileSync(path.join(root,'rust/fixtures/envelopes',name+'.json'),'utf8'));
const clone=(value:any)=>JSON.parse(JSON.stringify(value));
const backend=fixture('backend_same'),frontend=fixture('frontend_complete');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sajimora-report-parity-'));
const cases:{name:string;backend:any;frontend:any;frontendChange:boolean}[]=[];
function add(name:string,mutate:(b:any,f:any)=>void) {
  for(const frontendChange of [false,true]) {
    const b=clone(backend),f=clone(frontend);mutate(b,f);
    cases.push({name:name+(frontendChange?':frontend-change':':backend-change'),backend:b,frontend:f,frontendChange});
  }
}
add('identical',()=>{});
for (const value of ['EMAIL','quoted "literal"','backslash \\ literal','Unicode \u00e9']) add('literal-id-'+value,(b,f)=>{
  b.payload.endpoints[0].body={kind:'LITERAL',value};
  f.payload.clientContracts[0].expectedResponse={kind:'OBJECT',properties:[]};
});
add('unresolved-route-never-links',(_,f)=>{f.payload.clientContracts[0].normalizedRoute='<dynamic>';});
for(const field of ['pathParameters','queryParameters','headers']) for(const constrained of [false,true]) add(field+(constrained?'-constrained':'-required'),b=>{
  b.payload.endpoints[0][field]=[{name:'token',type:{kind:'PRIMITIVE',scalar:'string'},required:!constrained,...(constrained?{validationConstraints:[{kind:'NOT_BLANK'}]}:{})}];
});
for(const expected of [{kind:'UNKNOWN',reason:'untyped'},{kind:'PRIMITIVE',scalar:'void'},{kind:'OBJECT',properties:[]}]) add('bodyless-'+expected.kind+('scalar' in expected?'-'+expected.scalar:''),(b,f)=>{
  b.payload.endpoints[0].body=null;f.payload.clientContracts[0].expectedResponse=expected;
});
for(const produced of ['string','number','boolean','bigint','void','any']) for(const accepted of ['string','number','boolean','bigint','void','any']) add(produced+'-to-'+accepted,(b,f)=>{
  b.payload.endpoints[0].body={kind:'PRIMITIVE',scalar:produced};f.payload.clientContracts[0].expectedResponse={kind:'PRIMITIVE',scalar:accepted};
  f.payload.clientContracts[0].consumers=[{file:'View.tsx',line:4,column:9,usage:'renders response'}];
});
for(const produced of ['string','number','boolean','bigint','void','any']) for(const accepted of ['string','number','boolean','bigint','void','any']) add('request-'+produced+'-to-'+accepted,(b,f)=>{
  b.payload.endpoints[0].identity.direction='REQUEST';b.payload.endpoints[0].identity.httpMethod='POST';
  b.payload.endpoints[0].body={kind:'PRIMITIVE',scalar:accepted};
  f.payload.clientContracts[0].httpMethod='POST';f.payload.clientContracts[0].requestBody={kind:'PRIMITIVE',scalar:produced};
});
add('artifact-incomplete',(b,f)=>{b.completeness.complete=false;f.completeness.complete=false;});
for(const code of ['UNRESOLVED_JAVA_GENERIC','UNRESOLVED_JACKSON_CONFIG','DYNAMIC_URL']) add(code,b=>{
  b.completeness.complete=false;b.completeness.blockers=[{code,message:'Extraction qualification pending',file:'Controller.java'}];
});
for (const kind of ['NOT_NULL','NOT_BLANK','NOT_EMPTY','SIZE','MIN','MAX','PATTERN','EMAIL']) add('wire-constraint-'+kind,(_,f)=>{f.payload.clientContracts[0].expectedResponse.properties[0].validationConstraints=[{kind}];});
function normalize(report:any):string {
  // JSON omits undefined optional fields. Ordering of sets is immaterial;
  // every report field, finding ID, source column and evidence value is checked.
  const value=clone(report);
  delete value.scopedChanges;
  if (value.artifacts?.targets) {
    for (const t of value.artifacts.targets) {
      delete t.applicability;
    }
  }
  value.findings.sort((a:any,b:any)=>a.id.localeCompare(b.id));
  for (const finding of value.findings) finding.evidence.sort((a:any,b:any)=>canonicalJson(a).localeCompare(canonicalJson(b)));
  for(const findings of Object.values(value.delta??{}) as any[][]){findings.sort((a:any,b:any)=>a.id.localeCompare(b.id));for(const finding of findings)finding.evidence.sort((a:any,b:any)=>canonicalJson(a).localeCompare(canonicalJson(b)));}
  value.blockers.sort((a:any,b:any)=>canonicalJson(a).localeCompare(canonicalJson(b)));
  value.completeness.unresolvedEvidence.sort();
  return canonicalJson(value);
}
const results:{name:string;verdict:string;findings:number}[]=[];
try {
  for(const test of cases) {
    const b=sealEnvelope(test.backend),f=sealEnvelope(test.frontend);
    const base=test.frontendChange?f:sealEnvelope(clone(backend));
    const candidate=test.frontendChange?f:b,target=test.frontendChange?b:f;
    for(const [name,envelope] of [['base',base],['candidate',candidate],['target',target]] as const)fs.writeFileSync(path.join(directory,name+'.json'),JSON.stringify(envelope));
    const args=['check-contract','--base',path.join(directory,'base.json'),'--candidate',path.join(directory,'candidate.json'),'--target',path.join(directory,'target.json'),'--trusted-local'];
    const native=JSON.parse(execFileSync(binary,args,{encoding:'utf8',env:{...process.env,PATH:''}}));
    assert.equal(native.delta.newFindings.length+native.delta.existingFindings.length,native.findings.length,test.name+' candidate delta partitions findings');
    assert(native.delta.resolvedFindings.every((finding:any)=>!native.findings.some((candidate:any)=>candidate.id===finding.id)),test.name+' resolved findings absent from candidate');
    const reference=new ArtifactComparisonEngine({requireServiceMapping:true}).compare(base,candidate,[target]);
    const baseline=new ArtifactComparisonEngine({requireServiceMapping:true}).compare(base,base,[target]);
    const baselineIds=new Set(baseline.findings.map(f=>f.id)),candidateIds=new Set(reference.findings.map(f=>f.id));
    Object.assign(reference,{delta:{newFindings:reference.findings.filter(f=>!baselineIds.has(f.id)),existingFindings:reference.findings.filter(f=>baselineIds.has(f.id)),resolvedFindings:baseline.findings.filter(f=>!candidateIds.has(f.id))}});
    assert.equal(normalize(native),normalize(reference),test.name+' complete report parity');
    results.push({name:test.name,verdict:native.verdict,findings:native.findings.length});
  }
  fs.writeFileSync(path.join(root,'rust/audit/report-parity-results.json'),JSON.stringify({cases:results.length,allReportFieldsMatch:true,binarySha256:createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),results},null,2));
  console.log(`Complete report semantics match across ${results.length} backend/frontend cases.`);
} finally {fs.rmSync(directory,{recursive:true,force:true});}
