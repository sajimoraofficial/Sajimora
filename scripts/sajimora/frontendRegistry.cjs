'use strict';
const path=require('node:path'),{createHash}=require('node:crypto');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function mayMatch(route,endpoint){
 if(route==='<dynamic>')return false;
 if(route.includes('**'))return true;
 const a=route.split('?')[0].split('/').filter(Boolean),b=endpoint.split('?')[0].split('/').filter(Boolean);
 if(a.length!==b.length)return false;
 return a.every((segment,i)=>segment===b[i]||/[{}$*]/.test(segment)||/[{}$*]/.test(b[i]));
}
async function expandRegistry(bytes,filename,capture,endpoint,budget=100*1024*1024){
 const manifest=JSON.parse(bytes.toString());if(manifest.version!=='SAJIMORA_FRONTEND_REGISTRY_V1')return;
 const {integrity,...facts}=manifest;if(integrity!==sha(JSON.stringify(facts)))throw Error('Registry manifest integrity mismatch');
 if(!Array.isArray(manifest.shards)||manifest.shards.length>2048||manifest.shards.reduce((n,s)=>n+s.clientCount,0)!==manifest.totalClients)throw Error('Invalid registry inventory');
 const selected=manifest.shards.filter(s=>!endpoint||s.clients.some(c=>c.routes.some(r=>mayMatch(r,endpoint))));
 if(selected.length>64)throw Error('Registry selection exceeds 64 partitions; provide consumerEndpoint');
 if(!selected.length)throw Error('No matching registry partition; provide an appropriate endpoint or omit consumerEndpoint');
 const artifacts=[];let aggregate=0;for(const shard of selected){if(typeof shard.file!=='string'||path.basename(shard.file)!==shard.file||!/^frontend-\d+\.json$/.test(shard.file))throw Error('Unsafe registry shard path');if(shard.bytes>budget-aggregate)throw Error('Registry selection exceeds aggregate artifact budget');const bytes=await capture(path.join(path.dirname(filename),shard.file));if(bytes.length!==shard.bytes||sha(bytes)!==shard.sha256)throw Error('Registry shard integrity mismatch');aggregate+=bytes.length;if(aggregate>budget)throw Error('Registry selection exceeds aggregate artifact budget');artifacts.push(bytes);}
 return {artifacts,selection:{sourceArtifactSha256:manifest.sourceArtifactSha256,totalClients:manifest.totalClients,selectedClients:selected.reduce((n,s)=>n+s.clientCount,0),unboundRouteClients:manifest.shards.flatMap(s=>s.clients).filter(c=>c.routes.every(r=>r==='<dynamic>')).length,totalShards:manifest.shards.length,selectedShards:selected.length,sourceBlockers:manifest.sourceBlockers,consumerEndpoint:endpoint??null,scope:'Coverage pertains to selected consumer partitions; omitted consumers and unbound routes are not assessed. No complete consumer inventory is established'}};
}
module.exports={expandRegistry,mayMatch};
