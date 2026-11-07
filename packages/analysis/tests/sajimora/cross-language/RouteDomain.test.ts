import {describe,it,expect} from 'vitest';
import * as ts from 'typescript';
import {deriveRouteDomain} from '../../../src/sajimora/cross-language/RouteDomain';
import {UrlConstantResolver} from '../../../src/sajimora/cross-language/UrlConstantResolver';
function domain(source:string,extra=new Map<string,string>()){
  const text=source+'; const __route=route;',sf=ts.createSourceFile('client.ts',text,ts.ScriptTarget.Latest,true),files=new Map([...extra,['client.ts',text]]);
  const expression=(sf.statements[sf.statements.length-1] as ts.VariableStatement).declarationList.declarations[0].initializer!;
  const resolver=new UrlConstantResolver(files);return {domain:deriveRouteDomain(expression,resolver),resolved:resolver.resolveUrl(expression,'client.ts')};
}
describe('bounded route and ownership evidence',()=>{
  it('retains finite route alternatives without choosing the first branch',()=>{
    const result=domain('declare const flag:boolean;const route=flag?"/a":"/b"');
    expect(result.domain.alternatives.map(a=>a.path)).toEqual(['/a','/b']);expect(result.resolved.isDynamic).toBe(true);
  });
  it('requires encoding for symbolic whole path segments',()=>{
    const encoded=domain('declare const id:string;const route=`/items/${encodeURIComponent(id)}`');
    expect(encoded.domain.pathComplete).toBe(true);expect(encoded.resolved.url).toBe('/items/${encoded:id}');
    expect(domain('declare const id:string;const route=`/items/${id}`').domain.pathComplete).toBe(false);
    expect(domain('declare const id:string;const route=`/items/${encodeURIComponent(id)}suffix`').domain.pathComplete).toBe(false);
  });
  it('substitutes captured imported builder arguments and fingerprints their source',()=>{
    const result=domain('import {item} from "./routes";const route=item("a/b")',new Map([['routes.ts','export function item(id:string){return `/items/${encodeURIComponent(id)}`;}']]));
    expect(result.resolved.url).toBe('/items/a%2Fb');expect(result.domain.sourceEvidence.some(e=>e.file==='routes.ts')).toBe(true);
  });
  it('separates query uncertainty and repeated values from a known path',()=>{
    const result=domain('declare const term:string;const route=`/items?q=${term}&tag=a&tag=b`');
    expect(result.domain.pathComplete).toBe(true);expect(result.domain.alternatives[0].path).toBe('/items');
    expect(result.domain.alternatives[0].query.filter(q=>q.key==='tag').every(q=>q.repeated)).toBe(true);
    expect(result.domain.missingEvidence.some(e=>e.includes('query'))).toBe(true);
  });
  it('does not treat a shadowed encoder or dynamic host as an endpoint proof',()=>{
    expect(domain('function encodeURIComponent(x:any){return x;}declare const id:string;const route=`/items/${encodeURIComponent(id)}`').domain.pathComplete).toBe(false);
    expect(domain('declare const host:string;const route=`https://${host}/items`').domain.pathComplete).toBe(false);
  });
  it('rejects mutated config and cycles instead of reusing stale constant values',()=>{
    expect(domain('const config={base:"/a"};config.base="/b";const route=config.base').domain.pathComplete).toBe(false);
    expect(domain('const route=route').domain.pathComplete).toBe(false);
  });
  it('resolves enum members and string transformation methods like toLowerCase', () => {
    const result = domain('enum EntityType { DEVICE = "DEVICE", ASSET = "ASSET" }; const route = `/api/${EntityType.DEVICE.toLowerCase()}`');
    expect(result.domain.pathComplete).toBe(true);
    expect(result.domain.alternatives.map(a => a.path)).toEqual(['/api/device']);
    expect(result.resolved.isDynamic).toBe(false);
    expect(result.resolved.url).toBe('/api/device');
    expect(result.resolved.blocker).toBeUndefined();
  });
  it('expands finite string literal unions on parameters into valid complete routes', () => {
    const result = domain('declare const mode: "online" | "offline"; const route = `/api/status/${mode}`');
    expect(result.domain.pathComplete).toBe(true);
    expect(result.domain.alternatives.map(a => a.path)).toEqual(['/api/status/online', '/api/status/offline']);
    expect(result.resolved.isDynamic).toBe(true);
    expect(result.resolved.alternatives).toEqual(['/api/status/online', '/api/status/offline']);
    expect(result.resolved.blocker).toBeUndefined();
  });
  it('resolves imported enum and type alias union definitions across module boundaries', () => {
    const extra = new Map([
      ['models.ts', 'export enum Kind { USER = "users", GROUP = "groups" }; export type Scope = "tenant" | "system";']
    ]);
    const result = domain('import { Kind, Scope } from "./models"; declare const s: Scope; const route = `/api/${Kind.USER}/${s}`', extra);
    expect(result.domain.pathComplete).toBe(true);
    expect(result.domain.alternatives.map(a => a.path)).toEqual(['/api/users/tenant', '/api/users/system']);
    expect(result.resolved.isDynamic).toBe(true);
    expect(result.resolved.blocker).toBeUndefined();
  });
  it('fails closed when a union contains an unbounded string', () => {
    const result = domain('declare const mixed: "fixed" | string; const route = `/api/${mixed}`');
    expect(result.domain.pathComplete).toBe(false);
    expect(result.resolved.isDynamic).toBe(true);
    expect(result.resolved.blocker?.code).toBe('DYNAMIC_URL');
  });
});
