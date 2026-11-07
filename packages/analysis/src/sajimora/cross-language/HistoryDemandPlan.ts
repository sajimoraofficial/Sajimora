import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {canonicalJson} from './ContractArtifactEnvelope';
import {ScopedEvidenceStore} from './ScopedEvidenceStore';
import {ScopedChangeResults} from './ScopedChangeAssessment';

export interface HistoryUnit {readonly id:string;readonly parent:string|null;readonly candidate:string;readonly paths:readonly {status:string;before:string|null;after:string|null}[];}
export interface HistoryDemandPlan {readonly version:'SAJIMORA_HISTORY_PLAN_V1';readonly generationKey:string;readonly mode:'EVER_BROKE'|'NET_CHANGE';readonly head:string;readonly boundary:string;readonly timeZone:string;readonly analysisProfile:string;readonly units:readonly HistoryUnit[];readonly discoveryComplete:boolean;readonly missingEvidence:readonly string[];}
/** Preserve local calendar date/time, clamp month-end; choose the earliest valid
 * instant during a repeated local hour. Nonexistent local times need a profile. */
export function calendarMonthBoundary(reference:string,months:number,timeZone:string):string {
  const instant=new Date(reference);if(!Number.isFinite(instant.valueOf())||!Number.isInteger(months)||months<0||months>120)throw new Error('Valid as-of instant and bounded calendar month count required');
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const parts=(date:number)=>Object.fromEntries(formatter.formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
  const wall=parts(instant.valueOf()),monthIndex=wall.year*12+wall.month-1-months,year=Math.floor(monthIndex/12),month=monthIndex%12;
  const desired=Date.UTC(year,month,Math.min(wall.day,new Date(Date.UTC(year,month+1,0)).getUTCDate()),wall.hour,wall.minute,wall.second,instant.getUTCMilliseconds());
  let candidate=desired;for(let iteration=0;iteration<4;iteration++){const current=parts(candidate),offset=Date.UTC(current.year,current.month-1,current.day,current.hour,current.minute,current.second)-Math.floor(candidate/1000)*1000;const next=desired-offset;if(next===candidate)break;candidate=next;}
  const target=new Date(desired),valid=(value:number)=>{const current=parts(value);return current.year===target.getUTCFullYear()&&current.month===target.getUTCMonth()+1&&current.day===target.getUTCDate()&&current.hour===target.getUTCHours()&&current.minute===target.getUTCMinutes()&&current.second===target.getUTCSeconds();};
  const alternatives=[-7200000,-3600000,-1800000,0,1800000,3600000,7200000].map(delta=>candidate+delta).filter(valid);if(!alternatives.length)throw new Error('Nonexistent calendar boundary local time requires an explicit boundary profile');return new Date(Math.min(...alternatives)).toISOString();
}
export function planHistoryDemand(root:string,request:{head:string;asOf:string;timeZone:string;mode:'EVER_BROKE'|'NET_CHANGE';analysisProfile:string;maxCommits?:number;maxUnits?:number}):HistoryDemandPlan {
  if(!request.analysisProfile||!['EVER_BROKE','NET_CHANGE'].includes(request.mode))throw new Error('Explicit audit mode and qualified analysis profile fingerprint required');
  const maxCommits=request.maxCommits??200,maxUnits=request.maxUnits??200;if(!Number.isInteger(maxCommits)||maxCommits<1||maxCommits>2000||!Number.isInteger(maxUnits)||maxUnits<1||maxUnits>2000)throw new Error('History queue limits must be integers in 1..2000');
  const git=(args:string[])=>execFileSync('git',['--no-optional-locks','-C',root,...args],{encoding:'utf8',maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
  const head=git(['rev-parse','--verify','--end-of-options',request.head+'^{commit}']).trim(),boundary=calendarMonthBoundary(request.asOf,6,request.timeZone),missing=new Set<string>();
  const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
  const generationKey=digest(['SAJIMORA_HISTORY_PLAN_V1',head,boundary,request.mode,request.timeZone,request.analysisProfile,maxCommits,maxUnits]);
  const units:HistoryUnit[]=[];
  const add=(parent:string|null,candidate:string)=>{
    const data=git(['diff-tree','--no-commit-id','--name-status','-r','-z','-M',...(parent?[parent,candidate]:['--root',candidate])]).split('\0').filter(Boolean),paths:HistoryUnit['paths'][number][]=[];
    for(let index=0;index<data.length;){const status=data[index++],first=data[index++];if(!first)throw new Error('Malformed Git path metadata');let before:string|null=status==='A'?null:first,after:string|null=status==='D'?null:first;if(/^[RC]/.test(status)){after=data[index++];if(!after)throw new Error('Malformed Git rename metadata');}
      // Body-only source edits and context changes remain candidates. No header
      // fingerprint is used to establish API irrelevance.
      if([before,after].some(file=>file&&/\.(?:java|[jt]sx?|[mc][jt]s|json|lock|xml|gradle|yml|yaml|properties|html)$/.test(file)))paths.push({status,before,after});
    }
    if(!paths.length)return;
    if(units.length>=maxUnits){missing.add('History candidate queue limit reached; remaining metadata requires a subsequent generation');return;}
    units.push({id:digest([generationKey,parent,candidate,paths]),parent,candidate,paths});
  };
  if(request.mode==='NET_CHANGE'){
    const baseline=git(['rev-list','--first-parent','--max-count=1','--before='+boundary,head]).trim();
    if(baseline)add(baseline,head);else{missing.add('No first-parent baseline exists at the calendar boundary; explicit empty-tree baseline semantics required');}
  }else{
    const entries=git(['log','--format=%H%x00%P','--since-as-filter='+boundary,'--until='+request.asOf,'--max-count='+String(maxCommits+1),head]).trim().split(/\r?\n/).filter(Boolean);
    if(entries.length>maxCommits)missing.add('History commit metadata limit reached; discovery is incomplete');
    for(const entry of entries.slice(0,maxCommits)){const [candidate,parents]=entry.split('\0');for(const parent of parents?parents.split(' '):[null])add(parent,candidate);}
  }
  return {version:'SAJIMORA_HISTORY_PLAN_V1',generationKey,mode:request.mode,head,boundary,timeZone:request.timeZone,analysisProfile:request.analysisProfile,units,discoveryComplete:missing.size===0,missingEvidence:[...missing].sort()};
}
/** Single bounded writer, unit-level publication and cancellation. The callback
 * is analyzer-owned; this runner never loads or executes repository programs. */
export async function executeDemandPlan(plan:HistoryDemandPlan,store:ScopedEvidenceStore,assess:(unit:HistoryUnit,signal:AbortSignal)=>Promise<ScopedChangeResults>,options:{signal?:AbortSignal;onPublished?:(unit:HistoryUnit,result:ScopedChangeResults)=>void}={}):Promise<{generationKey:string;complete:boolean;completed:number;failed:number;cancelled:boolean;published:readonly string[];missingEvidence:readonly string[]}> {
  const signal=options.signal??new AbortController().signal,published:string[]=[],missing=[...plan.missingEvidence],prior=new Map(store.jobs().map(job=>[job.jobId,job]));let completed=0,failed=0,coverageComplete=true;
  const retain=(unit:HistoryUnit,result:ScopedChangeResults)=>{published.push(result.proofKey!);completed++;if(result.assessments.some(a=>['EVIDENCE_REQUIRED','CHECK_PENDING'].includes(a.status)))coverageComplete=false;try{options.onPublished?.(unit,result);}catch{missing.push('Published finding notification failed; valid stored unit remains available');}};
  for(const unit of plan.units)if(prior.get(unit.id)?.state!=='COMPLETED')store.updateJob(unit.id,plan.generationKey,'PENDING',{completed:0,total:1,message:'Captured historical change awaiting its dependency closure'});
  for(const unit of plan.units){
    if(signal.aborted){if(prior.get(unit.id)?.state!=='COMPLETED')store.updateJob(unit.id,plan.generationKey,'CANCELLED',{completed:0,total:1,message:'Cancelled before unit admission'});continue;}
    const previous=prior.get(unit.id),cached=previous?.state==='COMPLETED'?store.read(previous.proofKey):undefined;if(cached){retain(unit,cached);continue;}
    store.updateJob(unit.id,plan.generationKey,'RUNNING',{completed:0,total:1,message:'Analyzing captured producer and consumer closure'});
    try{
      const result=await assess(unit,signal);if(signal.aborted)throw new Error('History analysis cancelled');
      store.publish(result,signal);store.updateJob(unit.id,result.proofKey!,'COMPLETED',{completed:1,total:1,message:'Manifest-validated scoped unit published'});retain(unit,result);
    }catch(error){const cancelled=signal.aborted;store.updateJob(unit.id,plan.generationKey,cancelled?'CANCELLED':'FAILED',{completed:0,total:1,message:cancelled?'Cancelled; previous valid units retained':(error as Error).message.slice(0,300)});if(!cancelled){failed++;missing.push('Historical unit '+unit.id+' failed: '+(error as Error).message.slice(0,300));}}
  }
  return {generationKey:plan.generationKey,complete:plan.discoveryComplete&&coverageComplete&&!failed&&!signal.aborted&&completed===plan.units.length,completed,failed,cancelled:signal.aborted,published,missingEvidence:[...new Set(missing)].sort()};
}

/** Read one immutable blob after explicit path admission. No checkout/install. */
export function readHistoricalBlob(root:string,commit:string,file:string):{objectId:string;sha256:string;bytes:Buffer}|undefined {
  if(!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)||file.startsWith('/')||file.split(/[\\/]/).includes('..')||file.includes('\\')||/^[A-Za-z]:/.test(file))throw new Error('Exact commit and repository-relative historical source path required');
  const git=(args:string[])=>execFileSync('git',['--no-optional-locks','-C',root,...args],{maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
  const entry=git(['ls-tree','-z',commit,'--',file]).toString('utf8');if(!entry)return undefined;
  const separator=entry.indexOf('\t'),[mode,type,objectId]=entry.slice(0,separator).split(' '),name=entry.slice(separator+1).replace(/\0$/,'');
  if(name!==file||type!=='blob'||!['100644','100755'].includes(mode)||!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(objectId))throw new Error('Historical path is not an admitted regular source blob');
  const bytes=git(['cat-file','blob',objectId]),actual=createHash(objectId.length===40?'sha1':'sha256').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');if(actual!==objectId)throw new Error('Historical blob content address mismatch');
  return {objectId,sha256:createHash('sha256').update(bytes).digest('hex'),bytes};
}
