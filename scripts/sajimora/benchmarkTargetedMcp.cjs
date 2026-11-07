'use strict';
const fs=require('node:fs'),p=require('node:path'),assert=require('node:assert/strict');
const {createScopedClient}=require('./mcpClient.cjs'),{formatScopedReport}=require('./mcpSummary.cjs');
const root=p.resolve(__dirname,'../..'),out=p.join(root,'rust/audit/mcp-targeted-evidence-2026-10-06');
const {getEncoding}=require(p.join(root,'scratch/mcp-latency-2026-10-06/node_modules/js-tiktoken'));
async function main(){
 fs.mkdirSync(out,{recursive:true});const memory=p.join(out,'memory.jsonl');if(fs.existsSync(memory))throw Error('Preserve existing measurement; use a new output version for repeats');
 const fixtures=[{id:'thingsboard',dir:p.join(root,'rust/audit/thingsboard-widget-obligations-2026-10-06'),endpoint:'/api/widgetTypeFqns'},{id:'deep',dir:p.join(root,'rust/audit/deep-propagation-2026-10-06'),endpoint:'/api/invoice'}];
 const client=await createScopedClient({allowedRoots:fixtures.map(x=>x.dir),trustedLocal:true,memoryProfile:memory}),samples=[],results={};
 const enc=getEncoding('o200k_base'),payload=report=>{const s=JSON.stringify(report);return {bytes:Buffer.byteLength(s),proxyTokens:enc.encode(s).length};};
 try{for(const f of fixtures){const input={base:p.join(f.dir,'base.json'),candidate:p.join(f.dir,'candidate.json'),targets:[p.join(f.dir,'frontend.json')],assessUnchanged:true};
  const cold=await client.check(input);samples.push({id:f.id,phase:'first-miss',callMs:cold.callMs,meta:cold.meta});assert.equal(cold.meta.cache,'miss');
  const evidence=await client.check({...input,detail:'evidence',endpoint:f.endpoint});samples.push({id:f.id,phase:'targeted-hit',callMs:evidence.callMs,meta:evidence.meta});assert.equal(evidence.meta.cache,'hit');assert.deepEqual(evidence.report.coverage,cold.report.coverage);
  for(let i=0;i<3;i++){const hit=await client.check(input);assert.equal(hit.meta.cache,'hit');assert.deepEqual(hit.report,cold.report);samples.push({id:f.id,phase:'summary-hit',callMs:hit.callMs,meta:hit.meta});}
  const original=JSON.parse(fs.readFileSync(p.join(f.dir,f.id==='deep'?'check.json':'break.json'))),full=formatScopedReport(original,'full');
  if(f.id==='deep'){assert.equal(evidence.report.assessments[0].status,'EVIDENCE_REQUIRED');assert.ok(evidence.report.assessments[0].consumers.some(x=>x.usage==='value.toFixed(2)'));}
  results[f.id]={coverage:cold.report.coverage,summary:payload(cold.report),targeted:payload(evidence.report),oldFull:payload(full),normalReviewPayload:payload(f.id==='deep'?evidence.report:cold.report)};
 }}finally{await client.close();}
 const rows=fs.readFileSync(memory,'utf8').split('\n').filter(Boolean).map(JSON.parse);const max=(role,key)=>Math.max(0,...rows.filter(x=>x.role===role).map(x=>x[key]||0));
 const result={at:new Date().toISOString(),startupMs:client.startupMs,persistentConnection:true,cacheCorrectness:true,samples,results,memory:{serverLifetimePeakRssBytes:max('mcp-server','lifetimeMaxRssBytes'),checkerLifetimePeakRssBytes:max('checker','lifetimeMaxRssBytes'),serverSampledThreadHeapPeakBytes:max('mcp-server','heapUsed'),checkerSampledThreadHeapPeakBytes:max('checker','heapUsed')},limitations:['One first miss per fixture, three identical hits','OS caches not cleared; prepared artifacts','50ms memory instrumentation overhead; per-thread heap samples','Tokenizer o200k_base is a proxy, not billed agent usage','Node scoped MCP, not native Rust']};fs.writeFileSync(p.join(out,'measurement.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
