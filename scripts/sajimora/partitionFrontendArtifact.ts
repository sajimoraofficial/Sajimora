import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {parseEnvelope,verifyEnvelopeIntegrity,sealEnvelope,FrontendContractPayload,FrontendClientContract} from '../../packages/analysis/src/sajimora/cross-language/ContractArtifactEnvelope';
const sha=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function partitionFrontendArtifact(input:string,output:string){
  if(fs.statSync(input).size>128*1024*1024)throw Error('Partition preparation input bound is 128 MiB');
  const bytes=fs.readFileSync(input),source=parseEnvelope(bytes.toString('utf8'));
  if(source.kind!=='FRONTEND_CONTRACT'||!verifyEnvelopeIntegrity(source))throw Error('Require an integrity-verified frontend artifact');
  if(fs.existsSync(output))throw Error('Output directory already exists; preserve previous registry captures');
  fs.mkdirSync(output,{recursive:true});const payload=source.payload as FrontendContractPayload;
  const {integrity,signature,...draft}=source;
  const make=(clients:FrontendClientContract[])=>{
    const files=new Set(clients.flatMap(c=>[c.sourceFile,...(c.responseUsage??[]).map(s=>s.file),...(c.httpOptionsEvidence?.sourceEvidence??[]).map(s=>s.file),...(c.responseProjections??[]).map(s=>s.sourceFile)]));
    // Preserve all shared configuration and dependency facts. Only diagnostics
    // explicitly owned by unrelated source files are outside this partition.
    const blockers=source.completeness.blockers.filter(b=>!b.file||files.has(b.file));
    const unresolvedEndpoints=source.completeness.unresolvedEndpoints.filter(entry=>{const owner=entry.split(':')[0];return !/\.[cm]?[jt]sx?$/.test(owner)||files.has(owner);});
    const dependencyContext=payload.dependencyContext?{...payload.dependencyContext,requests:payload.dependencyContext.requests.map(request=>({...request,importers:request.importers.filter(importer=>files.has(importer)),sourceImporterCount:request.importers.length}))}:undefined;
    const partition={sourceArtifactSha256:integrity!.sha256,sourceBytesSha256:sha(bytes),sourceClientCount:payload.clientContracts.length,sourceBlockerCount:source.completeness.blockers.length,selectedClientCount:clients.length,scope:'Selected consumer calls only; not a complete repository inventory'};
    return sealEnvelope({...draft,completeness:{...source.completeness,complete:false,blockers,unresolvedEndpoints},payload:{...payload,dependencyContext,clientContracts:clients},registryPartition:partition} as Parameters<typeof sealEnvelope>[0]);
  };
  const routes=new Map<string,FrontendClientContract[]>();
  for(const client of payload.clientContracts){const key=JSON.stringify([client.targetServiceId,client.httpMethod,client.normalizedRoute.split('?')[0]]),bucket=routes.get(key)??[];bucket.push(client);routes.set(key,bucket);}
  const groups:FrontendClientContract[][]=[];
  for(const clients of routes.values()){let group:FrontendClientContract[]=[],estimated=0;for(const client of clients){const size=Buffer.byteLength(JSON.stringify(client));if(group.length&&estimated+size>8*1024*1024){groups.push(group);group=[];estimated=0;}group.push(client);estimated+=size;}if(group.length)groups.push(group);}if(!groups.length)groups.push([]);
  const shards=groups.map((clients,index)=>{const artifact=make(clients),json=JSON.stringify(artifact);if(Buffer.byteLength(json)>20*1024*1024)throw Error(`Consumer partition ${index} exceeds 20 MiB; no evidence was dropped to fit`);const file=`frontend-${index}.json`;fs.writeFileSync(path.join(output,file),json,{flag:'wx'});return {file,bytes:Buffer.byteLength(json),sha256:sha(json),clients:clients.map(c=>({method:c.httpMethod,service:c.targetServiceId,routes:[c.normalizedRoute,...(c.routeDomain?.alternatives??[]).map(a=>a.path)],pathComplete:c.routeDomain?.pathComplete??false})),clientCount:clients.length};});
  const facts={version:'SAJIMORA_FRONTEND_REGISTRY_V1',sourceArtifactSha256:integrity!.sha256,sourceBytesSha256:sha(bytes),snapshot:source.snapshot,totalClients:payload.clientContracts.length,sourceBlockers:source.completeness.blockers.length,sourceComplete:source.completeness.complete,admission:'Locally derived partitions; original signatures are not transferred',shards};
  const manifest={...facts,integrity:sha(JSON.stringify(facts))};fs.writeFileSync(path.join(output,'registry.json'),JSON.stringify(manifest,null,2),{flag:'wx'});return manifest;
}
if(process.argv[1]?.endsWith('partitionFrontendArtifact.ts')){
  const [input,output,trust]=process.argv.slice(2);if(!input||!output||trust!=='--trusted-local')throw Error('Usage: partitionFrontendArtifact.ts INPUT OUTPUT_DIRECTORY --trusted-local');
  const started=performance.now(),manifest=partitionFrontendArtifact(path.resolve(input),path.resolve(output));console.log(JSON.stringify({registry:path.resolve(output,'registry.json'),clients:manifest.totalClients,shards:manifest.shards.length,largestShard:Math.max(...manifest.shards.map(s=>s.bytes)),elapsedMs:performance.now()-started,peakRss:process.resourceUsage().maxRSS*1024}));
}
