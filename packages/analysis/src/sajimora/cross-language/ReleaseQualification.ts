import {ScopedAssessment} from './ScopedChangeAssessment';

export interface TruthCase {
  readonly id:string;readonly origin:'SEEDED'|'REAL_ADJUDICATED';readonly supported:boolean;readonly expected:'BREAK'|'SAFE'|'EVIDENCE_REQUIRED';
  readonly producerRevision:string;readonly consumerRevision:string;readonly dependencyDigest:string;readonly analysisProfile:string;
  readonly witnessPaths:readonly string[];readonly consumerFiles:readonly string[];
}
export interface QualificationRun {
  readonly caseId:string;readonly assessments:readonly ScopedAssessment[];readonly proofManifestValid:boolean;
  readonly producerRevision:string;readonly consumerRevision:string;readonly dependencyDigest:string;readonly analysisProfile:string;
  readonly globalCompatibilityClaim?:boolean;readonly discoveryComplete:boolean;
}
export interface ColdStartMeasurement {
  readonly checkerHash:string;readonly hardware:string;readonly workload:string;readonly cacheState:'EMPTY_INDEX';readonly runs:number;
  readonly firstEvidenceP50Ms:number;readonly firstEvidenceP95Ms:number;readonly peakRssBytes:number;readonly peakPrivateCommitBytes:number;readonly aggregateProcessTree:boolean;
}
/** Truth labels and completed obligations are distinct from blocker occurrences.
 * No measured release readiness is inferred from unit-test counts. */
export function qualifyRelease(corpus:readonly TruthCase[],runs:readonly QualificationRun[],options:{checkerHash:string;declaredFragment:string;implementationComplete:boolean;measurement?:ColdStartMeasurement}):{
  version:'SAJIMORA_RELEASE_QUALIFICATION_V1';releaseReady:boolean;declaredFragment:string;
  metrics:{cases:number;truePositives:number;falsePositives:number;falseNegatives:number;abstentions:number;precision:number|null;recall:number|null};
  realAdjudicated:{sampleSize:number;precision:number|null;recall:number|null};failures:readonly {caseId?:string;reason:string}[];
} {
  const failures:{caseId?:string;reason:string}[]=[],ids=new Set<string>(),byId=new Map(runs.map(run=>[run.caseId,run]));let tp=0,fp=0,fn=0,abstentions=0,realTp=0,realFp=0,realFn=0,realCount=0;
  if(!corpus.length)failures.push({reason:'A nonempty versioned truth corpus is required'});
  if(new Set(runs.map(run=>run.caseId)).size!==runs.length)failures.push({reason:'Duplicate qualification outputs cannot be merged into one truth case'});
  for(const truth of corpus){
    const reject=(reason:string)=>failures.push({caseId:truth.id,reason});if(ids.has(truth.id)){reject('Duplicate truth case identity');continue;}ids.add(truth.id);
    if(truth.origin==='REAL_ADJUDICATED')realCount++;
    const run=byId.get(truth.id);if(!run){reject('Truth case has no qualification result');abstentions++;if(truth.expected==='BREAK'){fn++;if(truth.origin==='REAL_ADJUDICATED')realFn++;}continue;}
    const identityValid=!['producerRevision','consumerRevision','dependencyDigest','analysisProfile'].some(key=>!truth[key as keyof TruthCase]||truth[key as keyof TruthCase]!==run[key as keyof QualificationRun]);
    if(!identityValid)reject('Historical revisions, dependency digest or analysis profile mismatch');
    const breaks=run.assessments.filter(a=>a.status==='BREAK_PROVED'),compatible=run.assessments.some(a=>a.status==='COMPATIBILITY_PROVED_IN_SCOPE'||a.status==='NOT_APPLICABLE_TO_OBLIGATION');
    if(!run.proofManifestValid&&(breaks.length||compatible))reject('Invalid/incomplete proof manifest published a proved result');
    if(run.globalCompatibilityClaim&&(!run.discoveryComplete||run.assessments.some(a=>['EVIDENCE_REQUIRED','CHECK_PENDING','SOURCE_CONTRACT_INVALID'].includes(a.status))))reject('Unresolved or incomplete coverage was promoted to global compatibility');
    if(!breaks.length&&!compatible)abstentions++;
    if(truth.expected==='BREAK'){
      const matched=identityValid&&run.proofManifestValid&&breaks.some(a=>a.witness&&truth.witnessPaths.includes(a.witness.path)&&truth.consumerFiles.every(file=>a.consumers.some(c=>c.file===file)));
      if(matched){tp++;if(truth.origin==='REAL_ADJUDICATED')realTp++;}
      else{fn++;if(truth.origin==='REAL_ADJUDICATED')realFn++;if(truth.supported)reject('Supported break lacks the expected path and affected consumer witness');}
    }else if(breaks.length){fp++;if(truth.origin==='REAL_ADJUDICATED')realFp++;reject('Negative control or unresolved domain was reported as a proved break');}
    if(truth.expected==='EVIDENCE_REQUIRED'&&compatible)reject('Missing facts were converted into a compatible verdict');
    if(truth.expected==='SAFE'&&truth.supported&&!compatible)reject('Supported safe control did not complete its declared assessment');
  }
  for(const run of runs)if(!ids.has(run.caseId))failures.push({caseId:run.caseId,reason:'Output has no independent truth judgment'});
  if(!options.declaredFragment||!options.implementationComplete)failures.push({reason:'Declared implementation fragment is incomplete'});
  const measurement=options.measurement;
  if(!measurement)failures.push({reason:'Cold-start timing and aggregate process-tree memory are unmeasured; optimization is deferred'});
  else{
    if(measurement.checkerHash!==options.checkerHash||!measurement.hardware||!measurement.workload||measurement.cacheState!=='EMPTY_INDEX'||!measurement.aggregateProcessTree||!Number.isInteger(measurement.runs)||measurement.runs<3)failures.push({reason:'Cold-start measurement workload, checker identity, cache state or process-tree scope is unqualified'});
    if(![measurement.firstEvidenceP50Ms,measurement.firstEvidenceP95Ms,measurement.peakRssBytes,measurement.peakPrivateCommitBytes].every(value=>Number.isFinite(value)&&value>=0)||measurement.firstEvidenceP95Ms<measurement.firstEvidenceP50Ms)failures.push({reason:'Invalid cold-start measurement values'});
    if(measurement.firstEvidenceP95Ms>10000)failures.push({reason:'Measured first-evidence p95 exceeds the 5–10-second target'});
    if(measurement.peakRssBytes>=500000000)failures.push({reason:'Measured aggregate peak RSS does not meet the below-500-MB target'});
  }
  const rate=(numerator:number,denominator:number)=>denominator?numerator/denominator:null;
  return {version:'SAJIMORA_RELEASE_QUALIFICATION_V1',releaseReady:failures.length===0,declaredFragment:options.declaredFragment,metrics:{cases:corpus.length,truePositives:tp,falsePositives:fp,falseNegatives:fn,abstentions,precision:rate(tp,tp+fp),recall:rate(tp,tp+fn)},realAdjudicated:{sampleSize:realCount,precision:rate(realTp,realTp+realFp),recall:rate(realTp,realTp+realFn)},failures};
}
