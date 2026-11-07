import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {parseEnvelope,verifyEnvelopeIntegrity,canonicalJson,FrontendContractPayload,BackendContractPayload,FrontendClientContract} from '../../packages/analysis/src/sajimora/cross-language/ContractArtifactEnvelope';
import {wireInclusion} from '../../packages/analysis/src/sajimora/cross-language/WireInclusion';
import {renderCustomerScopedReport} from '../../packages/analysis/src/sajimora/cross-language/CustomerScopedReport';

// Reconcile the fixed historical queue with fresh ordinary CLI exports. Do not
// count newly separated Spring handler variants as additional customer results.
const directory=resolve(process.argv[2]??'rust/audit/thingsboard-widget-obligations-2026-10-06');
const originalDirectory=resolve('rust/audit/thingsboard-widget-case-2026-10-06');
const json=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
const artifact=(path:string)=>{const value=parseEnvelope(readFileSync(path,'utf8'));if(!verifyEnvelopeIntegrity(value))throw new Error('Unsealed artifact: '+path);return value;};
const oldFrontend=artifact(join(originalDirectory,'frontend.json')),frontend=artifact(join(directory,'frontend.json')),backend=artifact(join(directory,'base.json'));
const oldReport=json(join(originalDirectory,'control.json')).scopedChanges,newReport=json(join(directory,'control.json')).scopedChanges,breakReport=json(join(directory,'break.json')).scopedChanges;
const queue=json(join(directory,'queue.json'));
const sourceFiles=['dao/src/main/java/org/thingsboard/server/dao/service/validator/WidgetTypeDataValidator.java','ui-ngx/src/app/core/interceptors/entity-conflict.interceptor.ts','ui-ngx/src/app/core/http/entity.service.ts','ui-ngx/src/app/core/http/http-utils.ts'];
mkdirSync(join(directory,'source-facts'),{recursive:true});
const sourceFacts=sourceFiles.map(file=>{const source=execFileSync('git',['-C',process.argv[3]??process.env.THINGSBOARD_REPO??'thingsboard','show',backend.snapshot.candidateSnapshot+':'+file],{encoding:'utf8'}),sha256=createHash('sha256').update(source).digest('hex');writeFileSync(join(directory,'source-facts',file.split('/').pop()!),source);return {file,revision:backend.snapshot.candidateSnapshot,sha256};});
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const identity=(client:FrontendClientContract)=>client.callIdentity??[client.sourceFile,client.sourceLine];
const oldClients=(oldFrontend.payload as FrontendContractPayload).clientContracts,newClients=(frontend.payload as FrontendContractPayload).clientContracts;
const routeKey=(id:string)=>JSON.parse(id).slice(0,4);
function unknowns(type:any,path='$',out:{path:string;reason:string}[]=[],depth=0){
  if(!type||depth>40)return out;
  if(type.kind==='UNKNOWN')out.push({path,reason:type.reason});
  for(const property of type.properties??[])unknowns(property.type,path+'.'+property.wireName,out,depth+1);
  for(const key of ['elementType','innerType','valueType'])if(type[key])unknowns(type[key],path+(key==='elementType'?'[]':''),out,depth+1);
  for(const child of type.types??[])unknowns(child,path,out,depth+1);
  return out;
}
for(const item of queue.items){
  const original=oldReport.assessments.find((assessment:any)=>assessment.obligationId===item.originalObligationId);
  if(!original)throw new Error('Original assessment missing: '+item.order);
  const callers=oldClients.filter(client=>hash([original.changeId,'$',oldFrontend.snapshot,oldFrontend.profile,oldFrontend.integrity!.sha256,identity(client)])===original.obligationId);
  if(callers.length!==1)throw new Error('Exact historical call identity required: '+item.order);
  const caller=newClients.find(client=>canonicalJson(identity(client))===canonicalJson(identity(callers[0])));
  if(!caller)throw new Error('Fresh caller identity changed: '+item.order);
  const endpoint=routeKey(item.endpointId),direction=endpoint[3];
  const current=newReport.assessments.filter((assessment:any)=>canonicalJson(routeKey(assessment.endpointId))===canonicalJson(endpoint)&&(direction==='REQUEST'?assessment.consumers.some((consumer:any)=>consumer.file===caller.sourceFile&&consumer.line===caller.sourceLine&&consumer.sourceSha256===caller.sourceSha256):hash([assessment.changeId,'$',frontend.snapshot,frontend.profile,frontend.integrity!.sha256,identity(caller)])===assessment.obligationId));
  if(!current.length)throw new Error('Fresh assessment missing: '+item.order);
  const owners=(backend.payload as BackendContractPayload).endpoints.filter(owner=>owner.identity.service===endpoint[0]&&owner.identity.httpMethod===endpoint[1]&&owner.identity.normalizedRoute.rawPath===endpoint[2]&&owner.identity.direction===direction);
  const closed=current.every((assessment:any)=>assessment.status==='COMPATIBILITY_PROVED_IN_SCOPE');
  const requests:string[]=[];
  if(!closed){
    if(item.order===1)requests.push('The sole direct caller is EntityService at entity.service.ts:491, which forwards entityIds and config. Establish that unencoded joined IDs and config.queryParams cannot introduce pageSize plus page (the paginated handler), or capture a finite branch-specific query domain. The widgetsBundleIds key alone does not rule out those keys.');
    if(direction==='REQUEST')requests.push(...(caller.requestTransport?.missingEvidence??[]));
    if(owners.length>1)requests.push('Capture the final encoded query key/value multimap at this exact call, including optional RequestConfig.queryParams and interceptor effects; it must select one of the recorded Spring handlers.');
    if(direction==='RESPONSE'&&caller.responseEffectsQualified!==true)requests.push('For this nonempty POST, qualify the entity-conflict interceptor: cancellation emits an of(null) event, while retry clones the body with version:null. Model the retry and Angular HttpClient event-to-body filtering, or establish a caller domain excluding this branch; a null event is not automatically a null JSON response body.');
    if(direction==='RESPONSE'&&owners.some(owner=>unknowns(owner.body).length))requests.push('Supply the allowed JSON schema for WidgetTypeDetails.descriptor (Java JsonNode), tied to this endpoint/revision and actual consumer paths. The captured WidgetTypeDataValidator checks descriptor null/size, which does not establish required keys or their types; TypeScript response annotations cannot establish them either.');
    if(direction==='RESPONSE')requests.push('Establish the recorded baseline mismatches for the selected handler with a runtime validator or a source-backed scoped consumer requirement. A sample payload alone cannot prove all values compatible.');
  }
  Object.assign(item,{status:closed?'CLOSED_IN_SCOPE':'EVIDENCE_REQUIRED',caller:{file:caller.sourceFile,line:caller.sourceLine,sourceSha256:caller.sourceSha256,callIdentity:caller.callIdentity,url:caller.normalizedRoute},freshAssessments:current.map((assessment:any)=>({obligationId:assessment.obligationId,endpointId:assessment.endpointId,status:assessment.status,checkedScope:assessment.checkedScope,missingEvidence:assessment.missingEvidence})),handlerEvidence:owners.map(owner=>({source:owner.provenance,predicates:owner.mappingConditions,unknownWirePaths:unknowns(owner.body),baselineMismatches:direction==='RESPONSE'?wireInclusion(owner.body??{kind:'PRIMITIVE',scalar:'void'},caller.expectedResponse).slice(0,12):[]})),evidenceRequests:[...new Set(requests)]});
}
const closed=queue.items.filter((item:any)=>item.status==='CLOSED_IN_SCOPE').length;
const seeded=breakReport.assessments.filter((assessment:any)=>assessment.status==='BREAK_PROVED');
if(seeded.length!==1||!seeded[0].endpointId.includes('/api/widgetTypeFqns')||!seeded[0].consumers.some((consumer:any)=>consumer.line===272&&consumer.usage==='widgetsBundleFqn.push(fqn)')||newReport.coverage.breaks!==0)throw new Error('Seeded break / unchanged control regression');
queue.summary={originalObligations:queue.items.length,closedInScope:closed,remaining:queue.items.length-closed,uniqueFreshCoverage:newReport.coverage,seededBreaks:seeded.length};
queue.artifacts={base:backend.integrity!.sha256,frontend:frontend.integrity!.sha256,control:'control.json',break:'break.json'};
queue.sourceFacts=sourceFacts;
writeFileSync(join(directory,'queue.json'),JSON.stringify(queue,null,2)+'\n');
const lines=['# Ordered widget obligations','',`${closed} of the original ${queue.items.length} obligations closed in scope; ${queue.items.length-closed} require evidence.`,`The fresh unchanged control has ${newReport.coverage.completed} completed caller checks and no confirmed breaks. The array-to-object seed still produces exactly one confirmed break at widget.service.ts:272.`,'','Body absence checks exclude query/header acceptance, authorization, handler selection, errors and timing. No performance target was measured.','','First-obligation follow-up: the consumer operation checker now recognizes native array sort. Handler ownership remains unresolved; [synthetic query counterexamples](handler-selection-counterexamples.json) explain why a widgetsBundleIds key or a UUID constraint alone does not establish the selected response handler. These examples are URL-domain checks, not confirmed API failures.',''];
for(const item of queue.items){lines.push(`## ${item.order}. ${item.status}: ${item.caller.url} (${routeKey(item.endpointId)[3].toLowerCase()})`,'',`Exact caller: ${item.caller.file}:${item.caller.line}. Original obligation: ${item.originalObligationId}.`,'');if(item.status==='CLOSED_IN_SCOPE')lines.push('Proved scope: absent request body accepted by every captured possible handler. Query-based handler selection remains separate.','');else{for(const request of item.evidenceRequests)lines.push('- '+request);lines.push('');}}
writeFileSync(join(directory,'RESULTS.md'),lines.join('\n')+'\n');
for(const name of ['control','break'])writeFileSync(join(directory,'customer-'+name+'.txt'),renderCustomerScopedReport(json(join(directory,name+'.json'))));
console.log(JSON.stringify(queue.summary));
