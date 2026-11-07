import {describe,it,expect} from 'vitest';
import {SemanticTypeNormalizer} from '../../../src/sajimora/cross-language/SemanticTypeNormalizer';
import {validateTypeGraph} from '../../../src/sajimora/cross-language/RecursiveWireGraph';
import {graphInclusion} from '../../../src/sajimora/cross-language/GraphInclusion';
function normalize(source:string,type='Result'){
  return new SemanticTypeNormalizer(new Map([['tsconfig.json','{"compilerOptions":{"strict":true,"noLib":true,"exactOptionalPropertyTypes":true}}'],['model.ts',source]])).normalize(type,'model.ts','test-revision');
}
describe('selective pinned semantic normalization',()=>{
  it('normalizes a finite conditional and a locally shadowed utility by checker identity',()=>{
    const result=normalize('type Partial<T>={custom:T};type Choice<T>=T extends string?{text:T}:{count:T};type Result=Partial<Choice<"value">>;');
    expect(result.status).toBe('NORMALIZED');expect(result.wireType).toMatchObject({kind:'OBJECT',properties:[{wireName:'custom',type:{kind:'OBJECT',properties:[{wireName:'text',type:{kind:'LITERAL',value:'value'}}]}}]});
  });
  it('preserves source diagnostics instead of normalizing an invalid alias',()=>{
    const result=normalize('type Result=MissingType;');expect(result.status).toBe('SOURCE_CONTRACT_INVALID');expect(result.diagnostics.some(d=>d.code===2304)).toBe(true);expect(result.graph).toBeUndefined();
  });
  it('does not silently turn impossible discriminant intersections into compatible payloads',()=>{
    const result=normalize('type Result={kind:"a"}&{kind:"b"};');expect(result.status).toBe('EVIDENCE_REQUIRED');expect(result.missingEvidence.some(m=>m.includes('construction'))).toBe(true);
  });
  it('interns recursive normalized objects without erasing cycles in legacy DTOs',()=>{
    const result=normalize('interface Result{id:number;child?:Result;}');expect(result.status).toBe('NORMALIZED');expect(validateTypeGraph(result.graph)).toBe(true);expect(result.wireType).toBeUndefined();
    expect(graphInclusion(result.graph!,result.graph!,'Result','Result').status).toBe('COMPATIBILITY_PROVED_IN_SCOPE');
  });
  it('keeps a missing compiler context or dependency as precise evidence',()=>{
    const absent=new SemanticTypeNormalizer(new Map([['model.ts','type Result={id:number};']])).normalize('Result','model.ts');expect(absent.status).toBe('EVIDENCE_REQUIRED');expect(absent.missingEvidence.some(m=>m.includes('configuration'))).toBe(true);
    const imported=normalize('import {External} from "missing";type Result=External;');expect(imported.status).toBe('EVIDENCE_REQUIRED');expect(imported.missingEvidence.some(m=>m.includes('missing'))).toBe(true);
  });
  it('retains exact optionality and nullable property alternatives',()=>{
    const result=normalize('type Result={name?:string;value:number|null};');expect(result.status).toBe('NORMALIZED');expect(result.wireType).toMatchObject({properties:[{wireName:'name',optional:true},{wireName:'value',type:{kind:'NULLABLE',innerType:{scalar:'number'}}}]});
  });
  it('returns a valid pending graph when the type node budget is exhausted',()=>{
    const result=new SemanticTypeNormalizer(new Map([['tsconfig.json','{"compilerOptions":{"noLib":true}}'],['model.ts','type Result={id:number};']]),{maxFiles:512,maxBytes:16000000,maxNodes:0}).normalize('Result','model.ts');expect(result.status).toBe('EVIDENCE_REQUIRED');expect(validateTypeGraph(result.graph)).toBe(true);
  });
});
