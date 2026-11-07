import * as fs from 'node:fs';
import * as path from 'node:path';
import {GitRepository} from '../../packages/analysis/src/sajimora/snapshots/GitRepository';
import {captureSnapshotPair} from '../../packages/analysis/src/sajimora/cross-language/CrossLanguageSnapshotPair';
import {DependencyDeclarationContext} from '../../packages/analysis/src/sajimora/cross-language/DependencyDeclarationContext';
import {TypeScriptGraphExtractor} from '../../packages/analysis/src/sajimora/cross-language/TypeScriptGraphExtractor';
import {parseGraphArtifact,sealGraphArtifact} from '../../packages/analysis/src/sajimora/cross-language/RecursiveWireGraph';
import {graphInclusion} from '../../packages/analysis/src/sajimora/cross-language/GraphInclusion';

/** Explicit V2 graph command. Existing V1 contract commands continue to reject
 * graph artifacts rather than silently treating references as tree nodes. */
async function main():Promise<void>{
  const command=process.argv[2],args=new Map<string,string>();let trustedLocal=false;
  const allowed=command==='export'?['--repo','--revision','--file','--type','--out','--dependency-cache']:command==='compare'?['--producer','--consumer','--producer-root','--consumer-root','--out']:[];
  if(!allowed.length)throw new Error('Usage: typeGraph.ts export|compare; comparisons require --trusted-local');
  for(let i=3;i<process.argv.length;i++){const flag=process.argv[i];if(flag==='--trusted-local'&&command==='compare'){trustedLocal=true;continue;}const value=process.argv[++i];if(!allowed.includes(flag)||!value||value.startsWith('--')||args.has(flag))throw new Error('Invalid or duplicate argument '+flag);args.set(flag,value);}
  const required=(flag:string)=>{const value=args.get(flag);if(!value)throw new Error('Missing '+flag);return value;};
  let output:unknown;
  if(command==='export'){
    const repository=new GitRepository(required('--repo'));repository.validate();
    const selector=required('--revision'),commit=repository.text(['rev-parse','--verify',(selector==='working-tree'?'HEAD':selector)+'^{commit}']).trim();
    const pair=await captureSnapshotPair({repository,parentCommit:commit,candidate:selector==='working-tree'?{kind:'working-tree'}:{kind:'commit',sha:commit},includeExtensions:['.ts','.tsx','.mts','.cts','.json','.lock']});
    if(pair.blockers.length)throw new Error('Snapshot capture incomplete: '+pair.blockers.map(b=>b.code).join(','));
    const origin=path.posix.normalize(required('--file').replace(/\\/g,'/'));
    if(origin.startsWith('../')||path.posix.isAbsolute(origin)||/^[A-Za-z]:/.test(origin)||!pair.candidateFiles.has(origin))throw new Error('A captured repository-relative type source file is required');
    const files=new DependencyDeclarationContext(new Map([...pair.candidateFiles].map(([file,data])=>{const text=data.bytes.toString('utf8');if(!Buffer.from(text,'utf8').equals(data.bytes))throw new Error('Captured type/config source is not valid UTF-8: '+file);return [file,text];})),args.get('--dependency-cache'));
    output=sealGraphArtifact(new TypeScriptGraphExtractor(files).extract(required('--type'),origin,JSON.stringify(pair.identity)));
  }else{
    if(!trustedLocal)throw new Error('Explicit --trusted-local required; digests alone do not authenticate graph artifacts');
    const read=(flag:string)=>{const file=path.resolve(required(flag));if(fs.statSync(file).size>20*1024*1024)throw new Error('Graph artifact exceeds admission budget');return parseGraphArtifact(fs.readFileSync(file,'utf8'));};
    const producer=read('--producer'),consumer=read('--consumer');
    output={version:'SAJIMORA_GRAPH_COMPARISON_V2',producer:producer.integrity,consumer:consumer.integrity,...graphInclusion(producer.graph,consumer.graph,required('--producer-root'),required('--consumer-root'))};
  }
  const json=JSON.stringify(output,null,2)+'\n',out=args.get('--out');
  if(out){const file=path.resolve(out);fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp-'+process.pid;try{fs.writeFileSync(temp,json,{flag:'wx'});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}else process.stdout.write(json);
}
main().catch(error=>{process.stderr.write('[typeGraph] '+(error as Error).message+'\n');process.exitCode=1;});
