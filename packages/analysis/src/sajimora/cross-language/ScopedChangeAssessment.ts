import {createHash} from 'node:crypto';
import {ContractArtifactEnvelope,BackendContractPayload,FrontendContractPayload,FrontendClientContract,canonicalJson} from './ContractArtifactEnvelope';
import {EndpointContract,WireType,mkObjectWireType} from './CanonicalContractIR';
import {ConsumerSite} from './CrossLanguageContracts';
import {normalizeRouteSegments} from './EndpointIdentity';
import {wireInclusion,propertyType} from './WireInclusion';
import {ResponseProjection} from './AngularInterceptorSummary';
import {attachScopedEvidence,AssessmentStatus,EvidenceRecord,bodyUse} from './ScopedEvidence';
import {graphInclusion} from './GraphInclusion';
import {declaredWireGraph} from './WireTypeGraph';
import {operationFailure,conditionalOperationFailure,ConditionalOperationFinding} from './ConsumerOperationObligations';

export interface ScopedAssessment {
  readonly changeId:string;
  readonly endpointId:string;
  readonly obligationId:string;
  readonly status:AssessmentStatus;
  readonly checkedScope:readonly string[];
  readonly assumptions:readonly string[];
  readonly evidenceIds:readonly string[];
  readonly consumers:readonly ConsumerSite[];
  readonly witness?:{path:string;reason:string;before:string;after:string};
  readonly missingEvidence:readonly string[];
  readonly conditionalFindings?:readonly ConditionalOperationFinding[];
}
export interface ScopedChangeResults {
  readonly evidenceVersion?:'SAJIMORA_SCOPED_EVIDENCE_V1';
  readonly proofKey?:string;
  readonly evidenceRecords?:readonly EvidenceRecord[];
  readonly version:'SAJIMORA_SCOPED_ASSESSMENTS_V1';
  readonly assessments:readonly ScopedAssessment[];
  readonly coverage:{completed:number;breaks:number;pending:number;changedObligations:number};
  readonly evidenceRequests:readonly {reason:string;affectedObligations:readonly string[];affectedEndpoints?:readonly string[];affectedConsumers?:readonly ConsumerSite[]}[];
}
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const endpointKey=(ep:EndpointContract)=>canonicalJson([ep.identity.service,ep.identity.httpMethod,ep.identity.normalizedRoute.rawPath,ep.identity.direction,...(ep.mappingConditions?.params.length?[{params:[...ep.mappingConditions.params].sort()}]:[])]);
const under=(scope:string,path:string)=>path===scope||path.startsWith(scope+'.')||path.startsWith(scope+'[');
const callerRoutes=(client:FrontendClientContract):string[]=>client.routeDomain?.pathComplete&&client.routeDomain.alternatives.length?[...new Set(client.routeDomain.alternatives.map(route=>route.path))]:[client.normalizedRoute.split('?')[0]];
function mappingMatch(client:FrontendClientContract,endpoint:EndpointContract):boolean|undefined {
  if(!endpoint.mappingConditions?.complete)return undefined;
  if(!endpoint.mappingConditions.params.length)return true;
  if(endpoint.mappingConditions.params.some(condition=>!/^!?[\w.-]+$/.test(condition)))return undefined;
  const domain=client.routeDomain;
  if(client.queryParametersPreserved!==true||client.httpOptionsEvidence?.queryParametersAbsent!==true||!domain?.pathComplete||domain.missingEvidence.length||!domain.alternatives.length)return undefined;
  const matches=domain.alternatives.map(route=>endpoint.mappingConditions!.params.every(condition=>{
    const absent=condition.startsWith('!'),key=absent?condition.slice(1):condition;
    return /^[\w.-]+$/.test(key)&&route.query.some(query=>query.key===key)!==absent;
  }));
  return matches.every(Boolean)?true:matches.every(match=>!match)?false:undefined;
}
function callerMatchesEndpoint(path:string,endpoint:EndpointContract,possible=false):boolean {
  const caller=normalizeRouteSegments(path),server=normalizeRouteSegments(endpoint.identity.normalizedRoute.rawPath);
  if(path==='<dynamic>')return false;
  for(let index=0;index<server.segments.length;index++){
    const segment=server.segments[index],value=caller.segments[index];
    if(segment.isWildcard&&segment.text==='**')return possible;
    if(!value)return false;
    if(segment.isWildcard){if(!possible)return false;continue;}
    if(segment.regexConstraint){
      // An anchored negative literal prefix excludes this concrete segment even
      // when the rest of the Java regex is outside the supported fragment.
      const prefix=segment.regexConstraint.match(/^\^((?:\(\?![A-Za-z0-9_-]+\$\))+)/)?.[1];
      if(!value.isParam&&!segment.regexConstraint.includes('|')&&prefix&&[...prefix.matchAll(/\(\?!([A-Za-z0-9_-]+)\$\)/g)].some(m=>m[1]===value.text))return false;
      if(!possible)return false;continue;
    }
    if(segment.isParam)continue;
    if(value.isParam){if(!possible)return false;continue;}
    if(value.text!==segment.text)return false;
  }
  return caller.segments.length===server.segments.length;
}
function changedPaths(before:WireType|null,after:WireType|null,path='$'):string[]{
  if(before?.kind==='OBJECT'&&after?.kind==='OBJECT'){
    const a=new Map(before.properties.map(p=>[p.wireName,p])),b=new Map(after.properties.map(p=>[p.wireName,p]));
    return [...new Set([...a.keys(),...b.keys()])].flatMap(key=>{
      const x=a.get(key),y=b.get(key),child=path+'.'+key;
      if(!x||!y||x.optional!==y.optional||x.nullable!==y.nullable)return [child];
      return changedPaths(x.type,y.type,child);
    });
  }
  return canonicalJson(before)===canonicalJson(after)?[]:[path];
}
function atPath(type:WireType|null,path:string):WireType|undefined{
  let current=type??undefined;
  for(const key of path.replace(/^\$\.?/,'').split('.').filter(Boolean)){
    if(current?.kind==='UNKNOWN')return current;
    if(current?.kind!=='OBJECT')return current?{kind:'UNKNOWN',reason:'Projection path requires a structural object and null/omission guard evidence'}:undefined;
    const property=current.properties.find(p=>p.wireName===key);
    current=property?propertyType(property):undefined;
  }
  return current;
}
function changedObligations(before:EndpointContract,after:EndpointContract):string[]{
  const paths=changedPaths(before.body,after.body);
  for(const category of ['queryParameters','headers','pathParameters'] as const){
    const old=new Map(before[category].map(p=>[p.name,p])),fresh=new Map(after[category].map(p=>[p.name,p]));
    for(const name of new Set([...old.keys(),...fresh.keys()]))if(canonicalJson(old.get(name)??null)!==canonicalJson(fresh.get(name)??null))paths.push(category+':'+name);
  }
  for(const category of ['responseStatuses','mediaTypes'] as const)if(canonicalJson(before[category]??null)!==canonicalJson(after[category]??null))paths.push('transport:'+category);
  return paths;
}
export function projectResponseWire(type:WireType|null,projections:readonly ResponseProjection[]):WireType|null {
  let current=type;
  for(const projection of projections){
    const input=current;
    current=mkObjectWireType(projection.fields.map(field=>({wireName:field.output,type:input?.kind==='UNKNOWN'?input:atPath(input,'$.'+field.input.join('.'))??{kind:'PRIMITIVE',scalar:'void'},optional:false,nullable:false,validationConstraints:[]})));
  }
  return current;
}
/** Versioned source-contract assessments. These do not override the legacy
 * verdict and never discharge transport, serialization or whole-application use. */
