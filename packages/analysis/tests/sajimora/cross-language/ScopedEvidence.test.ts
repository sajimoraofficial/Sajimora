import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {bodyUse,proofGenerationKey,attachScopedEvidence} from '../../../src/sajimora/cross-language/ScopedEvidence';
import {ScopedEvidenceStore} from '../../../src/sajimora/cross-language/ScopedEvidenceStore';
import {assessBackendChanges,ScopedChangeResults} from '../../../src/sajimora/cross-language/ScopedChangeAssessment';
import {sealEnvelope,ContractArtifactEnvelope,FrontendClientContract,BackendContractPayload,FrontendContractPayload} from '../../../src/sajimora/cross-language/ContractArtifactEnvelope';
import {mkObjectWireType,mkPrimitiveWireType} from '../../../src/sajimora/cross-language/CanonicalContractIR';
import {normalizeRouteSegments} from '../../../src/sajimora/cross-language/EndpointIdentity';
import {ArtifactComparisonEngine} from '../../../src/sajimora/cross-language/ArtifactComparisonEngine';
import {renderCustomerScopedReport} from '../../../src/sajimora/cross-language/CustomerScopedReport';
import {serializeReport} from '../../../src/sajimora/cross-language/AgentImpactJson';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import * as ts from 'typescript';
import {deriveTransportBody} from '../../../src/sajimora/cross-language/TransportBody';
import {operationFailure} from '../../../src/sajimora/cross-language/ConsumerOperationObligations';

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const shape=(name:string)=>mkObjectWireType([{wireName:name,type:mkPrimitiveWireType('number'),optional:false,nullable:false,validationConstraints:[]}]);
function backend(revision:string,field:string,route='/x'):ContractArtifactEnvelope{return sealEnvelope({envelopeVersion:'SAJIMORA_CONTRACT_ARTIFACT_V1',reportSchemaVersion:'SAJIMORA_CROSS_LANGUAGE_IMPACT_V1',kind:'BACKEND_CONTRACT',snapshot:{repositoryId:'backend',serviceId:'api',apiVersion:'v1',parentCommit:'base',candidateSnapshot:revision},profile:{toolVersion:'test',configFingerprint:'same',frameworkProfile:'SPRING_MVC',codecProfile:'JACKSON_DEFAULT_V1'},completeness:{complete:false,unresolvedEndpoints:['unrelated missing typings'],blockers:[]},payload:{baseUrls:[],proxyPrefixes:[],endpoints:[{identity:{service:'api',httpMethod:'GET',direction:'RESPONSE',normalizedRoute:normalizeRouteSegments(route)},body:shape(field),pathParameters:[],headers:[],queryParameters:[],provenance:{language:'JAVA',file:'Dto.java',line:2,sha256:sha(revision)}}]}});}
const client:FrontendClientContract={httpMethod:'GET',normalizedRoute:'/x',targetServiceId:'api',targetApiVersion:'v1',sourceFile:'client.ts',sourceLine:3,sourceSha256:sha('client'),callIdentity:{version:'SAJIMORA_CALL_V1',file:'client.ts',sourceSha256:sha('client'),startOffset:10,endOffset:30,adapterKind:'ANGULAR'},requestBody:null,expectedResponse:shape('total'),decoderKind:'TYPE_ASSERTION',consumers:[{file:'view.ts',line:9,usage:'value.total.toFixed()',propertyPath:'$.total.toFixed',operation:'METHOD_CALL'}],responseUsage:[{file:'view.ts',line:9,usage:'value.total.toFixed()',propertyPath:'$.total.toFixed',operation:'METHOD_CALL'}],responseEffectsQualified:true,consumerTraversalComplete:true,unresolvedEvidence:[]};
function frontend(config='same'):ContractArtifactEnvelope{return sealEnvelope({envelopeVersion:'SAJIMORA_CONTRACT_ARTIFACT_V1',reportSchemaVersion:'SAJIMORA_CROSS_LANGUAGE_IMPACT_V1',kind:'FRONTEND_CONTRACT',snapshot:{repositoryId:'frontend',serviceId:'web',apiVersion:'v1',parentCommit:'base',candidateSnapshot:'consumer'},profile:{toolVersion:'test',clientProfile:'MULTI_CLIENT_V1',configFingerprint:config},completeness:{complete:false,unresolvedEndpoints:['unrelated import'],blockers:[]},payload:{clientContracts:[client]}});}
describe('spec 01 revision-bound scoped evidence',()=>{
  it('keeps Spring handler variants separate and excludes presence predicates only with closed query evidence',()=>{
    const variants=(envelope:ContractArtifactEnvelope)=>{const payload=envelope.payload as BackendContractPayload,ep=payload.endpoints[0];return sealEnvelope({...envelope,payload:{...payload,endpoints:[{...ep,mappingConditions:{params:[],complete:true}},{...ep,mappingConditions:{params:['pageSize','page'],complete:true},body:mkPrimitiveWireType('string')}]}});};
    const env=frontend(),captured=sealEnvelope({...env,payload:{clientContracts:[{...client,queryParametersPreserved:true,httpOptionsEvidence:{version:'SAJIMORA_HTTP_OPTIONS_EVIDENCE_V1',observe:'body',responseType:'json',decoderOptionsComplete:true,queryParametersAbsent:true,missingEvidence:[]},routeDomain:{version:'SAJIMORA_ROUTE_DOMAIN_V1',pathComplete:true,alternatives:[{url:'/x',path:'/x',host:null,query:[]}],missingEvidence:[],sourceEvidence:[]}}]}});
    const report=assessBackendChanges(variants(backend('base','total')),variants(backend('candidate','count')),[captured]);
    expect(report.coverage.breaks).toBe(1);
    expect(assessBackendChanges(variants(backend('base','total')),variants(backend('candidate','count')),[frontend()]).coverage.breaks).toBe(0);
    const symbolic=sealEnvelope({...captured,payload:{clientContracts:[{...(captured.payload as FrontendContractPayload).clientContracts[0],routeDomain:{version:'SAJIMORA_ROUTE_DOMAIN_V1',pathComplete:true,alternatives:[{url:'/x?ids=${value}',path:'/x',host:null,query:[{key:'ids',value:'${value}',repeated:false}]}],missingEvidence:['Dynamic query values may introduce keys'],sourceEvidence:[]}}]}});
    expect(assessBackendChanges(variants(backend('base','total')),variants(backend('candidate','count')),[symbolic]).coverage.breaks).toBe(0);
  });
  it('qualifies preserved absent request bodies without qualifying query acceptance or nonempty bodies',()=>{
    const requestBackend=(revision:string,body:BackendContractPayload['endpoints'][number]['body'])=>{const env=backend(revision,'total');const payload=env.payload as BackendContractPayload;return sealEnvelope({...env,payload:{...payload,endpoints:payload.endpoints.map(ep=>({...ep,identity:{...ep.identity,direction:'REQUEST' as const},body}))}});};
    const absentOptions={version:'SAJIMORA_HTTP_OPTIONS_EVIDENCE_V1' as const,observe:'body',responseType:'json',decoderOptionsComplete:true,requestBodyAbsent:true,missingEvidence:[]};
    const env=frontend(),empty=sealEnvelope({...env,payload:{clientContracts:[{...client,requestTransport:deriveTransportBody(undefined),requestEffectsQualified:false,absentRequestBodyQualified:true,httpOptionsEvidence:absentOptions}]}});
    const report=assessBackendChanges(requestBackend('base',null),requestBackend('candidate',null),[empty],{assessUnchanged:true});
    expect(report.coverage.completed).toBe(1);
    expect(report.assessments[0].assumptions.some(a=>a.includes('query values, headers'))).toBe(true);
    const duplicated=(envelope:ContractArtifactEnvelope,otherBody:BackendContractPayload['endpoints'][number]['body'])=>{const payload=envelope.payload as BackendContractPayload;return sealEnvelope({...envelope,payload:{...payload,endpoints:[...payload.endpoints,{...payload.endpoints[0],mappingConditions:{params:['page'],complete:true},body:otherBody}]}});};
    const uniform=assessBackendChanges(duplicated(requestBackend('base',null),null),duplicated(requestBackend('candidate',null),null),[empty],{assessUnchanged:true});
    expect(uniform.coverage.completed).toBe(1);
    expect(uniform.assessments.every(a=>a.assumptions.some(value=>value.includes('does not establish query-based handler selection')))).toBe(true);
    const requiresBody=assessBackendChanges(duplicated(requestBackend('base',null),null),duplicated(requestBackend('candidate',null),shape('total')),[empty],{assessUnchanged:true});
    expect(requiresBody.coverage.completed).toBe(0);
    const sf=ts.createSourceFile('client.ts','JSON.stringify({id:1});',ts.ScriptTarget.Latest,true);
    const nonempty=sealEnvelope({...env,payload:{clientContracts:[{...client,requestTransport:deriveTransportBody((sf.statements[0] as ts.ExpressionStatement).expression),requestEffectsQualified:false,absentRequestBodyQualified:true,httpOptionsEvidence:absentOptions}]}});
    expect(assessBackendChanges(requestBackend('base',null),requestBackend('candidate',null),[nonempty],{assessUnchanged:true}).coverage.completed).toBe(0);
  });
  it('proves native array push failure while retaining unknown receivers and guarded reachability',()=>{
    const before={kind:'ARRAY' as const,elementType:mkPrimitiveWireType('string')},after={kind:'MAP' as const,keyType:mkPrimitiveWireType('string'),valueType:mkPrimitiveWireType('string')};
    const use={file:'service.ts',line:272,usage:'values.push(value)',propertyPath:'$.push',operation:'METHOD_CALL' as const};
    expect(operationFailure(before,after,use)?.reason).toContain('push()');
    expect(operationFailure(before,{kind:'UNKNOWN',reason:'opaque producer'},use)).toBeUndefined();
    expect(operationFailure({kind:'UNKNOWN',reason:'opaque baseline'},after,use)).toBeUndefined();
    expect(operationFailure(before,after,{...use,guards:['Unqualified branch']})).toBeUndefined();
  });
  it('scopes unrelated duplicate routes and excludes impossible wildcard owners without ignoring genuine overlaps',()=>{
    const addRoutes=(envelope:ContractArtifactEnvelope,routes:string[])=>{const payload=envelope.payload as BackendContractPayload;return sealEnvelope({...envelope,payload:{...payload,endpoints:[...payload.endpoints,...routes.map(route=>({...payload.endpoints[0],identity:{...payload.endpoints[0].identity,normalizedRoute:normalizeRouteSegments(route)}}))]}});};
    const isolated=['/other','/other','/apiTrendz/**','/{path:^(?!x$)[^\\.]*}/**'];
    const report=assessBackendChanges(addRoutes(backend('base','total'),isolated),addRoutes(backend('candidate','count'),isolated),[frontend()]);
    expect(report.assessments.some(a=>a.status==='BREAK_PROVED'&&a.witness?.path==='$.total')).toBe(true);
    for(const overlapping of ['/**','/{path}/**','/{path:^(?!x$)[^.]*|x}/**','/x']){
      const ambiguous=assessBackendChanges(addRoutes(backend('base','total'),[overlapping]),addRoutes(backend('candidate','count'),[overlapping]),[frontend()]);
      expect(ambiguous.coverage.breaks).toBe(0);
    }
  });
  it('reports a seeded required request-field break with its actual caller',()=>{
    const requestBackend=(revision:string,required:boolean)=>{const env=backend(revision,'total');const payload=env.payload as BackendContractPayload;return sealEnvelope({...env,payload:{...payload,endpoints:payload.endpoints.map(ep=>({...ep,identity:{...ep.identity,direction:'REQUEST' as const},body:mkObjectWireType([{wireName:'id',type:mkPrimitiveWireType('number'),optional:false,nullable:false,validationConstraints:[]},...(required?[{wireName:'token',type:mkPrimitiveWireType('string'),optional:false,nullable:false,validationConstraints:[]}]:[])]),provenance:{...ep.provenance,sha256:sha(revision)}}))}});};
    const sf=ts.createSourceFile('client.ts','JSON.stringify({id:1});',ts.ScriptTarget.Latest,true),requestTransport=deriveTransportBody((sf.statements[0] as ts.ExpressionStatement).expression);
    const env=frontend(),consumer=sealEnvelope({...env,payload:{clientContracts:[{...client,requestTransport,requestEffectsQualified:true}]}});
    const validated=(envelope:ContractArtifactEnvelope)=>sealEnvelope({...envelope,payload:{...(envelope.payload as BackendContractPayload),endpoints:(envelope.payload as BackendContractPayload).endpoints.map(endpoint=>({...endpoint,body:endpoint.body?.kind==='OBJECT'?{...endpoint.body,properties:endpoint.body.properties.map(property=>({...property,validationConstraints:[{kind:'NOT_NULL' as const}]}))}:endpoint.body}))}});
    const report=assessBackendChanges(validated(requestBackend('base',false)),validated(requestBackend('candidate',true)),[consumer]);
    expect(report.coverage.breaks).toBe(1);expect(report.assessments[0]).toMatchObject({status:'BREAK_PROVED',witness:{path:'$.token'},consumers:[{file:'client.ts',line:3}]});
    const safe=assessBackendChanges(requestBackend('base',true),requestBackend('candidate',false),[consumer]);expect(safe.coverage.breaks).toBe(0);
    const unknown=sealEnvelope({...env,payload:{clientContracts:[{...client,requestTransport,requestEffectsQualified:false}]}});expect(assessBackendChanges(requestBackend('base',false),requestBackend('candidate',true),[unknown]).coverage.breaks).toBe(0);
  });
  it('keeps a consumed-field break and both producer revisions despite unrelated gaps',()=>{
    const report=assessBackendChanges(backend('base','total'),backend('candidate','count'),[frontend()]);
    const finding=report.assessments.find(a=>a.status==='BREAK_PROVED')!;
    expect(finding.witness?.path).toBe('$.total');
    expect(finding.consumers[0].file).toBe('view.ts');
    const records=report.evidenceRecords!.filter(e=>finding.evidenceIds.includes(e.id));
    expect(records.some(e=>e.revision==='base'&&e.sourceHash===sha('base'))).toBe(true);
    expect(records.some(e=>e.revision==='candidate'&&e.sourceHash===sha('candidate'))).toBe(true);
    expect(records.some(e=>e.origin==='USAGE_OBLIGATION'&&e.assumptions.some(s=>s.includes('not runtime validation')))).toBe(true);
    expect(report.coverage.pending).toBeGreaterThan(0);
    const original=backend('base','total');
    const opaqueBase=sealEnvelope({...original,completeness:{...original.completeness,blockers:[{code:'UNRESOLVED_JACKSON_CONFIG',message:'Opaque base codec'}]}});
    expect(assessBackendChanges(opaqueBase,backend('candidate','count'),[frontend()]).coverage.breaks).toBe(0);
  });
  it('does not treat an absent usage inventory or an escape as unused body',()=>{
    expect(bodyUse({...client,responseUsage:[]})).toBe('BODY_UNUSED');
    expect(bodyUse({...client,responseUsage:[],consumerTraversalComplete:false})).toBe('BODY_ESCAPES');
    expect(bodyUse({...client,responseUsage:undefined})).toBe('BODY_ESCAPES');
    expect(bodyUse(client)).toBe('BODY_CONSTRAINED');
  });
  it('keeps assertion-only and bare property reads outside confirmed runtime breaks',()=>{
    const env=frontend(),usage={file:'view.ts',line:9,usage:'value.total',propertyPath:'$.total',operation:'PROPERTY_READ' as const};
    const target=sealEnvelope({...env,payload:{clientContracts:[{...client,consumers:[usage],responseUsage:[usage]}]}});
    expect(assessBackendChanges(backend('base','total'),backend('candidate','count'),[target]).coverage.breaks).toBe(0);
  });
  it('invalidates proof keys on consumer configuration and revision changes',()=>{
    const artifacts=[backend('base','total'),backend('candidate','count'),frontend()];
    expect(proofGenerationKey(artifacts)).not.toBe(proofGenerationKey([...artifacts.slice(0,2),frontend('changed')]));
    expect(proofGenerationKey(artifacts)).not.toBe(proofGenerationKey([backend('new-base','total'),...artifacts.slice(1)]));
  });
  it('can explicitly assess an unchanged control without reusing the changes-only proof key',()=>{
    const before=backend('base','total'),after=backend('candidate','total'),consumer=frontend();
    const changes=assessBackendChanges(before,after,[consumer]),control=assessBackendChanges(before,after,[consumer],{assessUnchanged:true});
    expect(changes.assessments).toHaveLength(0);expect(control.coverage.completed).toBe(1);expect(control.coverage.breaks).toBe(0);expect(control.proofKey).not.toBe(changes.proofKey);
    expect(control.assessments[0].status).toBe('COMPATIBILITY_PROVED_IN_SCOPE');
  });
  it('keeps identical call bytes in different consumer revisions distinct',()=>{
    const current=frontend(),historical=sealEnvelope({...current,snapshot:{...current.snapshot,candidateSnapshot:'older-consumer'}});
    const report=assessBackendChanges(backend('base','total'),backend('candidate','count'),[current,historical]);
    expect(new Set(report.assessments.map(a=>a.obligationId)).size).toBe(report.assessments.length);
    expect(report.coverage.breaks).toBe(2);
  });
  it('keeps overlapping endpoint ownership pending',()=>{
    const base=backend('base','total','/{id}'),candidate=backend('candidate','count','/{id}');
    const duplicate=(env:ContractArtifactEnvelope)=>sealEnvelope({...env,payload:{...(env.payload as BackendContractPayload),endpoints:[...(env.payload as BackendContractPayload).endpoints,{...(env.payload as BackendContractPayload).endpoints[0],identity:{...(env.payload as BackendContractPayload).endpoints[0].identity,normalizedRoute:normalizeRouteSegments('/{other}')}}]}});
    const target=frontend();
    const report=assessBackendChanges(duplicate(base),duplicate(candidate),[sealEnvelope({...target,payload:{clientContracts:[{...client,normalizedRoute:'/{x}'}]}})]);
    expect(report.coverage.breaks).toBe(0);
    expect(report.evidenceRequests.some(r=>r.reason.includes('Multiple candidate endpoint owners'))).toBe(true);
  });
  it('maps all finite route alternatives to one owner without choosing a convenient branch',()=>{
    const env=frontend(),routeDomain={version:'SAJIMORA_ROUTE_DOMAIN_V1' as const,pathComplete:true,missingEvidence:[],sourceEvidence:[],alternatives:['/a','/b'].map(path=>({url:path,path,host:null,query:[]}))};
    const target=sealEnvelope({...env,payload:{clientContracts:[{...client,normalizedRoute:'<dynamic>',routeDomain}]}});
    expect(assessBackendChanges(backend('base','total','/{id}'),backend('candidate','count','/{id}'),[target]).coverage.breaks).toBe(1);
    const partial=sealEnvelope({...env,payload:{clientContracts:[{...client,normalizedRoute:'<dynamic>',routeDomain:{...routeDomain,alternatives:[...routeDomain.alternatives,{url:'/other/x',path:'/other/x',host:null,query:[]}]}}]}});
    const report=assessBackendChanges(backend('base','total','/{id}'),backend('candidate','count','/{id}'),[partial]);expect(report.coverage.breaks).toBe(0);expect(report.evidenceRequests.some(request=>request.reason.includes('branch-specific'))).toBe(true);
  });
  it('groups missing evidence with unique obligations and affected APIs',()=>{
    const artifacts=[backend('base','total'),backend('candidate','count'),frontend()];
    const empty:ScopedChangeResults={version:'SAJIMORA_SCOPED_ASSESSMENTS_V1',assessments:[{changeId:'c',endpointId:'GET /x',obligationId:'o',status:'EVIDENCE_REQUIRED',checkedScope:[],assumptions:[],evidenceIds:[],consumers:client.consumers,missingEvidence:['exact declaration']}],coverage:{completed:0,breaks:0,pending:1,changedObligations:1},evidenceRequests:[{reason:'exact declaration',affectedObligations:['o','o']}]};
    const report=attachScopedEvidence(empty,artifacts);
    expect(report.evidenceRequests[0].affectedObligations).toEqual(['o']);
    expect(report.evidenceRequests[0].affectedEndpoints).toEqual(['GET /x']);
    expect(report.evidenceRequests[0].affectedConsumers).toHaveLength(1);
  });
  it('discharges only unused-body use and still assesses a changed response status',()=>{
    const before=backend('base','total'),after=backend('candidate','count');
    const statuses=(env:ContractArtifactEnvelope,status:number)=>sealEnvelope({...env,payload:{...(env.payload as BackendContractPayload),endpoints:(env.payload as BackendContractPayload).endpoints.map(ep=>({...ep,responseStatuses:[status]}))}});
    const consumer=frontend(),unused=sealEnvelope({...consumer,payload:{clientContracts:[{...client,responseUsage:[]}]}});
    const report=assessBackendChanges(statuses(before,200),statuses(after,204),[unused]);
    expect(report.assessments.some(a=>a.status==='NOT_APPLICABLE_TO_OBLIGATION'&&a.checkedScope[0]==='body-use obligation only')).toBe(true);
    expect(report.assessments.some(a=>a.status==='EVIDENCE_REQUIRED'&&a.missingEvidence.some(m=>m.includes('transport:responseStatuses')))).toBe(true);
    expect(report.assessments.some(a=>a.status==='COMPATIBILITY_PROVED_IN_SCOPE')).toBe(false);
  });
  it('does not omit a newly required query parameter when body is unchanged',()=>{
    const before=backend('base','total'),candidate=backend('candidate','total');
    const after=sealEnvelope({...candidate,payload:{...(candidate.payload as BackendContractPayload),endpoints:(candidate.payload as BackendContractPayload).endpoints.map(ep=>({...ep,queryParameters:[{name:'mode',required:true,type:mkPrimitiveWireType('string')}]}))}});
    const report=assessBackendChanges(before,after,[frontend()]);
    expect(report.coverage.changedObligations).toBe(1);
    expect(report.evidenceRequests[0].reason).toContain('queryParameters:mode');
    expect(report.coverage.completed).toBe(0);
  });
  it('proves an omitted newly required query parameter only with complete request effects and URL facts',()=>{
    const before=backend('base','total'),env=backend('candidate','total'),after=sealEnvelope({...env,payload:{...(env.payload as BackendContractPayload),endpoints:(env.payload as BackendContractPayload).endpoints.map(endpoint=>({...endpoint,queryParameters:[{name:'mode',required:true,type:mkPrimitiveWireType('string')}]}))}});
    const source=frontend(),routeDomain={version:'SAJIMORA_ROUTE_DOMAIN_V1' as const,pathComplete:true,missingEvidence:[],sourceEvidence:[],alternatives:[{url:'/x',path:'/x',host:null,query:[]}]};
    const target=(qualified:boolean)=>sealEnvelope({...source,payload:{clientContracts:[{...client,routeDomain,requestEffectsQualified:qualified}]}});
    const report=assessBackendChanges(before,after,[target(true)]);expect(report.coverage.breaks).toBe(1);expect(report.assessments[0]).toMatchObject({witness:{path:'queryParameters:mode'},consumers:[{file:'client.ts',line:3}]});
    expect(assessBackendChanges(before,after,[target(false)]).coverage.breaks).toBe(0);
  });
  it('publishes atomic scoped generations and preserves previous proof on cancellation',()=>{
    const store=new ScopedEvidenceStore(':memory:');
    try{
      const report=assessBackendChanges(backend('base','total'),backend('candidate','count'),[frontend()]);
      store.publish(report);
      expect(store.read(report.proofKey!)?.coverage).toEqual(report.coverage);
      const controller=new AbortController();controller.abort();
      expect(()=>store.publish(assessBackendChanges(backend('base','total'),backend('next','other'),[frontend()]),controller.signal)).toThrow('cancelled');
      expect(store.read(report.proofKey!)?.assessments.some(a=>a.status==='BREAK_PROVED')).toBe(true);
      expect(()=>store.publish({...report,evidenceRecords:[]})).toThrow('Dangling');
      store.updateJob('job',report.proofKey!,'CANCELLED',{completed:1,total:2,message:'Cancelled by caller'});
      expect(store.jobs()[0].state).toBe('CANCELLED');
    }finally{store.close();}
  });
  it('shows a customer witness and grouped actions without promoting partial scope',()=>{
    const report=new ArtifactComparisonEngine({requireServiceMapping:true}).compare(backend('base','total'),backend('candidate','count'),[frontend()]);
    const view=renderCustomerScopedReport(report);
    expect(view).toContain('Confirmed break: $.total');
    expect(view).toContain('Affected consumer: view.ts:9 reads $.total');
    expect(view).toContain('Evidence needed:');
    expect(view).toContain('not observed runtime payloads');
    expect(report.verdict).not.toBe('LIKELY_PRESERVED');
    expect(JSON.parse(serializeReport(report)).verdict).toBe(report.verdict);
    const control=new ArtifactComparisonEngine({requireServiceMapping:true,assessUnchanged:true}).compare(backend('base','total'),backend('base','total'),[frontend()]);
    const controlView=renderCustomerScopedReport({...control,verdict:'LIKELY_VIOLATED'});
    expect(controlView).toContain('0 confirmed source-contract breaks');expect(controlView).toContain('No breaking change in checked scope');
    expect(controlView).not.toContain('Analysis verdict: LIKELY_VIOLATED');
  });
  it('rejects a missing proof row even when evidence and obligation rows remain intact',()=>{
    mkdirSync(resolve('scratch'),{recursive:true});const directory=mkdtempSync(resolve('scratch/spec01-proof-integrity-')),file=join(directory,'evidence.sqlite');
    const report=assessBackendChanges(backend('base','total'),backend('candidate','count'),[frontend()]);const store=new ScopedEvidenceStore(file);
    try{store.publish(report);const {DatabaseSync}=createRequire(resolve('package.json'))('node:sqlite');const database=new DatabaseSync(file);try{database.prepare('DELETE FROM scoped_proofs WHERE proof_key=?').run(report.proofKey!);}finally{database.close();}expect(()=>store.read(report.proofKey!)).toThrow('proof inventory integrity');}finally{store.close();}
  });
  it('runs the customer CLI and persists its sanitized proof generation',()=>{
    const root=resolve('scratch');mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,'spec01-cli-'));
    const artifacts=[backend('base','total'),backend('candidate','count'),frontend()];
    const paths=artifacts.map((a,i)=>{const file=join(directory,i+'.json');writeFileSync(file,JSON.stringify(a));return file;});
    const output=join(directory,'customer.txt'),dbPath=join(directory,'evidence.sqlite');
    const run=spawnSync(process.execPath,['scripts/test-runtime/run-tsx-command.cjs','scripts/sajimora/checkContract.ts','--base',paths[0],'--candidate',paths[1],'--target',paths[2],'--trusted-local','--format','customer','--evidence-db',dbPath,'--out',output],{encoding:'utf8',timeout:20000});
    expect(run.status,run.stderr).toBe(0);
    expect(readFileSync(output,'utf8')).toContain('Confirmed break: $.total');
    const store=new ScopedEvidenceStore(dbPath);
    try{expect(store.read(proofGenerationKey(artifacts))?.coverage.breaks).toBe(1);}finally{store.close();}
  },30000);
});
