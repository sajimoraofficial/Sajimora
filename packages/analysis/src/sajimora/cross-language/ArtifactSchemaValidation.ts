/** Bounded, deep JSON validation before any artifact reaches comparison code. */
import {validateTypeGraph} from './RecursiveWireGraph';
type Obj = Record<string, unknown>;
const obj=(x:unknown):x is Obj=>typeof x==='object'&&x!==null&&!Array.isArray(x);
const str=(x:unknown):x is string=>typeof x==='string';
const strings=(x:unknown):x is string[]=>Array.isArray(x)&&x.every(str);
const bool=(x:unknown)=>typeof x==='boolean';
const line=(x:unknown)=>Number.isInteger(x)&&Number(x)>=0;
const nullableString=(x:unknown)=>x===null||str(x);
function provenance(x:unknown):boolean {return obj(x)&&['JAVA','TYPESCRIPT'].includes(String(x.language))&&str(x.file)&&line(x.line)&&(x.sha256===undefined||str(x.sha256));}
function constraints(x:unknown):boolean {return Array.isArray(x)&&x.every(c=>obj(c)&&['NOT_NULL','NOT_BLANK','NOT_EMPTY','SIZE','MIN','MAX','PATTERN','EMAIL'].includes(String(c.kind))&&(c.value===undefined||str(c.value)||typeof c.value==='number'));}
function callIdentity(x:unknown):boolean{return obj(x)&&x.version==='SAJIMORA_CALL_V1'&&str(x.file)&&str(x.sourceSha256)&&/^[0-9a-f]{64}$/.test(x.sourceSha256)&&line(x.startOffset)&&line(x.endOffset)&&Number(x.endOffset)>Number(x.startOffset)&&str(x.adapterKind)&&(x.snapshot===undefined||str(x.snapshot));}
function clientExtensions(x:Obj):boolean {
  if(obj(x.httpOptionsEvidence)&&x.httpOptionsEvidence.requestBodyAbsent!==undefined&&!bool(x.httpOptionsEvidence.requestBodyAbsent))return false;
  if(x.responseEffectAssumptions!==undefined&&!strings(x.responseEffectAssumptions))return false;
  if(x.requestEffectsQualified!==undefined&&!bool(x.requestEffectsQualified))return false;
  if(x.absentRequestBodyQualified!==undefined&&!bool(x.absentRequestBodyQualified))return false;
  if(x.queryParametersPreserved!==undefined&&!bool(x.queryParametersPreserved))return false;
  if(obj(x.httpOptionsEvidence)&&x.httpOptionsEvidence.queryParametersAbsent!==undefined&&!bool(x.httpOptionsEvidence.queryParametersAbsent))return false;
  if(x.requestTransport!==undefined){const t=x.requestTransport;if(!obj(t)||t.version!=='SAJIMORA_TRANSPORT_BODY_V1'||!['JSON','TEXT','BINARY','MULTIPART','FORM','ABSENT','UNRESOLVED'].includes(String(t.kind))||!nullableString(t.encoderId)||!['ENCODED_DOMAIN','SOURCE_CONTRACT_INVALID','EVIDENCE_REQUIRED'].includes(String(t.status))||!strings(t.missingEvidence)||!strings(t.assumptions)||(t.valueGraph!==undefined&&!validateTypeGraph(t.valueGraph))||!Array.isArray(t.sourceEvidence)||!t.sourceEvidence.every(e=>obj(e)&&str(e.file)&&str(e.sha256)&&/^[0-9a-f]{64}$/.test(e.sha256)))return false;}
  if(x.routeDomain!==undefined){const r=x.routeDomain;if(!obj(r)||r.version!=='SAJIMORA_ROUTE_DOMAIN_V1'||!bool(r.pathComplete)||!strings(r.missingEvidence)||!Array.isArray(r.alternatives)||r.alternatives.length>64||!r.alternatives.every(a=>obj(a)&&str(a.url)&&str(a.path)&&nullableString(a.host)&&Array.isArray(a.query)&&a.query.length<=512&&a.query.every(q=>obj(q)&&str(q.key)&&str(q.value)&&bool(q.repeated)))||!Array.isArray(r.sourceEvidence)||r.sourceEvidence.length>512||!r.sourceEvidence.every(s=>obj(s)&&str(s.file)&&str(s.sha256)&&/^[0-9a-f]{64}$/.test(s.sha256)))return false;}
  if(x.httpOptionsEvidence!==undefined){const e=x.httpOptionsEvidence;if(!obj(e)||e.version!=='SAJIMORA_HTTP_OPTIONS_EVIDENCE_V1'||!nullableString(e.observe)||!nullableString(e.responseType)||!bool(e.decoderOptionsComplete)||!strings(e.missingEvidence))return false;}
  if(x.responseProjections!==undefined&&(!Array.isArray(x.responseProjections)||x.responseProjections.length>32||!x.responseProjections.every(p=>obj(p)&&str(p.sourceFile)&&str(p.sourceSha256)&&/^[0-9a-f]{64}$/.test(p.sourceSha256)&&line(p.sourceLine)&&Array.isArray(p.fields)&&p.fields.length<=512&&new Set(p.fields.map(f=>obj(f)?f.output:null)).size===p.fields.length&&p.fields.every(f=>obj(f)&&str(f.output)&&strings(f.input)&&f.input.length>0&&f.input.length<=32))))return false;
  return true;
}
function wire(x:unknown,depth=0):boolean {
  if(depth>80||!obj(x)) return false;
  if(x.provenance!==undefined&&!provenance(x.provenance)) return false;
  switch(x.kind) {
    case 'PRIMITIVE':return ['string','number','boolean','bigint','void','any'].includes(String(x.scalar));
    case 'UNKNOWN':return str(x.reason);
    case 'LITERAL':return ['string','boolean','number'].includes(typeof x.value)&&(typeof x.value!=='number'||Number.isFinite(x.value));
    case 'ENUM':return Array.isArray(x.values)&&x.values.every(v=>str(v)||(typeof v==='number'&&Number.isFinite(v)));
    case 'NULLABLE':case 'OPTIONAL':return wire(x.innerType,depth+1);
    case 'ARRAY':return wire(x.elementType,depth+1)&&(x.tupleElements===undefined||(Array.isArray(x.tupleElements)&&x.tupleElements.every(t=>wire(t,depth+1))));
    case 'MAP':return wire(x.keyType,depth+1)&&wire(x.valueType,depth+1);
    case 'UNION':return Array.isArray(x.types)&&x.types.length>0&&x.types.every(t=>wire(t,depth+1));
    case 'OBJECT':return (x.strict===undefined||bool(x.strict))&&Array.isArray(x.properties)&&x.properties.length<=10000&&new Set(x.properties.map(p=>obj(p)?p.wireName:null)).size===x.properties.length&&x.properties.every(p=>obj(p)&&str(p.wireName)&&bool(p.optional)&&bool(p.nullable)&&constraints(p.validationConstraints)&&wire(p.type,depth+1));
    case 'REF':return str(x.ref);
    default:return false;
  }
}
function route(x:unknown):boolean {return obj(x)&&str(x.rawPath)&&Array.isArray(x.segments)&&x.segments.every(s=>obj(s)&&str(s.text)&&bool(s.isParam)&&(s.regexConstraint===undefined||str(s.regexConstraint)));}
function endpoint(x:unknown):boolean {return obj(x)&&(x.mappingConditions===undefined||obj(x.mappingConditions)&&strings(x.mappingConditions.params)&&bool(x.mappingConditions.complete))&&(x.responseStatuses===undefined||Array.isArray(x.responseStatuses)&&x.responseStatuses.every(s=>Number.isInteger(s)&&Number(s)>=100&&Number(s)<=599))&&(x.mediaTypes===undefined||strings(x.mediaTypes))&&obj(x.identity)&&nullableString(x.identity.service)&&str(x.identity.httpMethod)&&['REQUEST','RESPONSE'].includes(String(x.identity.direction))&&route(x.identity.normalizedRoute)&&provenance(x.provenance)&&(x.body===null||wire(x.body))&&['pathParameters','queryParameters','headers'].every(k=>Array.isArray(x[k])&&(x[k] as unknown[]).every(p=>obj(p)&&str(p.name)&&bool(p.required)&&wire(p.type)&&(p.validationConstraints===undefined||constraints(p.validationConstraints))));}
function client(x:unknown):boolean {return obj(x)&&clientExtensions(x)&&(x.callIdentity===undefined||callIdentity(x.callIdentity))&&(x.responseEffectsQualified===undefined||bool(x.responseEffectsQualified))&&(x.responseUsage===undefined||Array.isArray(x.responseUsage)&&x.responseUsage.every(c=>obj(c)&&str(c.file)&&line(c.line)&&str(c.usage)&&str(c.propertyPath)))&&str(x.httpMethod)&&str(x.normalizedRoute)&&str(x.sourceFile)&&line(x.sourceLine)&&(x.sourceSha256===undefined||str(x.sourceSha256))&&(x.consumerTraversalComplete===undefined||bool(x.consumerTraversalComplete))&&(x.targetServiceId===undefined||str(x.targetServiceId))&&(x.targetApiVersion===undefined||str(x.targetApiVersion))&&strings(x.unresolvedEvidence)&&['ZOD_STRICT','ZOD_DEFAULT','ZOD_PASSTHROUGH','TYPE_ASSERTION','INFERRED_TYPE','UNKNOWN'].includes(String(x.decoderKind))&&(x.requestBody===null||wire(x.requestBody))&&wire(x.expectedResponse)&&Array.isArray(x.consumers)&&x.consumers.every(c=>obj(c)&&str(c.file)&&line(c.line)&&str(c.usage));}
export function validateArtifactFields(x:unknown):boolean {
  if(!obj(x)||!obj(x.snapshot)||!obj(x.profile)||!obj(x.completeness)||!obj(x.payload))return false;
  const s=x.snapshot,p=x.profile,c=x.completeness;
  if(x.kind==='BACKEND_CONTRACT'&&x.payload.serializationAssumptions!==undefined&&!strings(x.payload.serializationAssumptions))return false;
  if(!['repositoryId','serviceId','parentCommit','candidateSnapshot'].every(k=>str(s[k])&&Boolean(s[k]))||!nullableString(s.apiVersion)||!str(p.toolVersion)||!nullableString(p.configFingerprint))return false;
  if(!['frameworkProfile','codecProfile','clientProfile'].every(k=>p[k]===undefined||str(p[k])))return false;
  if(!bool(c.complete)||!strings(c.unresolvedEndpoints)||!Array.isArray(c.blockers)||!c.blockers.every(b=>obj(b)&&str(b.code)&&str(b.message)))return false;
  if(x.integrity!==null&&(!obj(x.integrity)||!str(x.integrity.sha256)||!/^[0-9a-f]{64}$/.test(x.integrity.sha256)))return false;
  if(x.signature!==undefined&&!str(x.signature))return false;
  if(x.payload.type_pool!==undefined){if(!obj(x.payload.type_pool)||!Object.values(x.payload.type_pool).every(t=>wire(t)))return false;}
  if(x.payload.path_pool!==undefined){if(!Array.isArray(x.payload.path_pool)||!x.payload.path_pool.every(str))return false;}
  return x.kind==='BACKEND_CONTRACT'?strings(x.payload.baseUrls)&&strings(x.payload.proxyPrefixes)&&Array.isArray(x.payload.endpoints)&&x.payload.endpoints.length<=10000&&x.payload.endpoints.every(endpoint):Array.isArray(x.payload.clientContracts)&&x.payload.clientContracts.length<=10000&&x.payload.clientContracts.every(client);
}
