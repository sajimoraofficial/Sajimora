import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {planHistoryDemand} from '../../packages/analysis/src/sajimora/cross-language/HistoryDemandPlan';

/** Metadata plan only. Semantic execution uses the analyzer-owned unit runner. */
function main(){
  const args=new Map<string,string>();for(let index=2;index<process.argv.length;index++){const flag=process.argv[index],value=process.argv[++index];if(!['--repo','--head','--as-of','--timezone','--mode','--analysis-profile','--out'].includes(flag)||!value||value.startsWith('--')||args.has(flag))throw new Error('Invalid/duplicate history argument '+flag);args.set(flag,value);}
  const required=(flag:string)=>{const value=args.get(flag);if(!value)throw new Error('Missing '+flag);return value;},mode=required('--mode');if(mode!=='ever'&&mode!=='net')throw new Error('--mode must be ever or net');
  const result=planHistoryDemand(resolve(required('--repo')),{head:required('--head'),asOf:required('--as-of'),timeZone:required('--timezone'),mode:mode==='ever'?'EVER_BROKE':'NET_CHANGE',analysisProfile:required('--analysis-profile')});
  const output=JSON.stringify(result,null,2)+'\n',out=args.get('--out');if(out)writeFileSync(resolve(out),output,'utf8');else process.stdout.write(output);
}
try{main();}catch(error){process.stderr.write('[historyPlan] '+(error as Error).message+'\n');process.exitCode=1;}
