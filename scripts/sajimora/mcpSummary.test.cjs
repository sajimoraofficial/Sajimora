'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {formatScopedReport}=require('./mcpSummary.cjs');
const root=path.resolve(__dirname,'../..');
for(const fixture of ['thingsboard-widget-obligations-2026-10-06','deep-propagation-2026-10-06']){
 const report=JSON.parse(fs.readFileSync(path.join(root,'rust/audit',fixture,fixture.startsWith('deep')?'check.json':'break.json')));
 const endpoint=fixture.startsWith('deep')?'/api/invoice':'/api/widgetTypeFqns',matches=report.scopedChanges.assessments.filter(a=>JSON.parse(a.endpointId)[2]===endpoint);
 const result=formatScopedReport(report,'evidence',{endpoint,limit:20});assert.deepEqual(result.coverage,report.scopedChanges.coverage);assert.equal(result.assessments.length,matches.length);
 for(let i=0;i<matches.length;i++){assert.equal(result.assessments[i].status,matches[i].status);assert.deepEqual(result.assessments[i].missingEvidence,matches[i].missingEvidence);assert.deepEqual(result.assessments[i].assumptions,matches[i].assumptions);assert.deepEqual(result.assessments[i].consumers.map(c=>({file:c.file,line:c.line,usage:c.usage,guards:c.guards})),matches[i].consumers.map(c=>({file:c.file,line:c.line,usage:c.usage,guards:c.guards})));}
 if(fixture.startsWith('deep')){assert.equal(result.assessments[0].status,'EVIDENCE_REQUIRED');assert.ok(result.assessments[0].consumers.some(c=>c.usage==='value.toFixed(2)'));assert.ok(result.assessments[0].missingEvidence.some(x=>x.includes('annotations do not validate')));}
 const empty=formatScopedReport(report,'evidence',{endpoint:'/absent'});assert.equal(empty.assessments.length,0);assert.deepEqual(empty.coverage,report.scopedChanges.coverage);
}
console.log('Targeted evidence preserves statuses, scope, assumptions, consumers and unresolved reasons for both fixtures.');
