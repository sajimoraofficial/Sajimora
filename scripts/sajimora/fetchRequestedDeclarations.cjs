'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
/** Populate an isolated content-addressed cache only for explicit, previously
 * recorded exact dependency requests. No install or package code execution. */
async function fetchRequestedDeclarations(artifact,cache,packages){
 const requests=artifact.payload?.dependencyContext?.requests??artifact.requests;
 if(!Array.isArray(requests)||!packages.length)throw Error('Captured requests and explicit package names required');
 const result=[];
 for(const name of packages){
  if(!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name))throw Error('Invalid package name');
  const matches=requests.filter(r=>r.package===name);if(!matches.length)throw Error('Package was not requested by extraction: '+name);
  const identities=[...new Set(matches.map(r=>JSON.stringify([r.version,r.integrity])))];if(identities.length!==1)throw Error('Multiple locked package versions require a scoped request file: '+name);
  const request=matches[0],integrity=request.integrity?.match(/^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/);
  if(!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(request.version)||!integrity)throw Error('Exact version and supported archive integrity required');
  const digest=Buffer.from(integrity[2],'base64').toString('hex'),file=path.resolve(cache,'_cacache/content-v2',integrity[1],digest.slice(0,2),digest.slice(2,4),digest.slice(4));
  const started=performance.now();let state='hit',bytes;
  if(fs.existsSync(file)){bytes=fs.readFileSync(file);if(bytes.length>32*1024*1024)throw Error('Cached archive exceeds budget');}
  else{state='download';const url=`https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${request.version}.tgz`,response=await fetch(url,{signal:AbortSignal.timeout(30000),redirect:'error'});if(!response.ok)throw Error(`Archive download failed: ${response.status}`);const chunks=[];let length=0;for await(const chunk of response.body){length+=chunk.length;if(length>32*1024*1024)throw Error('Archive download exceeds 32 MiB');chunks.push(chunk);}bytes=Buffer.concat(chunks);}
  if(createHash(integrity[1]).update(bytes).digest('base64')!==integrity[2])throw Error('Exact lock integrity mismatch: '+name);
  if(state==='download'){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});}
  result.push({package:name,version:request.version,integrity:request.integrity,state,bytes:bytes.length,elapsedMs:performance.now()-started});
 }
 return result;
}
module.exports={fetchRequestedDeclarations};
if(require.main===module){const [artifact,cache,...packages]=process.argv.slice(2);fetchRequestedDeclarations(JSON.parse(fs.readFileSync(artifact)),path.resolve(cache),packages).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});}
