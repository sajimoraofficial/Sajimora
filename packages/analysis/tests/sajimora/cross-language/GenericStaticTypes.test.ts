import {describe,it,expect} from 'vitest';
import {TypeScriptContractParser} from '../../../src/sajimora/cross-language/TypeScriptContractParser';
import * as ts from 'typescript';
import {MultiClientAdapter} from '../../../src/sajimora/cross-language/HttpClientAdapters';
import {UrlConstantResolver} from '../../../src/sajimora/cross-language/UrlConstantResolver';
function parse(source:string,name='Result'){
  return new TypeScriptContractParser(new Map([['types.ts',source]])).parseTypeByName(name,'types.ts');
}
describe('generic finite static type rules',()=>{
  it('uses explicit generic defaults including earlier type parameters',()=>{
    const r=parse('interface Pair<A,B=A>{left:A;right:B} type Result=Pair<string>;');
    expect(r.blockers).toEqual([]);expect(r.wireType).toMatchObject({properties:[{type:{scalar:'string'}},{type:{scalar:'string'}}]});
  });
  it('infers direct typed Observable assignments but not untyped response bodies',()=>{
    const source="import {HttpClient} from '@angular/common/http';import {Observable as Stream} from 'rxjs'; interface Item{id:string} class Api{constructor(private http:HttpClient){} load(){const result:Stream<Item>=this.http.get('/item');this.http.get('/unknown');}}";
    const files=new Map([['types.ts',source]]);
    const r=new MultiClientAdapter().extractRequests(ts.createSourceFile('types.ts',source,ts.ScriptTarget.Latest,true),new UrlConstantResolver(files),new TypeScriptContractParser(files));
    expect(r.requests[0].expectedResponseType).toMatchObject({kind:'OBJECT',properties:[{wireName:'id'}]});expect(r.requests[1].expectedResponseType).toBeNull();
  });
  it('expands enum mapped keys and preserves optional properties',()=>{
    const r=parse("enum Key {A='a', B='b'}; type Result = {[K in Key]?: number};");
    expect(r.blockers).toEqual([]);expect(r.wireType).toMatchObject({kind:'OBJECT',properties:[{wireName:'a',optional:true},{wireName:'b',optional:true}]});
  });
  it('binds mapped keys to indexed value types with homomorphic modifiers',()=>{
    const r=parse('type Source={id:string; count?:number}; type Result={[K in keyof Source]:Source[K]};');
    expect(r.blockers).toEqual([]);expect(r.wireType).toMatchObject({properties:[{wireName:'id',optional:false,type:{scalar:'string'}},{wireName:'count',optional:true}]});
  });
  it('removes optionality with -? and retains readonly wire shapes',()=>{
    const r=parse('type Source={id?:string}; type Result={readonly [K in keyof Source]-?:Source[K]};');
    expect(r.blockers).toEqual([]);expect(r.wireType).toMatchObject({properties:[{optional:false,type:{kind:'PRIMITIVE',scalar:'string'}}]});
  });
  it('gets enum member names rather than enum values',()=>{
    const r=parse("enum Key {A='a', B='b'}; type Result=keyof typeof Key;");
    expect(r.blockers).toEqual([]);expect(r.wireType).toMatchObject({kind:'UNION',types:[{value:'A'},{value:'B'}]});
  });
  it('resolves imported enum constant initializers without executing source',()=>{
    const files=new Map([['base.ts',"export enum Base {A='a'}"],['types.ts',"import {Base as Origin} from './base'; enum Keys {Alias=Origin.A} type Result={[K in Keys]:number};"]]);
    const r=new TypeScriptContractParser(files).parseTypeByName('Result','types.ts');expect(r.blockers).toEqual([]);expect(r.wireType).toMatchObject({properties:[{wireName:'a'}]});
  });
  it('bounds enum initializer cycles',()=>{
    expect(parse('enum A{Value=B.Value} enum B{Value=A.Value} type Result=A;').blockers.length).toBeGreaterThan(0);
  });
  it('intersects the common keys of object unions',()=>{
    const r=parse('type Result=keyof ({id:string;a:number}|{id:string;b:number});');
    expect(r.blockers).toEqual([]);expect(r.wireType).toMatchObject({kind:'LITERAL',value:'id'});
  });
  it('distributes compatible object unions across intersections',()=>{
    const r=parse("type Result=({kind:'a';a:string}|{kind:'b';b:number}) & {extra?:boolean};");
    expect(r.blockers).toEqual([]);expect(r.wireType.kind).toBe('UNION');
    if(r.wireType.kind==='UNION')for(const member of r.wireType.types)expect(member).toMatchObject({properties:expect.arrayContaining([{wireName:'extra',optional:true,type:expect.any(Object),nullable:false,validationConstraints:[]}])});
  });
  it('makes intersected shared properties required and narrows literal primitives',()=>{
    const r=parse("type Result={id?:string}&{id:'fixed'};");
    expect(r.blockers).toEqual([]);expect(r.wireType).toMatchObject({properties:[{optional:false,type:{value:'fixed'}}]});
  });
  it('keeps incompatible intersections unresolved',()=>{
    const r=parse('type Result={id:string}&{id:number};');expect(r.wireType.kind).toBe('UNKNOWN');expect(r.blockers.length).toBeGreaterThan(0);
  });
  it('supports readonly arrays and NonNullable without dropping blockers',()=>{
    const r=parse('type Result=ReadonlyArray<NonNullable<string|null|undefined>>;');
    expect(r.blockers).toEqual([]);expect(r.wireType).toMatchObject({kind:'ARRAY',elementType:{scalar:'string'}});
  });
  it('supports finite Exclude and Extract',()=>{
    expect(parse("type Result=Exclude<'a'|'b','a'>;").wireType).toMatchObject({value:'b'});
    expect(parse("type Result=Extract<'a'|'b','a'>;").wireType).toMatchObject({value:'a'});
    expect(parse("type Result=Exclude<1|'1',1>;").wireType).toMatchObject({value:'1'});
  });
  it('does not erase explicit casts or invent any for unknown array elements',()=>{
    expect(parse("const values=['a'] as number[];type Result=typeof values;").wireType).toMatchObject({kind:'ARRAY',elementType:{scalar:'number'}});
    expect(parse('const values=[external];type Result=typeof values;').blockers.length).toBeGreaterThan(0);
  });
  it('does not invent dynamic mapped keys or remapped names',()=>{
    for(const source of ['type Result={[K in External]:number};','type Result={[K in "a" as "b"]:number};'])expect(parse(source).blockers.length).toBeGreaterThan(0);
  });
  it('represents broad string mapped keys as a dictionary',()=>{
    const r=parse('type Result={[K in string]:number};');expect(r.blockers).toEqual([]);expect(r.wireType).toMatchObject({kind:'MAP',keyType:{scalar:'string'},valueType:{scalar:'number'}});
  });
  it('applies defaults when all generic arguments are omitted',()=>{
    const r=parse('type Envelope<T=string>={value:T};type Result=Envelope;');expect(r.blockers).toEqual([]);expect(r.wireType).toMatchObject({properties:[{type:{scalar:'string'}}]});
  });
  it('retains recursive, external and function-valued unknowns',()=>{
    for(const source of ['interface Result{next:Result;}','type Result=External;','type Result=()=>string;'])expect(parse(source).blockers.length).toBeGreaterThan(0);
  });
  it('resolves mapped types in imported generic declarations',()=>{
    const files=new Map([['source.ts','export type Copy<T>={[K in keyof T]:T[K]};'],['types.ts',"import {Copy} from './source'; type Result=Copy<{id:string}>;"]]);
    const r=new TypeScriptContractParser(files).parseTypeByName('Result','types.ts');expect(r.blockers).toEqual([]);expect(r.wireType).toMatchObject({properties:[{wireName:'id',type:{scalar:'string'}}]});
  });
});
