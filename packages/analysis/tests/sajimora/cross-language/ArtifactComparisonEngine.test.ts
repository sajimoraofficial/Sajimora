/**
 * ArtifactComparisonEngine.test.ts
 *
 * Acceptance tests for ArtifactComparisonEngine.
 */

import { describe, it, expect } from 'vitest';
import { ArtifactComparisonEngine } from '../../../src/sajimora/cross-language/ArtifactComparisonEngine';
import { ContractArtifactEnvelope, BackendContractPayload, FrontendContractPayload, FrontendClientContract } from '../../../src/sajimora/cross-language/ContractArtifactEnvelope';
import { EndpointContract, WireType } from '../../../src/sajimora/cross-language/CanonicalContractIR';
import { normalizeRouteSegments } from '../../../src/sajimora/cross-language/EndpointIdentity';

function makeBackendEnv(endpoints: EndpointContract[], complete: boolean = true): ContractArtifactEnvelope {
  return {
    envelopeVersion: 'SAJIMORA_CONTRACT_ARTIFACT_V1',
    reportSchemaVersion: 'SAJIMORA_CROSS_LANGUAGE_IMPACT_V1',
    kind: 'BACKEND_CONTRACT',
    snapshot: {
      repositoryId: 'backend',
      serviceId: 'api',
      apiVersion: 'v1',
      parentCommit: 'abc',
      candidateSnapshot: 'def'
    },
    profile: {
      toolVersion: '0.1.0',
      frameworkProfile: 'SPRING_MVC',
      codecProfile: 'JACKSON_DEFAULT_V1',
      configFingerprint: '123'
    },
    integrity: { sha256: 'mock' },
    completeness: { complete, unresolvedEndpoints: [], blockers: [] },
    payload: { baseUrls: [], proxyPrefixes: [], endpoints } as BackendContractPayload
  };
}

function makeFrontendEnv(clientContracts: FrontendClientContract[], complete: boolean = true): ContractArtifactEnvelope {
  return {
    envelopeVersion: 'SAJIMORA_CONTRACT_ARTIFACT_V1',
    reportSchemaVersion: 'SAJIMORA_CROSS_LANGUAGE_IMPACT_V1',
    kind: 'FRONTEND_CONTRACT',
    snapshot: {
      repositoryId: 'frontend',
      serviceId: 'web',
      apiVersion: 'v1',
      parentCommit: 'abc',
      candidateSnapshot: 'def'
    },
    profile: {
      toolVersion: '0.1.0',
      clientProfile: 'MULTI_CLIENT_V1',
      configFingerprint: null
    },
    integrity: { sha256: 'mock' },
    completeness: { complete, unresolvedEndpoints: [], blockers: [] },
    payload: { clientContracts } as FrontendContractPayload
  };
}

describe('ArtifactComparisonEngine', () => {
  const engine = new ArtifactComparisonEngine();

  it('detects endpoint deletion (Backend PR)', () => {
    const parentEp: EndpointContract = {
      identity: { service: null, httpMethod: 'GET', normalizedRoute: normalizeRouteSegments('/users/{id}'), direction: 'RESPONSE' },
      pathParameters: [], queryParameters: [], headers: [], body: null,
      provenance: { language: 'JAVA', file: 'UserController.java', line: 1 }
    };
    
    const tsReq: FrontendClientContract = {
      httpMethod: 'GET',
      normalizedRoute: '/users/{id}',
      requestBody: null,
      expectedResponse: { kind: 'UNKNOWN', reason: '' },
      decoderKind: 'INFERRED_TYPE',
      consumers: [{ file: 'api.ts', line: 10, usage: 'fetch' }],
      unresolvedEvidence: [],
      sourceFile: 'api.ts',
      sourceLine: 10
    };

    const baseEnv = makeBackendEnv([parentEp]);
    const candEnv = makeBackendEnv([]); // deleted
    const targetEnv = makeFrontendEnv([tsReq]);

    const res = engine.compare(baseEnv, candEnv, [targetEnv]);
    expect(res.verdict).toBe('LIKELY_VIOLATED');
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]!.change.after).toContain('deleted');
  });

  it('detects added response field with strict decoder', () => {
    const baseBody: WireType = {
      kind: 'OBJECT',
      properties: [{ wireName: 'id', type: { kind: 'PRIMITIVE', scalar: 'number' }, optional: false, nullable: false, validationConstraints: [] }]
    };
    const candBody: WireType = {
      kind: 'OBJECT',
      properties: [
        { wireName: 'id', type: { kind: 'PRIMITIVE', scalar: 'number' }, optional: false, nullable: false, validationConstraints: [] },
        { wireName: 'name', type: { kind: 'PRIMITIVE', scalar: 'string' }, optional: false, nullable: false, validationConstraints: [] }
      ]
    };

    const parentEp: EndpointContract = {
      identity: { service: null, httpMethod: 'GET', normalizedRoute: normalizeRouteSegments('/users/{id}'), direction: 'RESPONSE' },
      pathParameters: [], queryParameters: [], headers: [], body: baseBody,
      provenance: { language: 'JAVA', file: 'UserController.java', line: 1 }
    };
    const candEp = { ...parentEp, body: candBody };

    const tsReq: FrontendClientContract = {
      httpMethod: 'GET',
      normalizedRoute: '/users/{id}',
      requestBody: null,
      expectedResponse: baseBody,
      decoderKind: 'ZOD_STRICT',
      consumers: [], unresolvedEvidence: [], sourceFile: 'api.ts', sourceLine: 10
    };

    const res = engine.compare(makeBackendEnv([parentEp]), makeBackendEnv([candEp]), [makeFrontendEnv([tsReq])]);
    expect(res.verdict).toBe('LIKELY_VIOLATED');
    expect(res.findings[0]!.repairHint).toContain('strict decoder');
  });

  it('ignores added response field with passthrough decoder', () => {
    const baseBody: WireType = { kind: 'OBJECT', properties: [{ wireName: 'id', type: { kind: 'PRIMITIVE', scalar: 'number' }, optional: false, nullable: false, validationConstraints: [] }] };
    const candBody: WireType = { kind: 'OBJECT', properties: [
        { wireName: 'id', type: { kind: 'PRIMITIVE', scalar: 'number' }, optional: false, nullable: false, validationConstraints: [] },
        { wireName: 'name', type: { kind: 'PRIMITIVE', scalar: 'string' }, optional: false, nullable: false, validationConstraints: [] }
    ] };

    const parentEp: EndpointContract = {
      identity: { service: null, httpMethod: 'GET', normalizedRoute: normalizeRouteSegments('/users/{id}'), direction: 'RESPONSE' },
      pathParameters: [], queryParameters: [], headers: [], body: baseBody,
      provenance: { language: 'JAVA', file: 'UserController.java', line: 1 }
    };
    const candEp = { ...parentEp, body: candBody };

    const tsReq: FrontendClientContract = {
      httpMethod: 'GET',
      normalizedRoute: '/users/{id}',
      requestBody: null,
      expectedResponse: baseBody,
      decoderKind: 'ZOD_PASSTHROUGH',
      consumers: [], unresolvedEvidence: [], sourceFile: 'api.ts', sourceLine: 10
    };

    const res = engine.compare(makeBackendEnv([parentEp]), makeBackendEnv([candEp]), [makeFrontendEnv([tsReq])]);
    expect(res.verdict).toBe('LIKELY_PRESERVED');
    expect(res.findings.length).toBe(0);
  });
});

