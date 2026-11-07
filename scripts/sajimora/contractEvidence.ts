import {readFileSync,statSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {importSchemaEvidence,SchemaEvidence} from '../../packages/analysis/src/sajimora/cross-language/SchemaEvidence';
import {assessObservation,ContractObservation} from '../../packages/analysis/src/sajimora/cross-language/ObservedContractEvidence';
import {parseGraphArtifact} from '../../packages/analysis/src/sajimora/cross-language/RecursiveWireGraph';

/** Explicit local schema/CI ingestion. No network access or application replay. */
function main(){
  const command=process.argv[2],args=new Map<string,string>();let trusted=false;
  if(!['schema','observation'].includes(command))throw new Error('Usage: contractEvidence.ts schema|observation --in evidence.json --identity scope.json --trusted-local [--contract graph.json] [--out result.json]');
  for(let index=3;index<process.argv.length;index++){const flag=process.argv[index];if(flag==='--trusted-local'){trusted=true;continue;}const value=process.argv[++index];if(!['--in','--identity','--contract','--out'].includes(flag)||!value||value.startsWith('--')||args.has(flag))throw new Error('Invalid/duplicate evidence argument '+flag);args.set(flag,value);}
  if(!trusted)throw new Error('Explicit --trusted-local required for local evidence artifacts');
  const read=(flag:string)=>{const name=args.get(flag);if(!name)throw new Error('Missing '+flag);const file=resolve(name);if(statSync(file).size>8*1024*1024)throw new Error('Evidence input exceeds 8 MiB admission budget');return readFileSync(file,'utf8');};
  const evidence=JSON.parse(read('--in')),identity=JSON.parse(read('--identity'));
  const result=command==='schema'?importSchemaEvidence(evidence as SchemaEvidence,identity):assessObservation(evidence as ContractObservation,parseGraphArtifact(read('--contract')).graph,identity);
  const output=JSON.stringify(result,null,2)+'\n',out=args.get('--out');if(out)writeFileSync(resolve(out),output,'utf8');else process.stdout.write(output);
}
try{main();}catch(error){process.stderr.write('[contractEvidence] '+(error as Error).message+'\n');process.exitCode=1;}
