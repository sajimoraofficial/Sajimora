'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const root=path.resolve(__dirname,'../..');
const audit=path.join(root,'rust/audit/thingsboard-widget-obligations-2026-10-06');
async function main(){
  const temporary=fs.mkdtempSync(path.join(root,'scratch/mcp-test-'));
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(__dirname,'mcpServer.cjs'),'--allowed-root',audit,'--allowed-root',temporary,'--trusted-local'],cwd:root,stderr:'pipe'});
  const client=new Client({name:'sajimora-integration-test',version:'1.0.0'});
  let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk;});
  try{
    await client.connect(transport);
    const tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name).sort(),['sajimora_check_contract','sajimora_check_verification']);
    const input={base:path.join(audit,'base.json'),candidate:path.join(audit,'candidate.json'),targets:[path.join(audit,'frontend.json')],assessUnchanged:true};
    const call=arguments_=>client.callTool({name:'sajimora_check_contract',arguments:arguments_},undefined,{timeout:120000});
    const broken=await call(input);assert.notEqual(broken.isError,true);
    assert.equal(broken._meta.sajimora.cache,'miss');
    const findings=broken.structuredContent.assessments.filter(assessment=>assessment.status==='BREAK_PROVED');
    assert.equal(findings.length,1);assert.ok(findings[0].consumers.some(consumer=>consumer.line===272&&consumer.usage==='widgetsBundleFqn.push(fqn)'));
    const cli=JSON.parse(fs.readFileSync(path.join(audit,'break.json'),'utf8')).scopedChanges;
    assert.deepEqual(broken.structuredContent.coverage,cli.coverage);assert.equal(broken.structuredContent.assessments.length,1);assert.ok(broken.structuredContent.omitted.assessments>0);
    const full=await call({...input,detail:'full'});assert.notEqual(full.isError,true);assert.deepEqual(full.structuredContent.assessments,cli.assessments);assert.deepEqual(full.structuredContent.evidenceRequests,cli.evidenceRequests);
    assert.equal(full._meta.sajimora.cache,'hit');
    const evidence=await call({...input,detail:'evidence',endpoint:'/api/widgetTypeFqns',limit:1});
    assert.notEqual(evidence.isError,true);assert.equal(evidence._meta.sajimora.cache,'hit');assert.deepEqual(evidence.structuredContent.coverage,full.structuredContent.coverage);
    assert.equal(evidence.structuredContent.selection.returned,1);assert.ok(evidence.structuredContent.assessments[0].endpointId.includes('/api/widgetTypeFqns'));
    const selected=cli.assessments.filter(a=>JSON.parse(a.endpointId)[2]==='/api/widgetTypeFqns');assert.equal(evidence.structuredContent.selection.matched,selected.length);
    const next=await call({...input,detail:'evidence',endpoint:'/api/widgetTypeFqns',offset:1,limit:1});assert.equal(next._meta.sajimora.cache,'hit');assert.equal(next.structuredContent.assessments[0].obligationId,selected[1].obligationId);
    const missing=await call({...input,detail:'evidence',endpoint:'/not-in-this-snapshot'});assert.equal(missing.structuredContent.assessments.length,0);assert.deepEqual(missing.structuredContent.coverage,cli.coverage);assert.equal(missing.structuredContent.selection.nextOffset,null);
    assert.equal((await call({...input,detail:'evidence',limit:21})).isError,true);
    assert.ok(JSON.stringify(broken.structuredContent).length<JSON.stringify(full.structuredContent).length/10);
    const control=await call({...input,candidate:input.base});assert.notEqual(control.isError,true);assert.equal(control.structuredContent.coverage.breaks,0);assert.equal(control.structuredContent.assessments.length,0);assert.ok(control.structuredContent.coverage.pending>0);
    assert.equal(control._meta.sajimora.cache,'miss');
    const movingCandidate=path.join(temporary,'moving-candidate.json');await fs.promises.copyFile(input.candidate,movingCandidate);
    const sameBytes=await call({...input,candidate:movingCandidate});assert.equal(sameBytes._meta.sajimora.cache,'hit');assert.equal(sameBytes.structuredContent.coverage.breaks,1);
    await fs.promises.copyFile(input.base,movingCandidate);
    const changedBytes=await call({...input,candidate:movingCandidate});assert.equal(changedBytes.structuredContent.coverage.breaks,0);assert.deepEqual(changedBytes.structuredContent.coverage,control.structuredContent.coverage);
    const outside=await call({...input,base:path.join(root,'package.json')});assert.equal(outside.isError,true);assert.match(outside.content[0].text,/outside allowed roots/);
    const alias=path.join(temporary,'outside-alias');fs.symlinkSync(root,alias,process.platform==='win32'?'junction':'dir');
    assert.equal((await call({...input,base:path.join(alias,'package.json')})).isError,true);
    const tampered=JSON.parse(fs.readFileSync(input.base,'utf8'));tampered.integrity.sha256='0'.repeat(64);const tamperedFile=path.join(temporary,'tampered.json');fs.writeFileSync(tamperedFile,JSON.stringify(tampered));
    assert.equal((await call({...input,base:tamperedFile})).isError,true);
    assert.equal((await call({...input,targets:[]})).isError,true);
    const result={passed:true,protocol:'Official SDK client/server over stdio',checks:['initialize','tools/list with output schema','real ThingsBoard seeded break','summary proved breaks only with omitted counts','full detail exact CLI assessment parity','summary output reduction','unchanged summary preserves unresolved coverage','cache hit retains exact full assessments','same-path content changes cannot reuse old break','allowed-root rejection','junction escape rejection','tampered artifact rejection','invalid arguments rejection'],breaks:findings.length,controlBreaks:0,coverage:broken.structuredContent.coverage,outputBytes:{summary:Buffer.byteLength(JSON.stringify(broken.structuredContent)),full:Buffer.byteLength(JSON.stringify(full.structuredContent))},benchmarkScoreMeasured:false};
    const output=path.join(root,'rust/audit/mcp-integration-2026-10-06');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }catch(error){process.stderr.write(stderr.slice(-3000)+'\n');throw error;}
  finally{await client.close();assert.equal(path.dirname(path.resolve(temporary)),path.join(root,'scratch'));assert.ok(path.basename(temporary).startsWith('mcp-test-'));fs.rmSync(temporary,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
