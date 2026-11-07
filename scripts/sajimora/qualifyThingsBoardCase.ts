import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';

/** Qualification harness: real frozen source, controlled declared codec, seeded
 * Java change, ordinary export/check commands. Never executes the application. */
const origin=process.argv[2]??process.env.THINGSBOARD_REPO??'thingsboard',revision='0439df09f31b0e8101b9f0a6be556c087d86818d';
const productionSource=process.argv[4]==='--production-source';
const outputRoot=resolve(process.argv[3]??'rust/audit/thingsboard-one-case-2026-10-06');mkdirSync(outputRoot,{recursive:true});
const repository=mkdtempSync(join(outputRoot,'source-'));
if(productionSource)execFileSync('git',['clone','--shared','--no-checkout',origin,repository],{stdio:'pipe'});
const controller='application/src/main/java/org/thingsboard/server/controller/NotificationController.java';
const service='ui-ngx/src/app/core/http/notification.service.ts';
const consumer='ui-ngx/src/app/modules/home/pages/notification/settings/notification-settings.component.ts';
const files=[controller,'common/data/src/main/java/org/thingsboard/server/common/data/notification/NotificationDeliveryMethod.java',service,consumer,'ui-ngx/src/app/shared/models/notification.models.ts','ui-ngx/tsconfig.json','ui-ngx/package.json','ui-ngx/yarn.lock',...['core.module.ts','auth/auth.service.ts','http/http-utils.ts','interceptors/global-http-interceptor.ts','interceptors/entity-conflict.interceptor.ts','interceptors/interceptor.util.ts','interceptors/interceptor-config.ts','interceptors/interceptor-http-params.ts'].map(file=>'ui-ngx/src/app/core/'+file)];
const sourceHashes:Record<string,string>={};
for(const file of files){const bytes=execFileSync('git',['-C',origin,'show',revision+':'+file],{maxBuffer:8*1024*1024});sourceHashes[file]=createHash('sha256').update(bytes).digest('hex');mkdirSync(dirname(join(repository,file)),{recursive:true});writeFileSync(join(repository,file),bytes);}
if(!productionSource)writeFileSync(join(repository,'application.properties'),'spring.jackson.property-naming-strategy=LOWER_CAMEL_CASE\n');
const git=(args:string[])=>execFileSync('git',['-C',repository,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
if(!productionSource)git(['init','--quiet']);git(['config','user.name','Sajimora Qualification']);git(['config','user.email','qualification@localhost']);
if(productionSource){git(['update-ref','HEAD',revision]);git(['read-tree',revision]);}else{git(['add','--all']);git(['commit','--quiet','-m','Frozen ThingsBoard case with declared default JSON qualification profile']);}const base=git(['rev-parse','HEAD']);
const original=readFileSync(join(repository,controller),'utf8');
const signature='public List<NotificationDeliveryMethod> getAvailableDeliveryMethods',returned='return notificationCenter.getAvailableDeliveryMethods(user.getTenantId());';
if(original.split(signature).length!==2||original.split(returned).length!==2)throw new Error('Seed method source identity changed');
writeFileSync(join(repository,controller),original.replace(signature,'public Map<String, NotificationDeliveryMethod> getAvailableDeliveryMethods').replace(returned,'return new HashMap<>();'));git(productionSource?['add',controller]:['add','--all']);git(['commit','--quiet','-m','Seed breaking delivery-method array to JSON object change']);const candidate=git(['rev-parse','HEAD']);
const run=(name:string,script:string,args:string[])=>{const result=spawnSync(process.execPath,['scripts/test-runtime/run-tsx-command.cjs',script,...args],{cwd:resolve('.'),encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});writeFileSync(join(outputRoot,name+'.log'),result.stderr+result.stdout);if(result.status!==0)throw new Error(name+' failed: '+result.stderr.slice(-1200));};
const backend=(name:string,commit:string)=>run(name,'scripts/sajimora/exportContract.ts',['--repo',repository,'--parent',base,'--candidate',commit,'--service-id','thingsboard','--api-version','v1',...(productionSource?['--spring-config-name','thingsboard']:[]),'--out',join(outputRoot,name+'.json')]);
backend('base',base);backend('candidate',candidate);
run('frontend','scripts/sajimora/exportFrontendContract.ts',['--repo',origin,'--parent',revision,'--candidate',revision,'--service-id','ui','--api-version','v1','--target-service-id','thingsboard','--target-api-version','v1','--ts-root',service,'--dependency-cache',resolve('scratch/exact-dependency-cache'),'--out',join(outputRoot,'frontend.json')]);
const check=(name:string,candidateName:string,customer=false)=>run(name,'scripts/sajimora/checkContract.ts',['--base',join(outputRoot,'base.json'),'--candidate',join(outputRoot,candidateName+'.json'),'--target',join(outputRoot,'frontend.json'),'--trusted-local','--assess-unchanged','--format',customer?'customer':'json','--out',join(outputRoot,name+(customer?'.txt':'.json'))]);
check('break','candidate');check('control','base');check('customer-break','candidate',true);check('customer-control','base',true);
let opaqueReport:any;
if(productionSource){
  const file='application/src/main/java/org/thingsboard/server/config/SeededJsonConfiguration.java';
  mkdirSync(dirname(join(repository,file)),{recursive:true});
  writeFileSync(join(repository,file),'package org.thingsboard.server.config;\nimport org.springframework.context.annotation.Configuration;\nimport org.springframework.context.annotation.Bean;\nimport com.fasterxml.jackson.databind.ObjectMapper;\n@Configuration\npublic class SeededJsonConfiguration {\n@Bean public ObjectMapper seededMapper(){return new ObjectMapper();}\n}\n');
  git(['add',file]);git(['commit','--quiet','-m','Seed opaque codec registration negative control']);
  backend('opaque-candidate',git(['rev-parse','HEAD']));check('opaque-control','opaque-candidate');
  opaqueReport=JSON.parse(readFileSync(join(outputRoot,'opaque-control.json'),'utf8'));
  const negativeAssessments=opaqueReport.scopedChanges.assessments.filter((a:any)=>a.endpointId.includes('/api/notification/deliveryMethods'));
  writeFileSync(join(outputRoot,'negative-validation.json'),JSON.stringify({accepted:negativeAssessments.length>0&&negativeAssessments.every((a:any)=>a.status==='EVIDENCE_REQUIRED'),base,candidate:git(['rev-parse','HEAD']),assessments:negativeAssessments},null,2));
}
const report=JSON.parse(readFileSync(join(outputRoot,'break.json'),'utf8')),control=JSON.parse(readFileSync(join(outputRoot,'control.json'),'utf8')),frontend=JSON.parse(readFileSync(join(outputRoot,'frontend.json'),'utf8'));
const endpoint='/api/notification/deliveryMethods',selected=(result:any)=>result.scopedChanges.assessments.filter((assessment:any)=>assessment.endpointId.includes(endpoint));
const findings=selected(report),controls=selected(control),call=frontend.payload.clientContracts.find((client:any)=>client.normalizedRoute===endpoint);
const opaqueControls=opaqueReport?selected(opaqueReport):[];
const success=findings.some((assessment:any)=>assessment.status==='BREAK_PROVED'&&assessment.consumers.some((site:any)=>site.file===consumer&&site.usage.includes('allowMethods.filter')))&&!controls.some((assessment:any)=>assessment.status==='BREAK_PROVED')&&controls.some((assessment:any)=>assessment.status==='COMPATIBILITY_PROVED_IN_SCOPE')&&(!productionSource||opaqueControls.length>0&&opaqueControls.every((assessment:any)=>assessment.status==='EVIDENCE_REQUIRED'));
const result={accepted:success,originRevision:revision,sourceHashes,repository,base,candidate,endpoint,call:{responseEffectsQualified:call?.responseEffectsQualified,options:call?.httpOptionsEvidence,responseUsage:call?.responseUsage},breakAssessments:findings,controlAssessments:controls,coverage:{break:report.scopedChanges.coverage,control:control.scopedChanges.coverage},scope:['Full frozen ThingsBoard frontend source context; notification service calls exported on demand',productionSource?'Full frozen production backend sources and captured build-selected thingsboard.yml; no synthetic configuration':'Captured Java producer slice under an explicit default JSON qualification profile','Actual call, helper chain, both captured interceptors, actual consumer and seeded Java producer edit','Successful response body and declared compatibility scope; not a whole ThingsBoard deployment or runtime execution'],otherEvidenceRequests:report.scopedChanges.evidenceRequests.length};
if(productionSource)Object.assign(result,{negativeControlAssessments:opaqueControls});
writeFileSync(join(outputRoot,'acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({accepted:success,breaks:findings.filter((a:any)=>a.status==='BREAK_PROVED').length,completedControls:controls.filter((a:any)=>a.status==='COMPATIBILITY_PROVED_IN_SCOPE').length,outputRoot}));if(!success)process.exitCode=1;
