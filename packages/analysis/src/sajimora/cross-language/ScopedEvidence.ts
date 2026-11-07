import {createHash} from 'node:crypto';
import {canonicalJson,ContractArtifactEnvelope,BackendContractPayload,FrontendContractPayload,FrontendClientContract} from './ContractArtifactEnvelope';
import type {ScopedChangeResults} from './ScopedChangeAssessment';

export type AssessmentStatus='BREAK_PROVED'|'COMPATIBILITY_PROVED_IN_SCOPE'|'OBSERVED_FAILURE'|'CHECK_PENDING'|'EVIDENCE_REQUIRED'|'SOURCE_CONTRACT_INVALID'|'NOT_APPLICABLE_TO_OBLIGATION';
export interface EvidenceRecord {
  readonly id:string;
  readonly revision:string;
  readonly repositoryId:string;
  readonly sourceHash:string;
  readonly location:{file:string;line?:number};
  readonly origin:'SOURCE_DECLARATION'|'ENCODER_SUMMARY'|'USAGE_OBLIGATION'|'EXPLICIT_SCHEMA'|'OBSERVED_PAYLOAD';
  readonly assumptions:readonly string[];
  readonly proofScope:readonly string[];
  readonly dependencies:readonly string[];
}
export type BodyUse='BODY_UNUSED'|'BODY_CONSTRAINED'|'BODY_ESCAPES';
export function bodyUse(client:FrontendClientContract):BodyUse {
  if(client.consumerTraversalComplete!==true)return 'BODY_ESCAPES';
  // Missing usage inventory in legacy artifacts does not prove absence of reads.
  if(client.responseUsage===undefined)return 'BODY_ESCAPES';
  return client.responseUsage.length?'BODY_CONSTRAINED':'BODY_UNUSED';
}
export const evidenceHash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export function proofGenerationKey(artifacts:readonly ContractArtifactEnvelope[],context?:unknown):string {
  const identities=artifacts.map(a=>({snapshot:a.snapshot,profile:a.profile,integrity:a.integrity?.sha256,
    dependencies:a.kind==='FRONTEND_CONTRACT'?(a.payload as FrontendContractPayload).dependencyContext??null:null}));
  return evidenceHash(context===undefined?identities:{identities,context});
}
/** Attach facts from each immutable artifact independently. A hash shared by two
 * revisions is not collapsed into a claim about a different revision. */
export function attachScopedEvidence(result:ScopedChangeResults,artifacts:readonly ContractArtifactEnvelope[],context?:unknown):ScopedChangeResults {
  const records=new Map<string,EvidenceRecord>();
  const byHash=new Map<string,string[]>();
  const add=(artifact:ContractArtifactEnvelope,sourceHash:string|undefined,location:EvidenceRecord['location'],origin:EvidenceRecord['origin'],proofScope:readonly string[],assumptions:readonly string[]=[])=>{
    if(!sourceHash||!/^[0-9a-f]{64}$/.test(sourceHash))return;
    const record={revision:artifact.snapshot.candidateSnapshot,repositoryId:artifact.snapshot.repositoryId,sourceHash,location,origin,assumptions,proofScope,dependencies:[evidenceHash(artifact.profile),...(artifact.kind==='FRONTEND_CONTRACT'?[evidenceHash((artifact.payload as FrontendContractPayload).dependencyContext??null)]:[])]};
    const id=evidenceHash(record);records.set(id,{id,...record});
    const ids=byHash.get(sourceHash)??[];if(!ids.includes(id))ids.push(id);byHash.set(sourceHash,ids);
  };
  for(const artifact of artifacts){
    add(artifact,artifact.integrity?.sha256,{file:'<artifact-manifest>'},'SOURCE_DECLARATION',['captured contract inventory'],['Artifact authenticity is governed by its admission policy']);
    if(artifact.kind==='BACKEND_CONTRACT')for(const endpoint of (artifact.payload as BackendContractPayload).endpoints){
      add(artifact,endpoint.provenance.sha256,{file:endpoint.provenance.file,line:endpoint.provenance.line},'SOURCE_DECLARATION',[endpoint.identity.httpMethod+' '+endpoint.identity.normalizedRoute.rawPath,endpoint.identity.direction],['Source declaration does not establish runtime implementation conformance']);
    }else for(const client of (artifact.payload as FrontendContractPayload).clientContracts){
      add(artifact,client.sourceSha256,{file:client.sourceFile,line:client.sourceLine},'USAGE_OBLIGATION',[client.httpMethod+' '+client.normalizedRoute,bodyUse(client)],['Consumer annotation is an expectation, not runtime validation']);
      for(const consumer of client.responseUsage??[])add(artifact,consumer.sourceSha256,{file:consumer.file,line:consumer.line},'USAGE_OBLIGATION',[consumer.propertyPath??'response escape'],['Source-visible consumer requirement']);
      for(const helper of client.httpOptionsEvidence?.sourceEvidence??[])add(artifact,helper.sha256,{file:helper.file},'ENCODER_SUMMARY',['bounded HTTP options summary']);
      for(const source of client.routeDomain?.sourceEvidence??[])add(artifact,source.sha256,{file:source.file},'SOURCE_DECLARATION',['bounded route domain']);
      for(const source of client.requestTransport?.sourceEvidence??[])add(artifact,source.sha256,{file:source.file},'ENCODER_SUMMARY',['actual request value and '+client.requestTransport?.kind+' encoder'],client.requestTransport?.assumptions??[]);
      for(const projection of client.responseProjections??[])add(artifact,projection.sourceSha256,{file:projection.sourceFile,line:projection.sourceLine},'ENCODER_SUMMARY',['supported response projection']);
    }
  }
  const assessments=result.assessments.map(a=>({...a,evidenceIds:[...new Set([...a.evidenceIds,...a.consumers.map(c=>c.sourceSha256).filter((s):s is string=>!!s)].flatMap(id=>byHash.get(id)??[]))].sort()}));
  const referenced=new Set(assessments.flatMap(a=>a.evidenceIds));
  return {...result,assessments,evidenceVersion:'SAJIMORA_SCOPED_EVIDENCE_V1',proofKey:proofGenerationKey(artifacts,context),
    evidenceRecords:[...records.values()].filter(r=>referenced.has(r.id)).sort((a,b)=>a.id.localeCompare(b.id)),
    evidenceRequests:result.evidenceRequests.map(request=>({...request,
      affectedObligations:[...new Set(request.affectedObligations)].sort(),
      affectedEndpoints:[...new Set(assessments.filter(a=>request.affectedObligations.includes(a.obligationId)).map(a=>a.endpointId))].sort(),
      affectedConsumers:[...new Map(assessments.filter(a=>request.affectedObligations.includes(a.obligationId)).flatMap(a=>a.consumers).map(c=>[evidenceHash([c.file,c.line,c.propertyPath??null]),c])).values()]
    }))};
}
