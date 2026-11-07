import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../../../src/sajimora/cross-language/ContractArtifactEnvelope';
import {importSchemaEvidence,SchemaEvidence} from '../../../src/sajimora/cross-language/SchemaEvidence';
import {validateTypeGraph,graphComponents} from '../../../src/sajimora/cross-language/RecursiveWireGraph';
const expected={repositoryId:'api',revision:'commit',endpoint:'/x',method:'GET',status:200,mediaType:'application/json',codecProfile:'JACKSON_DEFAULT_V1'};
function evidence(schema:unknown):SchemaEvidence{return {version:'SAJIMORA_SCHEMA_EVIDENCE_V1',...expected,dialect:'https://json-schema.org/draft/2020-12/schema',root:'schema.json',documents:{'schema.json':{schema,sha256:createHash('sha256').update(canonicalJson(schema)).digest('hex')}}};}
describe('revision-bound explicit schema evidence',()=>{
  it('imports a recursive local-reference graph without claiming implementation conformance',()=>{
    const result=importSchemaEvidence(evidence({type:'object',required:['id'],properties:{id:{type:'number'},child:{$ref:'#'}}}),expected);
    expect(result.status).toBe('DECLARED_CONTRACT');expect(result.implementationConformance).toBe('NOT_ESTABLISHED');expect(validateTypeGraph(result.graph)).toBe(true);expect(graphComponents(result.graph!).some(component=>component.length===1)).toBe(true);
  });
  it('rejects wrong revisions, media profiles and tampered manifests',()=>{
    const input=evidence({type:'string'});expect(importSchemaEvidence(input,{...expected,revision:'older'}).graph).toBeUndefined();
    expect(importSchemaEvidence(input,{...expected,mediaType:'text/plain'}).graph).toBeUndefined();
    expect(importSchemaEvidence({...input,documents:{'schema.json':{schema:{type:'number'},sha256:input.documents['schema.json'].sha256}}},expected).graph).toBeUndefined();
  });
  it('does not fetch external references or silently ignore unsupported constraints',()=>{
    for(const schema of [{$ref:'https://example.invalid/schema'}, {type:'string',pattern:'x'}, {oneOf:[{type:'string'},{type:'number'}]}])expect(importSchemaEvidence(evidence(schema),expected).status).toBe('EVIDENCE_REQUIRED');
  });
  it('does not discard contradictory sibling assertions',()=>{
    for(const schema of [{type:'number',enum:['string']},{type:'number',anyOf:[{type:'string'}]},{type:'object',$id:'other.json',properties:{child:{$ref:'#'}}}])expect(importSchemaEvidence(evidence(schema),expected).status).toBe('EVIDENCE_REQUIRED');
  });
});
