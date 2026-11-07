import {describe,it,expect} from 'vitest';
import {qualifyRelease,TruthCase,QualificationRun} from '../../../src/sajimora/cross-language/ReleaseQualification';
import {ScopedAssessment} from '../../../src/sajimora/cross-language/ScopedChangeAssessment';
const identity={producerRevision:'producer',consumerRevision:'consumer',dependencyDigest:'deps',analysisProfile:'profile'};
const truth:TruthCase={id:'rename',origin:'SEEDED',supported:true,expected:'BREAK',...identity,witnessPaths:['$.id'],consumerFiles:['client.ts']};
const assessment:ScopedAssessment={changeId:'change',endpointId:'GET /x',obligationId:'obligation',status:'BREAK_PROVED',checkedScope:['$.id'],assumptions:[],evidenceIds:['evidence'],consumers:[{file:'client.ts',line:1,usage:'value.id.toFixed()'}],witness:{path:'$.id',reason:'numeric receiver rejected',before:'number',after:'string'},missingEvidence:[]};
const run:QualificationRun={caseId:'rename',...identity,assessments:[assessment],proofManifestValid:true,discoveryComplete:false};
describe('customer-value qualification and release gates',()=>{
  it('counts a witnessed seeded break while keeping unmeasured release readiness false',()=>{
    const result=qualifyRelease([truth],[run],{checkerHash:'checker',declaredFragment:'native numeric consumer calls',implementationComplete:true});expect(result.metrics).toMatchObject({truePositives:1,falsePositives:0,falseNegatives:0,precision:1,recall:1});expect(result.releaseReady).toBe(false);expect(result.realAdjudicated.sampleSize).toBe(0);
  });
  it('rejects wrong consumer witnesses and negative-control false positives',()=>{
    expect(qualifyRelease([truth],[{...run,assessments:[{...assessment,consumers:[]}]}],{checkerHash:'checker',declaredFragment:'test',implementationComplete:true}).metrics.falseNegatives).toBe(1);
    expect(qualifyRelease([{...truth,expected:'SAFE'}],[run],{checkerHash:'checker',declaredFragment:'test',implementationComplete:true}).metrics.falsePositives).toBe(1);
  });
  it('blocks stale manifests, unknown-to-compatible promotion and incomplete global claims',()=>{
    const result=qualifyRelease([{...truth,expected:'EVIDENCE_REQUIRED',supported:false}],[{...run,proofManifestValid:false,globalCompatibilityClaim:true,assessments:[{...assessment,status:'COMPATIBILITY_PROVED_IN_SCOPE',witness:undefined},{...assessment,obligationId:'pending',status:'EVIDENCE_REQUIRED'}]}],{checkerHash:'checker',declaredFragment:'test',implementationComplete:true});expect(result.failures.some(f=>f.reason.includes('manifest'))).toBe(true);expect(result.failures.some(f=>f.reason.includes('Missing facts'))).toBe(true);expect(result.failures.some(f=>f.reason.includes('global'))).toBe(true);
  });
  it('requires measured process-tree memory and a matching checker identity',()=>{
    const result=qualifyRelease([truth],[run],{checkerHash:'current',declaredFragment:'test',implementationComplete:true,measurement:{checkerHash:'old',hardware:'machine',workload:'fixture',cacheState:'EMPTY_INDEX',runs:3,firstEvidenceP50Ms:6000,firstEvidenceP95Ms:11000,peakRssBytes:1400000000,peakPrivateCommitBytes:1500000000,aggregateProcessTree:false}});expect(result.failures.some(f=>f.reason.includes('p95'))).toBe(true);expect(result.failures.some(f=>f.reason.includes('500'))).toBe(true);expect(result.releaseReady).toBe(false);
  });
  it('does not count stale proofs as accurate and includes missing real cases in sample coverage',()=>{
    for(const invalid of [{...run,producerRevision:'old'},{...run,proofManifestValid:false}])expect(qualifyRelease([truth],[invalid],{checkerHash:'checker',declaredFragment:'test',implementationComplete:true}).metrics).toMatchObject({truePositives:0,falseNegatives:1});
    const missing=qualifyRelease([{...truth,origin:'REAL_ADJUDICATED'}],[],{checkerHash:'checker',declaredFragment:'test',implementationComplete:true});expect(missing.realAdjudicated.sampleSize).toBe(1);expect(missing.metrics.abstentions).toBe(1);
  });
});
