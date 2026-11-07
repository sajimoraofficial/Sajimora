import {describe,it,expect} from 'vitest';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {calendarMonthBoundary,planHistoryDemand,readHistoricalBlob,executeDemandPlan,HistoryDemandPlan} from '../../../src/sajimora/cross-language/HistoryDemandPlan';
import {ScopedEvidenceStore} from '../../../src/sajimora/cross-language/ScopedEvidenceStore';
import {attachScopedEvidence} from '../../../src/sajimora/cross-language/ScopedEvidence';
describe('bounded history metadata and atomic unit publication',()=>{
  it('uses six calendar months with timezone and month-end clamping',()=>{
    expect(calendarMonthBoundary('2026-08-31T06:30:00Z',6,'Asia/Calcutta')).toBe('2026-02-28T06:30:00.000Z');
    expect(calendarMonthBoundary('2024-08-31T00:00:00Z',6,'UTC')).toBe('2024-02-29T00:00:00.000Z');
  });
  it('plans frozen body-only changes and reads only an admitted source blob',()=>{
    mkdirSync(resolve('scratch'),{recursive:true});const root=mkdtempSync(resolve('scratch/spec11-history-'));
    const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8',env:{...process.env,GIT_AUTHOR_DATE:'2026-10-05T10:00:00Z',GIT_COMMITTER_DATE:'2026-10-05T10:00:00Z'}}).trim();
    git('init','--quiet');writeFileSync(join(root,'api.ts'),'export const value=1;');git('add','api.ts');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','base');const base=git('rev-parse','HEAD');
    writeFileSync(join(root,'api.ts'),'export const value=2;');git('add','api.ts');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','body change');
    const plan=planHistoryDemand(root,{head:'HEAD',asOf:'2026-10-06T00:00:00Z',timeZone:'UTC',mode:'EVER_BROKE',analysisProfile:'fixture-profile'});
    expect(plan.units.some(unit=>unit.parent===base&&unit.paths.some(p=>p.after==='api.ts'))).toBe(true);
    expect(readHistoricalBlob(root,base,'api.ts')?.bytes.toString()).toContain('value=1');expect(readHistoricalBlob(root,base,'missing.ts')).toBeUndefined();
    expect(()=>readHistoricalBlob(root,base,'../api.ts')).toThrow();
    expect(planHistoryDemand(root,{head:'HEAD',asOf:'2026-10-06T00:00:00Z',timeZone:'UTC',mode:'EVER_BROKE',analysisProfile:'fixture-profile',maxCommits:1}).discoveryComplete).toBe(false);
  });
  it('publishes the first valid unit and reuses an immutable completed unit',async()=>{
    const store=new ScopedEvidenceStore(':memory:');const plan:HistoryDemandPlan={version:'SAJIMORA_HISTORY_PLAN_V1',generationKey:'plan',mode:'EVER_BROKE',head:'head',boundary:'boundary',timeZone:'UTC',analysisProfile:'test',units:[{id:'unit',parent:'base',candidate:'head',paths:[]}],discoveryComplete:true,missingEvidence:[]};
    const result=attachScopedEvidence({version:'SAJIMORA_SCOPED_ASSESSMENTS_V1',assessments:[],coverage:{completed:0,breaks:0,pending:0,changedObligations:0},evidenceRequests:[]},[]);let calls=0,published=0;
    try{expect((await executeDemandPlan(plan,store,async()=>{calls++;return result;},{onPublished:()=>published++})).complete).toBe(true);await executeDemandPlan(plan,store,async()=>{calls++;return result;});expect(calls).toBe(1);expect(published).toBe(1);}finally{store.close();}
  });
  it('keeps failed or cancelled queues incomplete and preserves earlier valid generations',async()=>{
    const store=new ScopedEvidenceStore(':memory:'),controller=new AbortController();const result=attachScopedEvidence({version:'SAJIMORA_SCOPED_ASSESSMENTS_V1',assessments:[],coverage:{completed:0,breaks:0,pending:0,changedObligations:0},evidenceRequests:[]},[]);store.publish(result);
    const plan:HistoryDemandPlan={version:'SAJIMORA_HISTORY_PLAN_V1',generationKey:'plan',mode:'NET_CHANGE',head:'head',boundary:'boundary',timeZone:'UTC',analysisProfile:'test',units:[{id:'fail',parent:'base',candidate:'head',paths:[]}],discoveryComplete:true,missingEvidence:[]};
    try{const failed=await executeDemandPlan(plan,store,async()=>{throw new Error('worker failure');});expect(failed.complete).toBe(false);controller.abort();expect((await executeDemandPlan(plan,store,async()=>result,{signal:controller.signal})).cancelled).toBe(true);expect(store.read(result.proofKey!)).toBeDefined();}finally{store.close();}
  });
});