export function assessBackendChanges(base:ContractArtifactEnvelope,candidate:ContractArtifactEnvelope,targets:readonly ContractArtifactEnvelope[],options:{assessUnchanged?:boolean}={}):ScopedChangeResults {
  const assessments:ScopedAssessment[]=[];
  if(base.kind!=='BACKEND_CONTRACT'||candidate.kind!=='BACKEND_CONTRACT')return attachScopedEvidence(results(assessments),[base,candidate,...targets]);
  const old=new Map((base.payload as BackendContractPayload).endpoints.map(ep=>[endpointKey(ep),ep]));
  const fresh=new Map((candidate.payload as BackendContractPayload).endpoints.map(ep=>[endpointKey(ep),ep]));
  for(const key of new Set([...old.keys(),...fresh.keys()])){
    const before=old.get(key),after=fresh.get(key),ep=after??before!;
    const paths=before&&after?changedObligations(before,after):['endpoint'];
    if(!paths.length&&!options.assessUnchanged)continue;
    const changeId=hash([base.snapshot,candidate.snapshot,key,before??null,after??null]);
    const linked:{client:FrontendClientContract;target:ContractArtifactEnvelope}[]=[];
    for(const target of targets)if(target.kind==='FRONTEND_CONTRACT')for(const client of (target.payload as FrontendContractPayload).clientContracts){
      if(client.httpMethod!==ep.identity.httpMethod||client.targetServiceId!==candidate.snapshot.serviceId||client.targetApiVersion!==candidate.snapshot.apiVersion)continue;
      const server=normalizeRouteSegments(ep.identity.normalizedRoute.rawPath);
      if(!server.segments.some(s=>s.isWildcard||s.regexConstraint)&&callerRoutes(client).some(route=>callerMatchesEndpoint(route,ep))&&mappingMatch(client,ep)!==false)linked.push({client,target});
    }
    // Explicit unchanged controls cover mapped target calls, rather than issuing
    // evidence requests for every unrelated endpoint in a full backend snapshot.
    if(!paths.length&&options.assessUnchanged&&linked.length)paths.push('$');
    if(!paths.length)continue;
    const assessedPaths=new Set(paths);
    for(const {client} of linked)if(before&&after&&client.responseProjections?.length)for(const path of changedPaths(projectResponseWire(before.body,client.responseProjections),projectResponseWire(after.body,client.responseProjections)))assessedPaths.add(path);
    for(const path of assessedPaths){
      if(!linked.length){assessments.push({changeId,endpointId:key,obligationId:hash([changeId,path]),status:'EVIDENCE_REQUIRED',checkedScope:[],assumptions:[],evidenceIds:[],consumers:[],missingEvidence:['Uniquely mapped active caller with target service/API identity required']});continue;}
      for(const {client,target} of linked){
        const beforeBody=before?projectResponseWire(before.body,client.responseProjections??[]):null;
        const afterBody=after?projectResponseWire(after.body,client.responseProjections??[]):null;
        if(before&&after&&client.responseProjections?.length&&!path.includes(':')&&!changedPaths(beforeBody,afterBody).includes(path))continue;
        const missing:string[]=[],evidenceIds=[base.integrity?.sha256,candidate.integrity?.sha256,target.integrity?.sha256,before?.provenance.sha256,after?.provenance.sha256,client.sourceSha256,...(client.routeDomain?.sourceEvidence??[]).map(e=>e.sha256),...(client.requestTransport?.sourceEvidence??[]).map(e=>e.sha256),...(client.httpOptionsEvidence?.sourceEvidence??[]).map(e=>e.sha256),...(client.responseProjections??[]).map(p=>p.sourceSha256)].filter((x):x is string=>!!x);
        let consumers=path==='endpoint'||path.includes(':')?[...client.consumers]:(client.responseUsage??client.consumers as ConsumerSite[]).filter(c=>c.propertyPath&&under(path,c.propertyPath));
        const obligationId=hash([changeId,path,target.snapshot,target.profile,target.integrity?.sha256,client.callIdentity??[client.sourceFile,client.sourceLine]]);
        const assumptions=['Compared source-declared wire contracts, not observed runtime payloads','Producer encoder profile is as declared in the backend artifact'];
        assumptions.push(...new Set([...((base.payload as BackendContractPayload).serializationAssumptions??[]),...((candidate.payload as BackendContractPayload).serializationAssumptions??[])]));
        assumptions.push(...(client.responseEffectAssumptions??[]));
        let status:ScopedAssessment['status']='EVIDENCE_REQUIRED',witness:ScopedAssessment['witness'],conditionalFindings:ConditionalOperationFinding[]=[];
        const bodyOwners=(artifact:ContractArtifactEnvelope)=>(artifact.payload as BackendContractPayload).endpoints.filter(owner=>owner.identity.direction==='REQUEST'&&owner.identity.httpMethod===client.httpMethod&&owner.identity.service===client.targetServiceId&&callerRoutes(client).some(route=>callerMatchesEndpoint(route,owner,true)));
        const oldBodyOwners=bodyOwners(base),newBodyOwners=bodyOwners(candidate);
        const uniformAbsentAcceptance=ep.identity.direction==='REQUEST'&&path==='$'&&client.absentRequestBodyQualified===true&&client.requestTransport?.kind==='ABSENT'&&client.httpOptionsEvidence?.requestBodyAbsent===true&&oldBodyOwners.length>0&&newBodyOwners.length>0&&[...oldBodyOwners,...newBodyOwners].every(owner=>owner.body===null);
        if(uniformAbsentAcceptance){assumptions.push('Every captured candidate request handler admits the same absent-body contract; this does not establish query-based handler selection');evidenceIds.push(...[...oldBodyOwners,...newBodyOwners].map(owner=>owner.provenance.sha256).filter((value):value is string=>!!value));}
        const possibleOwners=[...new Set([...old.values(),...fresh.values()].filter(owner=>owner.identity.direction===ep.identity.direction&&owner.identity.httpMethod===client.httpMethod&&owner.identity.service===client.targetServiceId&&callerRoutes(client).some(route=>callerMatchesEndpoint(route,owner,true))&&mappingMatch(client,owner)!==false).map(endpointKey))];
        if(possibleOwners.length!==1&&!uniformAbsentAcceptance)missing.push('Multiple candidate endpoint owners require route disambiguation');
        if(client.routeDomain&&!client.routeDomain.pathComplete)missing.push('Complete captured route path alternatives required');
        if(ep.mappingConditions?.complete===false&&!uniformAbsentAcceptance)missing.push('Complete Spring mapping predicates required');
        if(ep.mappingConditions?.params.length&&mappingMatch(client,ep)!==true&&!uniformAbsentAcceptance)missing.push(`Captured query values and request effects must establish Spring handler predicates: ${ep.mappingConditions.params.join(', ')}`);
        if(!callerRoutes(client).every(route=>callerMatchesEndpoint(route,ep)))missing.push('Route alternatives outside this endpoint require branch-specific caller reachability evidence');
        if(base.snapshot.repositoryId!==candidate.snapshot.repositoryId||base.snapshot.serviceId!==candidate.snapshot.serviceId||base.snapshot.apiVersion!==candidate.snapshot.apiVersion)missing.push('Matching backend revision identity required');
        if(base.profile.codecProfile!==candidate.profile.codecProfile||base.profile.frameworkProfile!==candidate.profile.frameworkProfile||base.profile.configFingerprint!==candidate.profile.configFingerprint)missing.push('Changed serializer/framework configuration requires requalification');
        if(!uniformAbsentAcceptance&&((base.payload as BackendContractPayload).endpoints.filter(owner=>endpointKey(owner)===key).length>1||(candidate.payload as BackendContractPayload).endpoints.filter(owner=>endpointKey(owner)===key).length>1))missing.push('Ambiguous duplicate endpoint declarations require ownership evidence');
        if([base,candidate].some(artifact=>artifact.completeness.blockers.some(b=>['UNRESOLVED_JACKSON_CONFIG','TOOL_FAILURE','FILE_READ_ERROR'].includes(b.code))))missing.push('Producer serialization configuration or source extraction requires qualification');
        if(!client.callIdentity||client.callIdentity.sourceSha256!==client.sourceSha256)missing.push('Source-hashed exact call identity required');
        if(path!=='endpoint'&&!path.includes(':')&&client.httpOptionsEvidence?.responseType&&client.httpOptionsEvidence.responseType!=='json')missing.push(`Exact ${client.httpOptionsEvidence.responseType} transport encoder/decoder domain required; a JSON DTO comparison cannot qualify this body`);
        if(path.includes(':')){
          const name=path.startsWith('queryParameters:')?path.slice('queryParameters:'.length):null;
          const previous=name===null?undefined:before?.queryParameters.find(parameter=>parameter.name===name),required=name===null?undefined:after?.queryParameters.find(parameter=>parameter.name===name);
          const domain=client.routeDomain;
          if(name!==null&&before&&after&&required?.required===true&&(!previous||previous.required===false&&!previous.validationConstraints?.length)&&client.requestEffectsQualified===true&&domain?.pathComplete&&!domain.missingEvidence.length&&domain.alternatives.length&&domain.alternatives.every(route=>route.query.every(parameter=>parameter.key!==name))&&candidate.profile.frameworkProfile==='SPRING_MVC'&&!missing.length){
            status='BREAK_PROVED';witness={path,reason:'Captured request omits a query parameter newly required by the endpoint',before:'query parameter absence admitted',after:'required query parameter absent'};
            consumers=[{file:client.sourceFile,line:client.sourceLine,sourceSha256:client.sourceSha256,usage:'HTTP call omits required query parameter '+name}];assumptions.push('Declared Spring MVC required-query binding and source-qualified request effects');
          }else missing.push(`Exact caller ${path.startsWith('transport:')?'status/media expectations':'encoded query/header/path values'} and producer acceptance summary required for ${path}`);
        }
        else if(ep.identity.direction==='REQUEST'){
          const body=client.requestTransport;
          consumers=[{file:client.sourceFile,line:client.sourceLine,sourceSha256:client.sourceSha256,usage:'HTTP request body at this call',propertyPath:path}];
          if(body?.status==='SOURCE_CONTRACT_INVALID'){status='SOURCE_CONTRACT_INVALID';missing.push(...body.missingEvidence);}
          else if(!before||!after||!(client.requestEffectsQualified===true||client.absentRequestBodyQualified===true&&body?.kind==='ABSENT'&&client.httpOptionsEvidence?.requestBodyAbsent===true)||!body||body.status!=='ENCODED_DOMAIN'||!['JSON','ABSENT'].includes(body.kind))missing.push('Request encoder and acceptance obligation summaries required');
          else if(!missing.length){
            const domain=body.valueGraph??declaredWireGraph(null,target.snapshot.candidateSnapshot);
            const oldResult=graphInclusion(domain,declaredWireGraph(before.body,base.snapshot.candidateSnapshot),'body','body');
            const current=graphInclusion(domain,declaredWireGraph(after.body,candidate.snapshot.candidateSnapshot),'body','body');
            assumptions.push(...body.assumptions);if(client.absentRequestBodyQualified===true)assumptions.push('Request body absence only; query values, headers, authorization and handler selection require separate qualification');consumers=[{file:client.sourceFile,line:client.sourceLine,sourceSha256:client.sourceSha256,usage:'HTTP request body at this call',propertyPath:path}];
            if(oldResult.status!=='COMPATIBILITY_PROVED_IN_SCOPE')missing.push('Base request-body acceptance is not established; separate pre-existing mismatch or missing evidence');
            else if(current.status==='BREAK_PROVED'&&current.witness){status='BREAK_PROVED';witness={path:current.witness.path,reason:current.witness.reason,before:'request value admitted by base body contract',after:'request value rejected by candidate body contract'};}
            else if(current.status==='COMPATIBILITY_PROVED_IN_SCOPE')status='COMPATIBILITY_PROVED_IN_SCOPE';
            else missing.push(...current.missingEvidence);
          }
        }
        else if(path==='endpoint'){
          if(before&&!after&&candidate.completeness.complete&&!missing.length){status='BREAK_PROVED';witness={path,reason:'Uniquely mapped active caller targets a deleted endpoint',before:'endpoint present',after:'endpoint absent'};}
          else missing.push('Complete candidate endpoint inventory required to prove absence');
        }else if(bodyUse(client)==='BODY_UNUSED'&&['TYPE_ASSERTION','INFERRED_TYPE'].includes(client.decoderKind)&&client.responseEffectsQualified===true&&!missing.length){
          status='NOT_APPLICABLE_TO_OBLIGATION';
        }else{
          if(client.responseEffectsQualified!==true)missing.push('Response decoder and interceptor effects require qualification');
          if(!before||!after)missing.push('Both endpoint revisions required');
          const rejectedOperation=consumers.map(consumer=>({consumer,failure:operationFailure(beforeBody,afterBody,consumer)})).find(entry=>entry.failure);
          if(!missing.length&&!rejectedOperation?.failure)conditionalFindings=consumers.map(consumer=>conditionalOperationFailure(beforeBody,afterBody,consumer)).filter((finding):finding is ConditionalOperationFinding=>!!finding);
          if(!missing.length&&rejectedOperation?.failure){
            status='BREAK_PROVED';witness=rejectedOperation.failure;consumers=[rejectedOperation.consumer];assumptions.push('Standard JavaScript primitive/array operations as declared; annotations are not runtime validation');
          }else{
          const expected=atPath(client.expectedResponse,path);
          if(!expected)missing.push(`Consumer expectation for changed path ${path} required`);
          if(before&&after&&expected){
            const accepted=client.decoderKind==='ZOD_STRICT'&&client.expectedResponse.kind==='OBJECT'?{...client.expectedResponse,strict:true}:client.expectedResponse;
            const issues=wireInclusion(afterBody??{kind:'PRIMITIVE',scalar:'void'},accepted).filter(i=>under(path,i.path));
            const oldIssues=wireInclusion(beforeBody??{kind:'PRIMITIVE',scalar:'void'},accepted).filter(i=>under(path,i.path));
            if(oldIssues.length&&issues.length)missing.push(`Base compatibility for ${path} is not established; separate pre-existing mismatch`);
            for(const issue of issues)if(issue.unresolved)missing.push(issue.reason);
            if(!missing.length){
              const issue=issues.find(i=>!i.unresolved);
              if(issue){
                if(['ZOD_STRICT','ZOD_DEFAULT','ZOD_PASSTHROUGH'].includes(client.decoderKind)){status='BREAK_PROVED';consumers=[{file:client.sourceFile,line:client.sourceLine,sourceSha256:client.sourceSha256,usage:'HTTP call has a qualified rejecting response decoder',propertyPath:issue.path}];witness={path:issue.path,reason:issue.reason,before:issue.before,after:issue.after};}
                else missing.push(`Unconditional consumer-path requirement or qualified runtime decoder required for ${issue.path}; annotations do not validate runtime values`);
              }
              else if(atPath(afterBody,path))status='COMPATIBILITY_PROVED_IN_SCOPE';
              else missing.push('Changed path absence needs a required consumer-path obligation');
            }
          }
          }
        }
        assessments.push({changeId,endpointId:key,obligationId,status,checkedScope:status==='EVIDENCE_REQUIRED'||status==='SOURCE_CONTRACT_INVALID'?[]:[status==='NOT_APPLICABLE_TO_OBLIGATION'?'body-use obligation only':path==='endpoint'?'endpoint existence':`declared ${ep.identity.direction==='REQUEST'?'request-body acceptance':'response'} obligation ${path}`],assumptions,evidenceIds,consumers,witness,...(conditionalFindings.length?{conditionalFindings}:{}),missingEvidence:[...new Set(missing)].sort()});
      }
    }
  }
  const consolidated:ScopedAssessment[]=[],uniform=new Map<string,number>();
  for(const assessment of assessments){
    if(assessment.status==='COMPATIBILITY_PROVED_IN_SCOPE'&&assessment.assumptions.some(value=>value.startsWith('Every captured candidate request handler admits'))){
      const endpoint=JSON.parse(assessment.endpointId).slice(0,4),key=canonicalJson([endpoint,assessment.consumers,assessment.checkedScope]),index=uniform.get(key);
      if(index!==undefined){const previous=consolidated[index];consolidated[index]={...previous,changeId:hash([previous.changeId,assessment.changeId]),obligationId:hash([previous.obligationId,assessment.obligationId]),evidenceIds:[...new Set([...previous.evidenceIds,...assessment.evidenceIds])],assumptions:[...new Set([...previous.assumptions,...assessment.assumptions])]};continue;}
      uniform.set(key,consolidated.length);consolidated.push({...assessment,endpointId:canonicalJson(endpoint)});
    }else consolidated.push(assessment);
  }
  return attachScopedEvidence(results(consolidated),[base,candidate,...targets],options.assessUnchanged?{mode:'INCLUDE_UNCHANGED_SOURCE_OBLIGATIONS_V1'}:undefined);
}
function results(assessments:ScopedAssessment[]):ScopedChangeResults{
  const grouped=new Map<string,string[]>();
  for(const item of assessments)for(const reason of item.missingEvidence){const ids=grouped.get(reason)??[];if(!ids.includes(item.obligationId))ids.push(item.obligationId);grouped.set(reason,ids);}
  return {version:'SAJIMORA_SCOPED_ASSESSMENTS_V1',assessments,coverage:{changedObligations:assessments.length,completed:assessments.filter(a=>a.status==='BREAK_PROVED'||a.status==='COMPATIBILITY_PROVED_IN_SCOPE').length,breaks:assessments.filter(a=>a.status==='BREAK_PROVED').length,pending:assessments.filter(a=>a.status==='EVIDENCE_REQUIRED').length},evidenceRequests:[...grouped].sort(([a],[b])=>a.localeCompare(b)).map(([reason,affectedObligations])=>({reason,affectedObligations}))};
}
