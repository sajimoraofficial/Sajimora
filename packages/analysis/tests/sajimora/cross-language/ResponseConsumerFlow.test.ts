import {describe,it,expect} from 'vitest';
import {ConsumerImpactGraph} from '../../../src/sajimora/cross-language/ConsumerImpactGraph';
import * as ts from 'typescript';
import {callIdentity} from '../../../src/sajimora/cross-language/CallIdentity';
function trace(text:string,call='http.get("/x")'){return new ConsumerImpactGraph(new Map([['client.ts',text]])).analyzeCallConsumers('client.ts',1,call);}
function transportTrace(text:string,call:string,adapter:string,observe?:string){
  const sf=ts.createSourceFile('client.ts',text,ts.ScriptTarget.Latest,true);let selected:ts.CallExpression|undefined;
  function visit(node:ts.Node){if(ts.isCallExpression(node)&&node.getText(sf)===call)selected=node;ts.forEachChild(node,visit);}visit(sf);
  if(!selected)throw new Error('Test call absent');
  return new ConsumerImpactGraph(new Map([['client.ts',text]])).analyzeCallConsumers('client.ts',1,call,undefined,callIdentity(selected,adapter),{observe});
}
function rxTrace(text:string,call:string){return new ConsumerImpactGraph(new Map([
  ['client.ts',text],['node_modules/rxjs/package.json','{"name":"rxjs","version":"7.8.2","types":"index.d.ts"}'],
  ['node_modules/rxjs/operators/index.d.ts','export declare function switchMap(project:any):any; export declare function map(project:any):any; export declare function catchError(project:any):any;']
])).analyzeCallConsumers('client.ts',1,call);}
describe('response consumer flow',()=>{
  it('reaches subscription property reads and aliases',()=>{
    const result=trace('declare const http:any; http.get("/x").subscribe(value=>{const alias=value; const id=alias.id;});');
    expect(result.consumers.some(c=>c.usage==='alias.id')).toBe(true);
    expect(result.complete).toBe(true);
  });
  it('retains RxJS projections as unresolved while recording their consumers',()=>{
    const result=trace('declare const http:any; declare const map:any; http.get("/x").pipe(map(value=>value.id)).subscribe(value=>{});');
    expect(result.consumers.some(c=>c.usage==='value.id')).toBe(true);
    expect(result.complete).toBe(false);
  });
  it('records service callers and retains component template assignments',()=>{
    const result=trace('declare const http:any; class Service {read(){return http.get("/x");}} class Component {data:any; constructor(private api:Service){} load(){this.api.read().subscribe(value=>this.data=value);}}');
    expect(result.consumers).toEqual(expect.arrayContaining([expect.objectContaining({usage:expect.stringContaining('this.data=value')})]));
    expect(result.unresolved.some(u=>u.includes('template'))).toBe(true);
    expect(result.complete).toBe(false);
  });
  it('does not call opaque callbacks or dynamic property access complete',()=>{
    expect(trace('declare const http:any; declare const consume:any; http.get("/x").subscribe(consume);').complete).toBe(false);
    expect(trace('declare const http:any; declare const key:any; http.get("/x").subscribe(value=>{const data=value[key];});').complete).toBe(false);
  });
  it('keeps fetch transport reads separate from decoded JSON body reads',()=>{
    const result=transportTrace('declare const fetch:any; fetch("/x").then(r=>{const status=r.status; return r.json();}).then(dto=>dto.id);','fetch("/x")','FETCH');
    expect(result.consumers).toEqual(expect.arrayContaining([expect.objectContaining({propertyPath:'@transport.status'}),expect.objectContaining({propertyPath:'$.id'})]));
    expect(result.consumers.some(c=>c.propertyPath==='$.status')).toBe(false);
  });
  it('unwraps Axios data and Angular response body without inventing body status fields',()=>{
    for(const [adapter,member,observe] of [['AXIOS','data',undefined],['ANGULAR','body','response']] as const){
      const result=transportTrace(`declare const http:any; http.get("/x").then(r=>{const status=r.status; return r.${member}.id;});`,'http.get("/x")',adapter,observe);
      expect(result.consumers.some(c=>c.propertyPath==='$.id')).toBe(true);
      expect(result.consumers.some(c=>c.propertyPath==='$.status')).toBe(false);
    }
  });
  it('traces captured function parameters and returns at their actual call sites',()=>{
    const result=trace('declare const http:any; function same(x:any){return x;} http.get("/x").subscribe(value=>same(value).id); same({other:1}).unrelated;');
    expect(result.consumers.some(c=>c.propertyPath==='$.id')).toBe(true);
    expect(result.consumers.some(c=>c.propertyPath==='$.unrelated')).toBe(false);
    expect(result.unresolved).not.toContain('Returned response has an unqualified external entry point');
  });
  it('traces expression-bodied helper returns and records indexed element obligations',()=>{
    const result=trace('declare const http:any; const same=(x:any)=>x; http.get("/x").subscribe(value=>same(value)[0].id);');
    expect(result.consumers.some(c=>c.propertyPath==='$[].id')).toBe(true);
  });
  it('marks guarded reads and recursive helper summaries as unqualified',()=>{
    const guarded=trace('declare const http:any; http.get("/x").subscribe(value=>{if(value!=null){value.id;}});');
    expect(guarded.consumers.find(c=>c.propertyPath==='$.id')?.guards?.length).toBeGreaterThan(0);
    const recursive=trace('declare const http:any; function recurse(x:any):any{return recurse(x);} http.get("/x").subscribe(value=>recurse(value).id);');
    expect(recursive.unresolved).toContain('Recursive function response summary requires SCC qualification');
  });
  it('replaces the outer response origin at a pinned switchMap boundary',()=>{
    const text='import {switchMap,map} from "rxjs/operators"; declare const http:any; http.get("/outer").pipe(switchMap(outer=>http.get("/inner")),map(inner=>inner.id)).subscribe(id=>id.toFixed());';
    const outer=rxTrace(text,'http.get("/outer")'),inner=rxTrace(text,'http.get("/inner")');
    expect(outer.consumers.some(c=>c.propertyPath==='$.id')).toBe(false);
    expect(inner.consumers.some(c=>c.propertyPath==='$.id')).toBe(true);
    expect(inner.consumers.some(c=>c.propertyPath==='$.id.toFixed')).toBe(true);
  });
  it('keeps catchError fallbacks separate and qualifies earlier throwing reads',()=>{
    const result=rxTrace('import {map,catchError} from "rxjs/operators"; declare const http:any; http.get("/x").pipe(map(value=>value.id),catchError(error=>({fallback:1}))).subscribe(value=>value.toFixed());','http.get("/x")');
    expect(result.consumers.find(c=>c.propertyPath==='$.id')?.guards).toEqual(expect.arrayContaining(['RxJS catchError fallback/error reachability requires qualification']));
    expect(result.unresolved).toContain('RxJS catchError fallback alternatives require a response contract');
    expect(result.consumers.some(c=>c.propertyPath==='$.fallback')).toBe(false);
  });
});