describe('native/reference readiness semantics', () => {
  const ep: EndpointContract = {
    identity: {service:null,httpMethod:'GET',normalizedRoute:normalizeRouteSegments('/orders'),direction:'RESPONSE'},
    pathParameters:[],queryParameters:[],headers:[],body:{kind:'PRIMITIVE',scalar:'number'},
    provenance:{language:'JAVA',file:'OrderController.java',line:1}
  };
  const client: FrontendClientContract = {
    httpMethod:'GET',normalizedRoute:'/orders',targetServiceId:'api',expectedResponse:{kind:'PRIMITIVE',scalar:'number'},
    requestBody:null,decoderKind:'INFERRED_TYPE',consumers:[],unresolvedEvidence:[],consumerTraversalComplete:true,sourceFile:'api.ts',sourceLine:1
  };
  const compare = (backend: EndpointContract, expected=client.expectedResponse, frontendChange=false) => {
    const base=makeBackendEnv([ep]), candidate=makeBackendEnv([backend]), target=makeFrontendEnv([{...client,expectedResponse:expected}]);
    const engine=new ArtifactComparisonEngine({requireServiceMapping:true});
    return frontendChange?engine.compare(target,target,[candidate]):engine.compare(base,candidate,[target]);
  };
  it('keeps artifact incompleteness separate from unresolved link counts and avoids duplicate blockers',()=>{
    const backend: ContractArtifactEnvelope={...makeBackendEnv([ep],false),completeness:{complete:false,unresolvedEndpoints:[],blockers:[{code:'UNRESOLVED_JACKSON_CONFIG',message:'unqualified mapper'}]}};
    const result=new ArtifactComparisonEngine().compare(makeBackendEnv([ep]),backend,[makeFrontendEnv([client])]);
    expect(result.counts.unresolvedLinks).toBe(0);expect(result.blockers).toHaveLength(1);expect(result.verdict).toBe('INCONCLUSIVE');
  });
  it('counts parameter changes and keeps required or constrained supply unresolved in both directions',()=>{
    for(const location of ['pathParameters','queryParameters','headers'] as const) for(const frontendChange of [false,true]) {
      const result=compare({...ep,[location]:[{name:'token',type:{kind:'PRIMITIVE',scalar:'string'},required:true}]},undefined,frontendChange);
      expect(result.verdict).toBe('INCONCLUSIVE');expect(result.counts.unresolvedLinks).toBe(1);
      if(!frontendChange)expect(result.counts.changedEndpoints).toBe(1);
    }
    const constrained=compare({...ep,queryParameters:[{name:'limit',type:{kind:'PRIMITIVE',scalar:'number'},required:false,validationConstraints:[{kind:'MIN',value:1}]}]});
    expect(constrained.verdict).toBe('INCONCLUSIVE');
  });
  it('does not preserve bodyless responses when a body is required, in either direction',()=>{
    for(const frontendChange of [false,true])expect(compare({...ep,body:null},undefined,frontendChange).verdict).toBe('LIKELY_VIOLATED');
  });
  it('keeps unknown bodyless consumers unresolved and accepts void consumers in either direction',()=>{
    for(const frontendChange of [false,true]) {
      expect(compare({...ep,body:null},{kind:'UNKNOWN',reason:'untyped'},frontendChange).verdict).toBe('INCONCLUSIVE');
      expect(compare({...ep,body:null},{kind:'PRIMITIVE',scalar:'void'},frontendChange).verdict).toBe('LIKELY_PRESERVED');
    }
  });
});
