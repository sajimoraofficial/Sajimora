import {describe,it,expect} from 'vitest';
import {assessObservation,ContractObservation} from '../../../src/sajimora/cross-language/ObservedContractEvidence';
import {declaredWireGraph} from '../../../src/sajimora/cross-language/WireTypeGraph';
import {mkObjectWireType,mkPrimitiveWireType} from '../../../src/sajimora/cross-language/CanonicalContractIR';
const expected={endpointId:'GET /x',buildRevision:'commit',environmentProfile:'ci',status:200,mediaType:'application/json'};
const graph=declaredWireGraph(mkObjectWireType([{wireName:'id',type:mkPrimitiveWireType('number'),optional:false,nullable:false,validationConstraints:[]}]),'commit');
function observation(payload:unknown):ContractObservation{return {version:'SAJIMORA_OBSERVATION_V1',...expected,timestamp:'2026-10-06T00:00:00Z',provenance:'imported CI fixture',consentScope:'LOCAL_SHAPE_ONLY',redaction:{shapeChanged:false},payload};}
describe('local observed evidence without universal safety claims',()=>{
  it('reports an observed failure even when unrelated general coverage is unavailable',()=>{
    const result=assessObservation(observation({id:'wrong'}),graph,expected);expect(result).toMatchObject({status:'OBSERVED_FAILURE',universalCompatibility:false,witness:{path:'$.id'}});expect(JSON.stringify(result)).not.toContain('wrong');
  });
  it('never promotes successful finite samples into universal compatibility',()=>{
    for(const id of [1,2])expect(assessObservation(observation({id}),graph,expected)).toMatchObject({status:'OBSERVED_ACCEPTANCE',universalCompatibility:false});
  });
  it('keeps omission distinct from null and attaches the exact missing-field witness',()=>{
    expect(assessObservation(observation({}),graph,expected).witness?.path).toBe('$.id');expect(assessObservation(observation({id:null}),graph,expected).status).toBe('OBSERVED_FAILURE');
  });
  it('rejects old builds, changed shape redactions and different status scopes',()=>{
    expect(assessObservation(observation({id:1}),{...graph,manifest:{...graph.manifest,snapshot:'old'}},expected).status).toBe('EVIDENCE_REQUIRED');
    expect(assessObservation({...observation({id:1}),buildRevision:'old'},graph,expected).status).toBe('EVIDENCE_REQUIRED');
    expect(assessObservation({...observation({id:1}),redaction:{shapeChanged:true}},graph,expected).status).toBe('EVIDENCE_REQUIRED');
    expect(assessObservation({...observation({id:1}),status:500},graph,expected).status).toBe('EVIDENCE_REQUIRED');
  });
  it('retains shape only and prevents cyclic or accessor payload execution',()=>{
    const secret='Bearer private-value';expect(JSON.stringify(assessObservation(observation({id:1,token:secret}),graph,expected))).not.toContain(secret);
    const cyclic:any={};cyclic.self=cyclic;expect(assessObservation(observation(cyclic),graph,expected).status).toBe('EVIDENCE_REQUIRED');
    let reads=0;const getter={get id(){reads++;return 1;}};expect(assessObservation(observation(getter),graph,expected).status).toBe('EVIDENCE_REQUIRED');expect(reads).toBe(0);
  });
});
