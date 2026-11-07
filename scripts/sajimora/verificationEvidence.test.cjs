'use strict';
const assert=require('node:assert/strict'),v=require('./verificationEvidence.cjs');
const source=Buffer.from('function consume(value) { return value.push(1); }');
const context={proofKey:v.hash('proof'),producerRevision:'candidate',consumerRevision:'consumer',environmentId:'local-test',testHarnessSha256:v.hash('harness')};
const facts={...context,obligations:[{id:'o',changeId:'c',endpointId:'GET /api/items',site:{file:'consumer.js',line:1,sourceSha256:v.hashBytes(source),usage:'value.push(1)'},cases:[{id:'array',inputHash:v.hash([])},{id:'object',inputHash:v.hash({})}]}]};
const plan=v.createPlan(facts),assess=runs=>v.assessVerification(plan,runs,context),record=(r,caseId,input,invoke,assertions=[])=>r.record({obligationId:'o',caseId,testId:'test',input,invoke,assertions,sourceBytes:source});
(async()=>{
 assert.equal(assess([]).coverage.unverified,2);
 const empty=v.createRecorder(plan,'green-unrelated-suite').finish();assert.equal(assess([empty]).coverage.observedAssertionPasses,0);
 const baseline=v.createRecorder(plan,'baseline-only');await record(baseline,'array',[],x=>x.push(1),[{target:'INPUT_AFTER',expected:[1]}]);
 const run=baseline.finish(),a=assess([run]);assert.equal(a.cases[0].status,'OBSERVED_ASSERTION_PASS');assert.equal(a.cases[1].status,'NO_MATCHING_EXECUTION');assert.equal(a.universalCompatibility,false);
 const candidate=v.createRecorder(plan,'candidate');await record(candidate,'object',{},x=>x.push(1),[{target:'RETURN',expected:1}]);assert.equal(assess([candidate.finish()]).cases[1].status,'OBSERVED_FAILURE');
 const noAssert=v.createRecorder(plan,'no-assert');await record(noAssert,'array',[],x=>x.push(1));assert.equal(assess([noAssert.finish()]).cases[0].status,'EXERCISED_WITHOUT_ASSERTION');
 const wrong=v.createRecorder(plan,'bad-oracle');await record(wrong,'array',[],x=>x.push(1),[{target:'RETURN',expected:99}]);assert.equal(assess([wrong.finish()]).cases[0].status,'OBSERVED_FAILURE');assert.equal(assess([run,wrong.finish()]).cases[0].status,'CONFLICTING_OBSERVATIONS');
 for(const key of Object.keys(context)){const stale=v.assessVerification(plan,[run],{...context,[key]:key.endsWith('Sha256')||key==='proofKey'?v.hash('new'):context[key]+'-new'});assert.equal(stale.planCurrent,false);assert.equal(stale.coverage.observedAssertionPasses,0);assert.equal(stale.coverage.staleRuns,1);}
 const changed=v.createPlan({...facts,obligations:[{...facts.obligations[0],site:{...facts.obligations[0].site,sourceSha256:v.hash('edited')}}]});assert.equal(v.assessVerification(changed,[run],context).coverage.staleRuns,1);
 assert.throws(()=>assess([{...run,runId:'tampered'}]),/integrity/);assert.throws(()=>v.checkPlan({...plan,consumerRevision:'edited'}),/integrity/);
 const mismatch={...run,observations:[{...run.observations[0],caseId:'missing'}]};delete mismatch.integrity;mismatch.integrity=v.hash(mismatch);assert.throws(()=>assess([mismatch]),/unknown or mismatched/);
 await assert.rejects(()=>record(v.createRecorder(plan,'invalid'),'array',[],x=>x,{length:1}),/array/i);
 await assert.rejects(()=>v.createRecorder(plan,'wrong-source').record({obligationId:'o',caseId:'array',testId:'test',input:[],sourceBytes:Buffer.from('edited'),invoke:x=>x}),/source differs/);
 await assert.rejects(()=>record(v.createRecorder(plan,'wrong-input'),'object',[],x=>x),/input differs/);
 const falsy=v.createRecorder(plan,'falsy-throw');await record(falsy,'object',{},()=>{throw null;});assert.equal(assess([falsy.finish()]).cases[1].status,'OBSERVED_FAILURE');
 const secret='PRIVATE_PAYLOAD_SENTINEL';const secretPlan=v.createPlan({...facts,obligations:[{...facts.obligations[0],cases:[{id:'secret',inputHash:v.hash({secret})}]}]});const recorder=v.createRecorder(secretPlan,'privacy');await recorder.record({obligationId:'o',caseId:'secret',testId:'test',sourceBytes:source,input:{secret},invoke:()=>{throw Error(secret);}});assert.ok(!JSON.stringify(recorder.finish()).includes(secret));
 assert.throws(()=>v.hash(NaN),/Finite/);const cyclic={};cyclic.x=cyclic;assert.throws(()=>v.hash(cyclic),/Cyclic/);
 console.log('Verification evidence: finite cases, negative controls, stale identities, conflicts, provenance and payload omission passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
