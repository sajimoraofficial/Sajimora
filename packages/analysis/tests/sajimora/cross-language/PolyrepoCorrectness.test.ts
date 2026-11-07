import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { wireInclusion, propertyType } from '../../../src/sajimora/cross-language/WireInclusion';
import { admitArtifact } from '../../../src/sajimora/cross-language/ArtifactAdmission';
import { sealEnvelope, parseEnvelope } from '../../../src/sajimora/cross-language/ContractArtifactEnvelope';
import { TypeScriptContractParser } from '../../../src/sajimora/cross-language/TypeScriptContractParser';
import { ArtifactComparisonEngine } from '../../../src/sajimora/cross-language/ArtifactComparisonEngine';
import { normalizeRouteSegments } from '../../../src/sajimora/cross-language/EndpointIdentity';
import type { WireType } from '../../../src/sajimora/cross-language/CanonicalContractIR';
const str: WireType = {kind:'PRIMITIVE',scalar:'string'};
const num: WireType = {kind:'PRIMITIVE',scalar:'number'};
const draft = () => sealEnvelope({envelopeVersion:'SAJIMORA_CONTRACT_ARTIFACT_V1',reportSchemaVersion:'SAJIMORA_CROSS_LANGUAGE_IMPACT_V1',kind:'BACKEND_CONTRACT',snapshot:{repositoryId:'backend',serviceId:'api',apiVersion:'v1',parentCommit:'a',candidateSnapshot:'b'},profile:{toolVersion:'1',frameworkProfile:'SPRING_MVC',codecProfile:'JACKSON_DEFAULT_V1',configFingerprint:null},completeness:{complete:true,unresolvedEndpoints:[],blockers:[]},payload:{baseUrls:[],proxyPrefixes:[],endpoints:[]}});
describe('polyrepo correctness regressions',()=>{
  const endpoint=(route:string)=>({identity:{service:'api',httpMethod:'GET',normalizedRoute:normalizeRouteSegments(route),direction:'RESPONSE' as const},pathParameters:[],queryParameters:[],headers:[],body:str,provenance:{language:'JAVA' as const,file:'Controller.java',line:1}});
  const backend=(route?:string)=>sealEnvelope({...draft(),payload:{baseUrls:[],proxyPrefixes:[],endpoints:route?[endpoint(route)]:[]}});
  const frontend=(extra:Record<string,unknown>={})=>sealEnvelope({...draft(),kind:'FRONTEND_CONTRACT',snapshot:{...draft().snapshot,repositoryId:'frontend',serviceId:'web'},payload:{clientContracts:[{httpMethod:'GET',normalizedRoute:'/users/${id}',requestBody:null,expectedResponse:str,decoderKind:'INFERRED_TYPE',consumers:[],unresolvedEvidence:[],sourceFile:'api.ts',sourceLine:1,targetServiceId:'api',consumerTraversalComplete:true,...extra}]}} as any);
  it('does not treat a path parameter rename as endpoint deletion',()=>{
    expect(new ArtifactComparisonEngine({requireServiceMapping:true}).compare(backend('/users/{id}'),backend('/users/{userId}'),[frontend()]).verdict).toBe('LIKELY_PRESERVED');
  });
  it('does not infer deletion in an empty inventory without a service mapping',()=>{
    const e=frontend({targetServiceId:undefined});
    const r=new ArtifactComparisonEngine({requireServiceMapping:true}).compare(e,e,[backend()]);
    expect(r.verdict).toBe('INCONCLUSIVE');expect(r.findings).toHaveLength(0);
  });
  it('keeps definite violations when coverage is incomplete',()=>{
    const e=frontend({expectedResponse:num,consumerTraversalComplete:false});
    expect(new ArtifactComparisonEngine({requireServiceMapping:true}).compare(backend('/users/{id}'),backend('/users/{id}'),[e]).verdict).toBe('LIKELY_VIOLATED');
  });
  it('accepts primitive widening and split enum union coverage',()=>{
    expect(wireInclusion(str,{kind:'UNION',types:[str,num]})).toEqual([]);
    expect(wireInclusion({kind:'ENUM',values:['A','B']},{kind:'UNION',types:[{kind:'LITERAL',value:'A'},{kind:'LITERAL',value:'B'}]})).toEqual([]);
  });
  it('keeps unknown facts unresolved',()=>{
    expect(wireInclusion({kind:'UNKNOWN',reason:'dynamic'},str)[0].unresolved).toBe(true);
  });
  it('normalizes metadata and preserves null and omission through unions',()=>{
    const p=propertyType({wireName:'x',type:str,nullable:true,optional:true,validationConstraints:[]});
    expect(wireInclusion(p,{kind:'OPTIONAL',innerType:{kind:'NULLABLE',innerType:{kind:'UNION',types:[str,num]}}})).toEqual([]);
    expect(wireInclusion(p,str).length).toBe(2);
  });
  it('checks map keys as well as values',()=>{
    expect(wireInclusion({kind:'MAP',keyType:num,valueType:str},{kind:'MAP',keyType:str,valueType:str})).toHaveLength(1);
  });
  it('rejects malformed nested payload despite a valid seal',()=>{
    const e=draft(); const malformed=sealEnvelope({...e,payload:{baseUrls:[],proxyPrefixes:[],endpoints:[{body:{kind:'ARRAY'}}]} as any});
    expect(()=>parseEnvelope(JSON.stringify(malformed))).toThrow();
  });
  it('requires authorized producer and exact trusted digest',()=>{
    const e=draft(); expect(()=>admitArtifact(e,{requireSignatures:false,producers:[]})).toThrow();
    expect(()=>admitArtifact(e,{producers:[{repositoryId:'backend',serviceId:'api',trustedDigests:[e.integrity!.sha256]}]} as any)).toThrow('requireSignatures must be explicitly specified');
    expect(()=>admitArtifact(e,{requireSignatures:false,producers:[{repositoryId:'backend',serviceId:'api',trustedDigests:[e.integrity!.sha256]}]})).not.toThrow();
    expect(()=>admitArtifact(e,{requireSignatures:true,producers:[{repositoryId:'backend',serviceId:'api',trustedDigests:[e.integrity!.sha256]}]})).toThrow();
  });
  it('verifies producer signatures and rejects invalid ones',()=>{
    const e=draft(); const keys=generateKeyPairSync('ed25519');
    const policy={requireSignatures:true,producers:[{repositoryId:'backend',serviceId:'api',publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}).toString()}]};
    const signed={...e,signature:sign(null,Buffer.from(e.integrity!.sha256,'utf8'),keys.privateKey).toString('base64')};
    expect(()=>admitArtifact(signed,policy)).not.toThrow();
    expect(()=>admitArtifact({...signed,signature:Buffer.alloc(64).toString('base64')},policy)).toThrow();
  });
  it('parses Zod primitives and leaves unsupported refinements unresolved',()=>{
    const parser=new TypeScriptContractParser(new Map([['api.ts',"const Schema=z.object({name:z.string().optional(),age:z.number().min(0)});"]]));
    const t=parser.parseTypeByName('Schema','api.ts').wireType;
    expect(t.kind).toBe('OBJECT'); if(t.kind==='OBJECT'){expect(t.properties[0].type).toEqual(str);expect(t.properties[0].optional).toBe(true);expect(t.properties[1].type.kind).toBe('UNKNOWN');}
  });
});
