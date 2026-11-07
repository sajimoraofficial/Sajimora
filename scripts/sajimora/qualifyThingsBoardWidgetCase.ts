import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {parseEnvelope,verifyEnvelopeIntegrity,BackendContractPayload,FrontendContractPayload} from '../../packages/analysis/src/sajimora/cross-language/ContractArtifactEnvelope';
import {GitRepository} from '../../packages/analysis/src/sajimora/snapshots/GitRepository';
import {captureSnapshotPair} from '../../packages/analysis/src/sajimora/cross-language/CrossLanguageSnapshotPair';
import {qualifySpringJsonSourceProfile} from '../../packages/analysis/src/sajimora/cross-language/SpringJsonSourceProfile';

async function main(){
  const origin=process.argv[2]??process.env.THINGSBOARD_REPO??'thingsboard',output=resolve(process.argv[3]??'rust/audit/thingsboard-widget-case-2026-10-06');
  const revision='0439df09f31b0e8101b9f0a6be556c087d86818d',controller='application/src/main/java/org/thingsboard/server/controller/WidgetTypeController.java',service='ui-ngx/src/app/core/http/widget.service.ts',endpoint='/api/widgetTypeFqns';
  mkdirSync(output,{recursive:true});
  const baselinePath=resolve('rust/audit/thingsboard-production-source-2026-10-06/base.json');
  const baseline=parseEnvelope(readFileSync(baselinePath,'utf8'));
  if(!verifyEnvelopeIntegrity(baseline)||baseline.kind!=='BACKEND_CONTRACT'||baseline.snapshot.candidateSnapshot!==revision||baseline.snapshot.serviceId!=='thingsboard'||baseline.snapshot.apiVersion!=='v1'||baseline.profile.codecProfile!=='JACKSON_DEFAULT_V1')throw new Error('Exact sealed baseline required');
  const captured=await captureSnapshotPair({repository:new GitRepository(origin),parentCommit:revision,candidate:{kind:'commit',sha:revision}});
  const profile=qualifySpringJsonSourceProfile(captured.candidateFiles,'thingsboard');
  if(profile.blockers.length||profile.fingerprint!==baseline.profile.configFingerprint||baseline.snapshot.repositoryId!==captured.identity.repositoryId)throw new Error('Baseline source profile no longer qualifies');
  const producer=(baseline.payload as BackendContractPayload).endpoints.filter(e=>e.identity.normalizedRoute.rawPath===endpoint&&e.identity.direction==='RESPONSE');
  const controllerSource=captured.candidateFiles.get(controller)!;
  if(producer.length!==1||producer[0].provenance.sha256!==controllerSource.sha256||producer[0].body?.kind!=='ARRAY')throw new Error('Baseline producer provenance mismatch');
  copyFileSync(baselinePath,join(output,'base.json'));writeFileSync(join(output,'source-profile-validation.json'),JSON.stringify(profile,null,2));
  const repository=mkdtempSync(join(output,'source-'));execFileSync('git',['clone','--shared','--no-checkout',origin,repository],{stdio:'pipe'});
  const git=(args:string[])=>execFileSync('git',['-C',repository,...args],{encoding:'utf8',stdio:'pipe'}).trim();
  git(['config','user.name','Sajimora Qualification']);git(['config','user.email','qualification@localhost']);git(['update-ref','HEAD',revision]);git(['read-tree',revision]);
  const original=controllerSource.bytes.toString('utf8'),signature='public List<String> getBundleWidgetTypeFqns(',returned='return checkNotNull(widgetTypeService.findWidgetFqnsByWidgetsBundleId(getTenantId(), widgetsBundleId));';
  if(original.split(signature).length!==2||original.split(returned).length!==2)throw new Error('Seed source identity changed');
  mkdirSync(dirname(join(repository,controller)),{recursive:true});
  writeFileSync(join(repository,controller),original.replace(signature,'public java.util.Map<String, String> getBundleWidgetTypeFqns(').replace(returned,'return new java.util.HashMap<>();'));
  git(['add',controller]);git(['commit','--quiet','-m','Seed widget FQN array-to-object response break']);const candidate=git(['rev-parse','HEAD']);
  const run=(name:string,script:string,args:string[])=>{const r=spawnSync(process.execPath,['scripts/test-runtime/run-tsx-command.cjs',script,...args],{encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024});writeFileSync(join(output,name+'.log'),r.stderr+r.stdout);if(r.status!==0)throw new Error(name+' failed: '+r.stderr.slice(-1200));};
  run('candidate','scripts/sajimora/exportContract.ts',['--repo',repository,'--parent',revision,'--candidate',candidate,'--service-id','thingsboard','--api-version','v1','--spring-config-name','thingsboard','--out',join(output,'candidate.json')]);
  if(process.argv[4]){
    const supplied=parseEnvelope(readFileSync(resolve(process.argv[4]),'utf8'));
    if(!verifyEnvelopeIntegrity(supplied)||supplied.kind!=='FRONTEND_CONTRACT'||supplied.snapshot.candidateSnapshot!==revision||supplied.snapshot.serviceId!=='ui')throw new Error('Exact sealed frontend required');
    const call=(supplied.payload as FrontendContractPayload).clientContracts.find(c=>c.normalizedRoute.split('?')[0]===endpoint);
    if(!call||call.sourceSha256!==captured.candidateFiles.get(service)?.sha256||call.targetServiceId!=='thingsboard'||call.targetApiVersion!=='v1')throw new Error('Frontend call provenance mismatch');
    copyFileSync(resolve(process.argv[4]),join(output,'frontend.json'));
  }else run('frontend','scripts/sajimora/exportFrontendContract.ts',['--repo',origin,'--parent',revision,'--candidate',revision,'--service-id','ui','--api-version','v1','--target-service-id','thingsboard','--target-api-version','v1','--ts-root',service,'--dependency-cache',resolve('scratch/exact-dependency-cache'),'--out',join(output,'frontend.json')]);
  const check=(name:string,next:string,customer=false)=>run(name,'scripts/sajimora/checkContract.ts',['--base',join(output,'base.json'),'--candidate',join(output,next+'.json'),'--target',join(output,'frontend.json'),'--trusted-local','--assess-unchanged','--format',customer?'customer':'json','--out',join(output,name+(customer?'.txt':'.json'))]);
  check('break','candidate');check('control','base');check('customer-break','candidate',true);check('customer-control','base',true);
  const report=JSON.parse(readFileSync(join(output,'break.json'),'utf8')),control=JSON.parse(readFileSync(join(output,'control.json'),'utf8'));
  const selected=(r:any)=>r.scopedChanges.assessments.filter((a:any)=>a.endpointId.includes(endpoint));
  const findings=selected(report),controls=selected(control),accepted=findings.some((a:any)=>a.status==='BREAK_PROVED'&&a.consumers.some((c:any)=>c.file===service&&c.line===272&&c.usage==='widgetsBundleFqn.push(fqn)'))&&controls.some((a:any)=>a.status==='COMPATIBILITY_PROVED_IN_SCOPE')&&!controls.some((a:any)=>a.status==='BREAK_PROVED');
  const result={accepted,originRevision:revision,repository,base:revision,candidate,endpoint,sourceHashes:{[controller]:controllerSource.sha256,[service]:captured.candidateFiles.get(service)!.sha256},baselineArtifact:{path:baselinePath,sha256:baseline.integrity!.sha256,reused:true},breakAssessments:findings,controlAssessments:controls,coverage:{break:report.scopedChanges.coverage,control:control.scopedChanges.coverage},scope:['Full frozen production backend and frontend context','Captured source-default JSON profile; external/profile/runtime codec overrides excluded','Dynamic query value acceptance remains separate','Actual service-to-service response usage through RxJS mergeMap; native array push operation']};
  writeFileSync(join(output,'acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({accepted,coverage:result.coverage}));if(!accepted)process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
