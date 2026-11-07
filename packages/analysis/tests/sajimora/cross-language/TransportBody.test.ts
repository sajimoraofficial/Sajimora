import {describe,it,expect} from 'vitest';
import * as ts from 'typescript';
import {deriveTransportBody} from '../../../src/sajimora/cross-language/TransportBody';
import {validateTypeGraph} from '../../../src/sajimora/cross-language/RecursiveWireGraph';
function body(source:string){const sf=ts.createSourceFile('request.ts',source,ts.ScriptTarget.Latest,true);const statement=sf.statements[sf.statements.length-1] as ts.ExpressionStatement;return deriveTransportBody(statement.expression);}
describe('actual request values and transport partitions',()=>{
  it('omits undefined/function object members and emits null in array slots',()=>{
    const object=body('JSON.stringify({id:1,missing:undefined,fn:()=>1,nil:null});');
    expect(object.status).toBe('ENCODED_DOMAIN');expect(object.valueGraph?.definitions.body).toMatchObject({kind:'OBJECT',properties:[{wireName:'id'},{wireName:'nil',type:{kind:'NULL'}}]});
    const array=body('JSON.stringify([undefined,()=>1,,null]);');expect(array.valueGraph?.definitions.body).toMatchObject({kind:'TUPLE',elements:[{kind:'NULL'},{kind:'NULL'},{kind:'NULL'},{kind:'NULL'}]});
  });
  it('distinguishes null JSON, absent bodies and text',()=>{
    expect(body('JSON.stringify(null);')).toMatchObject({kind:'JSON',status:'ENCODED_DOMAIN'});
    expect(body('JSON.stringify(undefined);')).toMatchObject({kind:'ABSENT',status:'ENCODED_DOMAIN'});
    expect(deriveTransportBody(undefined).kind).toBe('ABSENT');expect(body('"text";').kind).toBe('TEXT');
  });
  it('uses actual initialized values and ordered spreads instead of cast annotations',()=>{
    const result=body('const value={id:1};JSON.stringify({...value,id:"changed"} as {id:number});');
    expect(result.status).toBe('ENCODED_DOMAIN');expect(result.valueGraph?.definitions.body).toMatchObject({properties:[{wireName:'id',type:{kind:'LITERAL',value:'changed'}}]});
  });
  it('does not trust a mutating const, its alias, or an unknown spread',()=>{
    for(const source of ['const value={id:1};value.id=2;JSON.stringify(value);','const value={id:1};const alias=value;alias.id=2;JSON.stringify(value);','declare const unknown:any;JSON.stringify({id:1,...unknown});'])expect(body(source).status).toBe('EVIDENCE_REQUIRED');
  });
  it('keeps Map, binary and multipart distinct from JSON dictionaries',()=>{
    const map=body('JSON.stringify(new Map());');expect(map.valueGraph?.definitions.body).toEqual({kind:'OBJECT',strict:true,properties:[]});
    expect(body('new Blob();').kind).toBe('BINARY');expect(body('new FormData();').kind).toBe('MULTIPART');
    expect(body('new Blob();').valueGraph).toBeUndefined();
  });
  it('requires reaching definitions after mutating calls or escaped values',()=>{
    for(const source of ['const value=[1];value.push(2);JSON.stringify(value);','const value={id:1};mutate(value);JSON.stringify(value);','JSON.stringify(new Map([1]));'])expect(body(source).status).toBe('EVIDENCE_REQUIRED');
    expect(body('const value={id:1};JSON.stringify(value);').status).toBe('ENCODED_DOMAIN');
  });
  it('requires toJSON/replacer summaries and rejects a BigInt encoder domain',()=>{
    expect(body('JSON.stringify({toJSON(){return {id:1};}});').status).toBe('EVIDENCE_REQUIRED');
    expect(body('JSON.stringify({id:1},replacer);').status).toBe('EVIDENCE_REQUIRED');
    expect(body('JSON.stringify(1n);').status).toBe('SOURCE_CONTRACT_INVALID');
  });
  it('models conditional omission and array slots without conflating absence with null',()=>{
    const object=body('declare const flag:boolean;JSON.stringify({id:flag?1:undefined});');expect(object.valueGraph?.definitions.body).toMatchObject({properties:[{wireName:'id',optional:true,type:{kind:'LITERAL',value:1}}]});
    const array=body('declare const flag:boolean;JSON.stringify([flag?1:undefined]);');expect(validateTypeGraph(array.valueGraph)).toBe(true);expect(array.valueGraph?.definitions.body).toMatchObject({elements:[{kind:'UNION',types:[{kind:'LITERAL',value:1},{kind:'NULL'}]}]});
  });
});
