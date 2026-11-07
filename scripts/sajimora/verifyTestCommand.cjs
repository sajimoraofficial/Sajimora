'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const v=require('./verificationEvidence.cjs');
/** Run an existing Node command with opt-in capture; plans/runs are generated. */
async function verifyTestCommand({root,change,command,output,timeoutMs=60000}){
 root=fs.realpathSync(root);output=path.resolve(output);fs.mkdirSync(output,{recursive:true});
 const session=fs.mkdtempSync(path.join(output,'capture-'));
 const assessments=(change.assessment.scopedChanges||change.assessment).assessments.filter(a=>a.changeId===change.changeId);
 const consumers=assessments.flatMap(a=>(a.consumers||[]).filter(s=>s.operation==='METHOD_CALL').map(s=>({...s,endpointId:a.endpointId})));
 const sites=consumers.map((s,i)=>{const absolute=fs.realpathSync(path.resolve(root,s.file));if(!absolute.startsWith(root+path.sep))throw Error('Consumer outside repository');if(v.hashBytes(fs.readFileSync(absolute))!==s.sourceSha256)throw Error('Stale consumer source');return {...s,id:'consumer:'+i,absolute};});
 if(!sites.length||sites.length>100||new Set(sites.map(s=>s.absolute)).size!==sites.length)throw Error('Require 1–100 consumers, one operation per file');
 if(!change.candidateExamples?.length||change.candidateExamples.length>100)throw Error('Explicit finite candidate response examples required; schemas alone are not runtime inputs');
 if(!Array.isArray(command)||!command.length)throw Error('Executable and arguments required');
 const tests=[];
 function discover(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.isSymbolicLink()||['node_modules','.git','dist','build'].includes(e.name))continue;const f=path.join(dir,e.name);if(e.isDirectory())discover(f);else if(/\.(test|spec)\.(cjs|js)$/.test(e.name))tests.push(f);if(tests.length>1000)throw Error('Test discovery bound exceeded');}}discover(root);
 const preload=path.join(__dirname,'verificationPreload.cjs'),configPath=path.join(session,'config.json');fs.writeFileSync(configPath,JSON.stringify({sites,output:session}));
 const started=performance.now();let timedOut=false;
 const execution=await new Promise((resolve,reject)=>{const child=spawn(command[0],command.slice(1),{cwd:root,shell:false,env:{...process.env,SAJIMORA_TEST_CAPTURE:configPath,NODE_OPTIONS:[process.env.NODE_OPTIONS||'',`--require=${JSON.stringify(preload)}`].join(' ')},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>{stdout=(stdout+d).slice(-65536);});child.stderr.on('data',d=>{stderr=(stderr+d).slice(-65536);});const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,timedOut,stdout,stderr});});});
 const elapsedMs=performance.now()-started,captures=fs.readdirSync(session).filter(f=>/^capture-\d+\.json$/.test(f)).map(f=>JSON.parse(fs.readFileSync(path.join(session,f)))),raw=captures.flatMap(c=>c.rows);
 const context={proofKey:v.hash(change),producerRevision:change.producerRevision,consumerRevision:v.hash(sites.map(s=>s.sourceSha256)),environmentId:'NODE_CJS_METHOD_CAPTURE_V1',testHarnessSha256:v.hash({preload:v.hashBytes(fs.readFileSync(preload)),runner:v.hashBytes(fs.readFileSync(__filename)),tests:tests.sort().map(f=>[path.relative(root,f),v.hashBytes(fs.readFileSync(f))]),command})};
 const obligations=sites.map(s=>({id:s.id,changeId:change.changeId,endpointId:s.endpointId,site:{file:s.file,line:s.line,usage:s.usage,sourceSha256:s.sourceSha256},cases:[...new Set([...change.candidateExamples.map(v.hash),...raw.filter(r=>r.id===s.id).map(r=>r.inputHash)])].map(inputHash=>({id:'input:'+inputHash,inputHash}))}));
 const plan=v.createPlan({...context,obligations}),observations=raw.map(r=>{const o=obligations.find(o=>o.id===r.id);const {id,...rest}=r;return {...rest,obligationId:id,caseId:'input:'+r.inputHash,site:o.site};});
 const facts={version:'SAJIMORA_VERIFICATION_RUN_V1',planId:plan.planId,...Object.fromEntries(['producerRevision','consumerRevision','environmentId','testHarnessSha256'].map(k=>[k,context[k]])),runId:path.basename(session),completedAt:new Date().toISOString(),observations};const run={...facts,integrity:v.hash(facts)};
 const report=v.assessVerification(plan,[run],context);
 const result={report,command:execution,elapsedMs,discoveredTests:tests.map(f=>path.relative(root,f)),captureProcesses:captures.length,peakProcessRss:Math.max(0,...captures.map(c=>c.rss)),peakSampledHeap:Math.max(0,...captures.map(c=>c.heap)),diagnostics:captures.flatMap(c=>c.diagnostics),limitations:['Explicit finite candidate examples and captured consumer identities required; no whole-repository extraction','Only synchronous plain method calls in CommonJS; direct object equality assertions only','Test discovery is inventory; supplied command controls which tests execute','Local trusted instrumentation, not authenticated attestation; no automatic repair or Angular/Jest/JUnit support','Per-process memory, not concurrent aggregate RSS; timeout kills direct child only']};
 for(const [name,data] of Object.entries({plan,run,current:context,result}))fs.writeFileSync(path.join(session,name+'.json'),JSON.stringify(data,null,2));return {...result,artifacts:session};
}
module.exports={verifyTestCommand};
if(require.main===module){const args=process.argv.slice(2),separator=args.indexOf('--');if(separator!==3){console.error('Usage: node verifyTestCommand.cjs ROOT CHANGE.json OUTPUT -- EXECUTABLE [ARGS]');process.exitCode=1;}else verifyTestCommand({root:args[0],change:JSON.parse(fs.readFileSync(args[1])),output:args[2],command:args.slice(separator+1)}).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});}
