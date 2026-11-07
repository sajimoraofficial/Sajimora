'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
// Hash live source/dependency inputs as well as immutable artifact bytes. No mtime keys.
async function engineFingerprint(workspace){
  const files=[];
  async function walk(dir){for(const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>(a.name < b.name ? -1 : a.name > b.name ? 1 : 0))){if(entry.isDirectory()){if(!['node_modules','tests','test','dist','.git','.cache'].includes(entry.name))await walk(path.join(dir,entry.name));}else if(/\.(ts|tsx|js|cjs|json)$/.test(entry.name))files.push(path.join(dir,entry.name));}}
  await walk(path.join(workspace,'packages'));await walk(path.join(workspace,'scripts'));
  for(const name of ['package.json','package-lock.json','tsconfig.json'])files.push(path.join(workspace,name));
  const hash=createHash('sha256');
  for(let offset=0;offset<files.length;offset+=64){const batch=files.slice(offset,offset+64);const digests=await Promise.all(batch.map(async file=>createHash('sha256').update(await fs.readFile(file)).digest()));for(let i=0;i<batch.length;i++){hash.update(path.relative(workspace,batch[i]).replace(/\\/g, '/'));hash.update('\0');hash.update(digests[i]);}}
  return hash.digest('hex');
}
function comparisonKey(bytes,engine,policy,assessUnchanged){return createHash('sha256').update(JSON.stringify({version:2,engine,trust:policy===undefined?'trusted-local':createHash('sha256').update(policy).digest('hex'),assessUnchanged:!!assessUnchanged,artifacts:bytes.map(b=>createHash('sha256').update(b).digest('hex'))})).digest('hex');}
class ResultCache{
  constructor({maxEntries=16,maxBytes=32*1024*1024,ttlMs=300000,now=Date.now}={}){Object.assign(this,{maxEntries,maxBytes,ttlMs,now});this.entries=new Map();this.bytes=0;}
  get(key){const entry=this.entries.get(key);if(!entry)return;if(this.now()-entry.created>=this.ttlMs){this.delete(key);return;}this.entries.delete(key);this.entries.set(key,entry);return JSON.parse(entry.json);}
  delete(key){const e=this.entries.get(key);if(e)this.bytes-=e.bytes;this.entries.delete(key);}
  set(key,report){const json=JSON.stringify(report),bytes=Buffer.byteLength(json);if(bytes>this.maxBytes)return;this.delete(key);while(this.entries.size>=this.maxEntries||this.bytes+bytes>this.maxBytes)this.delete(this.entries.keys().next().value);this.entries.set(key,{json,bytes,created:this.now()});this.bytes+=bytes;}
}
module.exports={engineFingerprint,comparisonKey,ResultCache};
