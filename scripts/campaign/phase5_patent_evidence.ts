import * as fs from 'node:fs';
import * as path from 'node:path';
import { SemanticIndexDatabase, SemanticIngestionWorker, WarmIndexedQueryEngine, GitRepository, SnapshotFilesystem, DualTypeScriptProgramBuilder, TypeScriptProgramBuilder, AnalysisContext, ConsumerDiscoveryCoordinator } from '@sajimora/analysis';
import { deriveRealDiffObligations } from './realDiffObligationAdapter';
import { evaluateCommitPair } from './campaign_runner';

const root = path.resolve('patent_deliverables/evidence');
const dbPath = path.join(root, 'zod-phase5-patent-evidence.db');
const output = path.join(root, 'phase5-patent-evidence.json');
const repoName='zod', repoPath=path.resolve('scripts/campaign/repos/zod'), dependencyRoot=path.resolve('scripts/campaign/repos/zod/node_modules');
const parentSha='68a609ac9b9516e6fe84e3558f17ce16b1032bef', candidateSha='2ec972ecc5a8af8135ed072d2d5b5363c27bb46f';
const subject='Phase 5 patent controlled evidence';
function mem(){ const m=process.memoryUsage(); return {rss:m.rss,heapUsed:m.heapUsed,heapTotal:m.heapTotal}; }
function load(){ return fs.existsSync(output) ? JSON.parse(fs.readFileSync(output,'utf8')) : { generatedAt:new Date().toISOString(), environment:{node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch}, repository:{repoName,parentSha,candidateSha,subject}, phases:{} }; }
function save(v:any){ fs.mkdirSync(root,{recursive:true}); fs.writeFileSync(output,JSON.stringify(v,null,2)); }
function instrument<T>(fn:()=>T){
 const c:any={dualProgramBuilds:0,singleProgramBuilds:0,analysisContextGetProgram:0,consumerDiscovery:0,gitValidate:0,snapshotMaterialize:0};
 const originals:any={dual:DualTypeScriptProgramBuilder.prototype.build,single:TypeScriptProgramBuilder.prototype.build,ctx:AnalysisContext.prototype.getProgram,disc:ConsumerDiscoveryCoordinator.prototype.discover,git:GitRepository.prototype.validate,snap:SnapshotFilesystem.prototype.materialize};
 DualTypeScriptProgramBuilder.prototype.build=function(...a:any[]){c.dualProgramBuilds++;return Reflect.apply(originals.dual,this,a)};
 TypeScriptProgramBuilder.prototype.build=function(...a:any[]){c.singleProgramBuilds++;return Reflect.apply(originals.single,this,a)};
 AnalysisContext.prototype.getProgram=function(...a:any[]){c.analysisContextGetProgram++;return Reflect.apply(originals.ctx,this,a)};
 ConsumerDiscoveryCoordinator.prototype.discover=function(...a:any[]){c.consumerDiscovery++;return Reflect.apply(originals.disc,this,a)};
 GitRepository.prototype.validate=function(...a:any[]){c.gitValidate++;return Reflect.apply(originals.git,this,a)};
 SnapshotFilesystem.prototype.materialize=function(...a:any[]){c.snapshotMaterialize++;return Reflect.apply(originals.snap,this,a)};
 try{return {value:fn(),counters:c}}finally{DualTypeScriptProgramBuilder.prototype.build=originals.dual;TypeScriptProgramBuilder.prototype.build=originals.single;AnalysisContext.prototype.getProgram=originals.ctx;ConsumerDiscoveryCoordinator.prototype.discover=originals.disc;GitRepository.prototype.validate=originals.git;SnapshotFilesystem.prototype.materialize=originals.snap;}
}
const mode=process.argv[2]; const v=load();
if(mode==='ingest'){
 if(fs.existsSync(dbPath)) fs.rmSync(dbPath);
 const db=new SemanticIndexDatabase({location:dbPath}); const d=deriveRealDiffObligations(repoPath,parentSha,candidateSha); if(d.status!=='DERIVED')throw new Error(d.status);
 const t=performance.now(),before=mem(); const report=new SemanticIngestionWorker().ingestCommitPair({repoName,repoPath,parentSha,candidateSha,db,dependencyRoot,obligations:d.obligations}); const after=mem(); db.close();
 v.phases.ingestion={durationMs:performance.now()-t,before,after,report,dbPath};save(v);console.log(JSON.stringify(v.phases.ingestion));
} else if(mode==='baseline'){
 const t=performance.now(),before=mem(); const r=instrument(()=>evaluateCommitPair(repoName,repoPath,parentSha,candidateSha,subject,dependencyRoot)); const after=mem(); if(global.gc)global.gc();const postGc=mem();
 v.phases.baseline={durationMs:performance.now()-t,before,after,postGc,counters:r.counters,astTraversalCount:'NOT MEASURED',fullRepositoryScanCount:'NOT MEASURED',candidateAnalyses:1,result:{analyzable:r.value.analyzable,mutationsCount:r.value.mutationsCount,evaluations:r.value.evaluations.map((x:any)=>({targetSymbol:x.targetSymbol,verdict:x.verdict,authorityReason:x.authorityReason}))}};save(v);console.log(JSON.stringify(v.phases.baseline));
} else if(mode==='warm'){
 const db=new SemanticIndexDatabase({location:dbPath}); const before=mem();const runs:any[]=[];for(let i=0;i<3;i++){const t=performance.now();const r=instrument(()=>WarmIndexedQueryEngine.evaluateCommitPair({repoName,parentSha,candidateSha,db,subject}));runs.push({durationMs:performance.now()-t,counters:r.counters,result:{analyzable:r.value.analyzable,mutationsCount:r.value.mutationsCount,evaluations:r.value.evaluations.map((x:any)=>({targetSymbol:x.targetSymbol,verdict:x.verdict,authorityReason:x.authorityReason}))},memoryAfterQuery:mem()});}const after=mem();if(global.gc)global.gc();const postGc=mem();db.close();
 v.phases.warm={before,after,postGc,astTraversalCount:'NOT MEASURED',fullRepositoryScanCount:'NOT MEASURED',candidateAnalyses:3,persistentStore:'SQLite file reopened in a separate process',runs};save(v);console.log(JSON.stringify(v.phases.warm));
} else throw new Error('mode must be ingest, baseline, or warm');
