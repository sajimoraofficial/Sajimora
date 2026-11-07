'use strict';
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
/** Keep one connection for a review session. Tool callers forward structuredContent
 * once; the fallback text is for clients that cannot consume structured output. */
async function createScopedClient({allowedRoots,trustedLocal=false,trustPolicy,cache=true,memoryProfile}){
  if(!Array.isArray(allowedRoots)||!allowedRoots.length||trustedLocal===!!trustPolicy)throw Error('Require roots and exactly one trust mode');
  const root=path.resolve(__dirname,'../..'),args=[path.join(__dirname,'mcpServer.cjs')];
  for(const dir of allowedRoots)args.push('--allowed-root',dir);
  if(trustedLocal)args.push('--trusted-local');else args.push('--trust-policy',trustPolicy);
  if(!cache)args.push('--no-cache');
  const env=memoryProfile?{...process.env,SAJIMORA_MEMORY_PROFILE:memoryProfile,NODE_OPTIONS:'--require='+path.join(__dirname,'memorySampler.cjs').replaceAll('\\','/')}:undefined;
  const client=new Client({name:'sajimora-review-session',version:'1.0.0'}),transport=new StdioClientTransport({command:process.execPath,args,cwd:root,...(env?{env}:{}),stderr:'pipe'});
  transport.stderr?.on('data',()=>{});const started=performance.now();
  try{await client.connect(transport);}catch(error){await transport.close().catch(()=>{});throw error;}
  async function call(name,input){const started=performance.now(),result=await client.callTool({name,arguments:input},undefined,{timeout:120000});if(result.isError)throw Error(result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));return {report:result.structuredContent,meta:result._meta?.sajimora,callMs:performance.now()-started};}
  return {startupMs:performance.now()-started,check:input=>call('sajimora_check_contract',input),checkVerification:input=>call('sajimora_check_verification',input),close:()=>client.close()};
}
module.exports={createScopedClient};
