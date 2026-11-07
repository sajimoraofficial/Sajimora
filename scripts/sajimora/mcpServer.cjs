'use strict';
const {McpServer}=require('@modelcontextprotocol/sdk/server/mcp.js');
const {StdioServerTransport}=require('@modelcontextprotocol/sdk/server/stdio.js');
const {z}=require('zod');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {formatScopedReport}=require('./mcpSummary.cjs');
const {expandRegistry}=require('./frontendRegistry.cjs');
const {assessVerification,contextSchema}=require('./verificationEvidence.cjs');
const {engineFingerprint,comparisonKey,ResultCache}=require('./mcpCache.cjs');
const {performance}=require('node:perf_hooks');
const workspace=path.resolve(__dirname,'../..');

async function main(){
  const roots=[];let trusted=false,policy,noCache=false;
  const args=process.argv.slice(2);
  for(let i=0;i<args.length;i++){
    if(args[i]==='--allowed-root'&&args[i+1])roots.push(await fs.realpath(path.resolve(args[++i])));
    else if(args[i]==='--trusted-local')trusted=true;
    else if(args[i]==='--no-cache')noCache=true;
    else if(args[i]==='--trust-policy'&&args[i+1])policy=await fs.realpath(path.resolve(args[++i]));
    else throw new Error('Usage: mcpServer.cjs --allowed-root DIR [--allowed-root DIR] (--trusted-local | --trust-policy FILE)');
  }
  if(!roots.length||trusted===!!policy)throw new Error('Require allowed roots and exactly one startup trust mode. Tool arguments cannot change trust.');
  async function capture(file){
    const resolved=await fs.realpath(path.resolve(file));
    if(!roots.some(root=>{const relative=path.relative(root,resolved);return relative!== '..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}))throw new Error('Artifact path is outside allowed roots');
    const stat=await fs.stat(resolved);
    if(!stat.isFile()||stat.size>20*1024*1024)throw new Error('Artifact must be a file within the 20 MiB bound');
    const bytes=await fs.readFile(resolved);
    if(bytes.length>20*1024*1024)throw new Error('Artifact exceeds 20 MiB bound');
    return bytes;
  }
  const server=new McpServer({name:'sajimora-scoped-mcp',version:'1.0.0'});
  const tempRoot=await fs.realpath(os.tmpdir());
  const jobs=new Set();
  const cache=new ResultCache();
  server.registerTool('sajimora_check_verification',{
    description:'Check whether supplied local test execution evidence covers planned consumer-operation cases for the current review identities. Passing suites alone cannot discharge gaps. Reports finite assertion passes, observed failures, missing assertions and stale evidence separately. Does not run code or prove universal compatibility.',
    inputSchema:{plan:z.string().min(1),runs:z.array(z.string().min(1)).max(64),current:contextSchema,offset:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(20).optional()},
    outputSchema:{version:z.literal('SAJIMORA_VERIFICATION_GAPS_V1'),planId:z.string(),planCurrent:z.boolean(),universalCompatibility:z.literal(false),scope:z.string(),trust:z.string(),coverage:z.record(z.number()),cases:z.array(z.record(z.unknown())),staleRunIds:z.array(z.string()),selection:z.object({matched:z.number(),offset:z.number(),returned:z.number(),nextOffset:z.number().nullable()})},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },async(input,extra)=>{
    if(!trusted)return {isError:true,content:[{type:'text',text:'Verification evidence currently requires --trusted-local. Producer trust-policy admission for test evidence is not implemented.'}]};
    if(jobs.size>=2)return {isError:true,content:[{type:'text',text:'Two checks are already running; retry after completion.'}]};
    const controller=new AbortController();jobs.add(controller);const started=performance.now();
    try{let aggregate=0;const objects=[];for(const file of [input.plan,...input.runs]){if(extra.signal.aborted)throw Error('Verification check cancelled');const bytes=await capture(file);aggregate+=bytes.length;if(aggregate>100*1024*1024)throw Error('Aggregate artifact bound is 100 MiB');objects.push(JSON.parse(bytes));}
      const report=assessVerification(objects[0],objects.slice(1),input.current),offset=input.offset||0,limit=input.limit||10;
      // Put actionable gaps/failures before finite passes without hiding global counts.
      report.cases.sort((a,b)=>(a.status==='OBSERVED_ASSERTION_PASS')-(b.status==='OBSERVED_ASSERTION_PASS'));
      const matched=report.cases.length;report.cases=report.cases.slice(offset,offset+limit);report.selection={matched,offset,returned:report.cases.length,nextOffset:offset+report.cases.length<matched?offset+report.cases.length:null};
      return {content:[{type:'text',text:`${report.coverage.observedFailures} observed case failures; ${report.coverage.unverified} unverified cases; ${report.coverage.staleRuns} stale runs. See structuredContent for source locations and specific checks. Finite passing cases do not prove compatibility.`}],structuredContent:report,_meta:{sajimora:{handlerMs:performance.now()-started}}};
    }catch(error){return {isError:true,content:[{type:'text',text:'Verification check failed: '+error.message}]};}finally{jobs.delete(controller);}
  });
  server.registerTool('sajimora_check_contract',{
    description:'Compare sealed base/candidate API contracts against frontend consumer artifacts using Sajimora’s real scoped engine. Returns confirmed breaks with affected consumers, scoped compatibility checks and separate unresolved evidence. No runtime safety or benchmark score is implied.',
    inputSchema:{base:z.string().min(1),candidate:z.string().min(1),targets:z.array(z.string().min(1)).min(1).max(64),consumerEndpoint:z.string().min(1).optional().describe('Select matching consumer registry partitions; omitted consumers remain outside checked coverage.'),assessUnchanged:z.boolean().optional(),detail:z.enum(['summary','evidence','full']).optional(),endpoint:z.string().min(1).optional().describe('For detail=evidence, exact normalized route or endpoint ID; global coverage stays unchanged.'),offset:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(20).optional()},
    outputSchema:{extraction:z.record(z.unknown()),targetSelection:z.array(z.record(z.unknown())).optional(),conditionalFindings:z.array(z.record(z.unknown())),detail:z.enum(['summary','evidence','full']),selection:z.object({endpoint:z.string().optional(),matched:z.number(),offset:z.number(),returned:z.number(),nextOffset:z.number().nullable()}).optional(),omitted:z.object({assessments:z.number(),evidenceRequests:z.number()}).optional(),notice:z.string().optional(),schemaVersion:z.literal('SAJIMORA_CROSS_LANGUAGE_IMPACT_V1'),assurance:z.unknown().optional(),proofKey:z.string().optional(),evidenceRecords:z.array(z.record(z.unknown())).optional(),artifacts:z.unknown().optional(),coverage:z.object({breaks:z.number().int().nonnegative(),completed:z.number().int().nonnegative(),pending:z.number().int().nonnegative(),changedObligations:z.number().int().nonnegative()}),assessments:z.array(z.object({status:z.string(),endpointId:z.string(),checkedScope:z.array(z.string()),consumers:z.array(z.record(z.unknown())),missingEvidence:z.array(z.string())}).passthrough()),evidenceRequests:z.array(z.record(z.unknown()))},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },async(input,extra)=>{
    if(jobs.size>=2)return {isError:true,content:[{type:'text',text:'Two checks are already running; retry after completion.'}]};
    const controller=new AbortController();jobs.add(controller);
    const abort=()=>controller.abort();extra.signal.addEventListener('abort',abort,{once:true});
    if(extra.signal.aborted)abort();
    let temporary;
    try{
      const started=performance.now(),timings={};
      const bytesList=[],targetSelection=[];let aggregate=0;
      for(const file of [input.base,input.candidate,...input.targets]){
        if(controller.signal.aborted)throw new Error('Check cancelled');
        const bytes=await capture(file);
        const isTarget=bytesList.length>=2;
        const registry=isTarget?await expandRegistry(bytes,await fs.realpath(path.resolve(file)),capture,input.consumerEndpoint,100*1024*1024-aggregate-bytes.length):undefined;
        if(registry&&!trusted)throw Error('Derived registry partitions require --trusted-local; signature-policy registry admission is not implemented');
        const captured=registry?registry.artifacts:[bytes];
        for(const item of captured){aggregate+=item.length;if(aggregate>100*1024*1024)throw new Error('Aggregate artifact bound is 100 MiB');bytesList.push(item);}
        if(registry){aggregate+=bytes.length;targetSelection.push(registry.selection);}
      }
      let policyBytes;
      if(policy){if((await fs.stat(policy)).size>20*1024*1024)throw new Error('Trust policy exceeds 20 MiB');policyBytes=await fs.readFile(policy);if(policyBytes.length>20*1024*1024)throw new Error('Trust policy exceeds 20 MiB');}
      timings.captureMs=performance.now()-started;
      const fingerprintStarted=performance.now();
      const engine=noCache?undefined:await engineFingerprint(workspace);
      const key=noCache?undefined:comparisonKey(bytesList,engine,policyBytes,input.assessUnchanged);
      timings.fingerprintMs=performance.now()-fingerprintStarted;
      if(controller.signal.aborted)throw new Error('Check cancelled');
      let report=noCache?undefined:cache.get(key);
      const cacheStatus=report?'hit':noCache?'disabled':'miss';
      timings.checkerMs=0;
      if(!report){
      temporary=await fs.mkdtemp(path.join(tempRoot,'sajimora-mcp-'));
      const captured=[];
      for(const bytes of bytesList){const name=path.join(temporary,captured.length+'.json');await fs.writeFile(name,bytes,{flag:'wx'});captured.push(name);}
      const capturedPolicy=policyBytes===undefined?undefined:path.join(temporary,'trust-policy.json');
      if(capturedPolicy)await fs.writeFile(capturedPolicy,policyBytes,{flag:'wx'});
      const command=[path.join(workspace,'scripts/test-runtime/run-tsx-command.cjs'),path.join(workspace,'scripts/sajimora/checkContract.ts'),'--base',captured[0],'--candidate',captured[1]];
      for(const target of captured.slice(2))command.push('--target',target);
      if(input.assessUnchanged)command.push('--assess-unchanged');
      if(trusted)command.push('--trusted-local');else command.push('--trust-policy',capturedPolicy);
      const checkerStarted=performance.now();
      const stdout=await new Promise((resolve,reject)=>execFile(process.execPath,command,{cwd:workspace,encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024,signal:controller.signal,windowsHide:true},(error,stdout,stderr)=>{
        if(error)reject(new Error((stderr||error.message).slice(-4000)));else resolve(stdout);
      }));
      timings.checkerMs=performance.now()-checkerStarted;
      report=JSON.parse(stdout);
      if(report.schemaVersion!=='SAJIMORA_CROSS_LANGUAGE_IMPACT_V1'||!report.scopedChanges)throw new Error('Scoped engine returned an unexpected report');
      // Never store a report across source edits during the check, or error reports.
      if(!noCache&&report.verdict!=='ANALYSIS_ERROR'&&await engineFingerprint(workspace)===engine)cache.set(key,report);
      }
      // Tool errors are extraction failures, not ordinary confirmed API breaks.
      const structuredContent=formatScopedReport(report,input.detail,input);if(targetSelection.length)structuredContent.targetSelection=targetSelection;
      const {breaks,completed,pending}=structuredContent.coverage;
      timings.handlerMs=performance.now()-started;
      return {content:[{type:'text',text:`${breaks} confirmed source-contract breaks; ${completed} completed scoped checks; ${pending} unresolved obligations; ${structuredContent.conditionalFindings.length} conditional operation findings. See structuredContent for affected consumers and evidence. Unresolved coverage is not compatibility.`}],structuredContent,_meta:{sajimora:{cache:cacheStatus,timings}}};
    }catch(error){return {isError:true,content:[{type:'text',text:'Sajimora check failed: '+error.message}]};}
    finally{
      extra.signal.removeEventListener('abort',abort);
      jobs.delete(controller);
      if(temporary){
        try{
          if(path.dirname(path.resolve(temporary))===tempRoot&&path.basename(temporary).startsWith('sajimora-mcp-')){
            await fs.rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});
          }
        }catch(cleanupErr){
          process.stderr.write(`sajimora-mcp: temporary cleanup failed: ${cleanupErr.message}\n`);
        }
      }
    }
  });
  process.stdin.once('end',()=>{for(const job of jobs)job.abort();});
  process.once('SIGTERM',()=>{for(const job of jobs)job.abort();server.close().catch(()=>{});});
  await server.connect(new StdioServerTransport());
}
main().catch(error=>{process.stderr.write('sajimora-mcp: '+error.message+'\n');process.exitCode=1;});




