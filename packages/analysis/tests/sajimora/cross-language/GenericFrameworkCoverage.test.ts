import {describe,it,expect} from 'vitest';
import {SnapshotModuleResolver} from '../../../src/sajimora/cross-language/SnapshotModuleResolver';
import {TypeScriptContractParser} from '../../../src/sajimora/cross-language/TypeScriptContractParser';
import {matchRoutes,normalizeRouteSegments} from '../../../src/sajimora/cross-language/EndpointIdentity';
import {parseSpringMapping} from '../../../src/sajimora/cross-language/SpringMapping';
import * as ts from 'typescript';
import {MultiClientAdapter} from '../../../src/sajimora/cross-language/HttpClientAdapters';
import {UrlConstantResolver} from '../../../src/sajimora/cross-language/UrlConstantResolver';
import {JavaWireModelEngine} from '../../../src/sajimora/cross-language/JavaWireModelEngine';
import {JavaSealedCompilerHost} from '../../../src/sajimora/languages/java/programs/JavaSealedCompilerHost';
import {sealEnvelope,serializeEnvelope,parseEnvelope,verifyEnvelopeIntegrity} from '../../../src/sajimora/cross-language/ContractArtifactEnvelope';

describe('snapshot framework coverage',()=>{
  it('retains known paths when only query values are dynamic without dropping query uncertainty',()=>{
    const source='const url=`/api/items?search=${query}`;',sf=ts.createSourceFile('client.ts',source,ts.ScriptTarget.Latest,true),expression=(sf.statements[0] as ts.VariableStatement).declarationList.declarations[0].initializer!;
    const result=new UrlConstantResolver(new Map([['client.ts',source]])).resolveUrl(expression,'client.ts');
    expect(result.isDynamic).toBe(false);
    expect(result.url.split('?')[0]).toBe('/api/items');
    expect(result.blocker?.code).toBe('UNRESOLVED_HTTP_WRAPPER');
  });
  it('recognizes canonical Angular inject aliases without treating arbitrary factories as HTTP clients',()=>{
    const content="import {HttpClient} from '@angular/common/http'; import {inject as provide} from '@angular/core'; class Api {private transport=provide(HttpClient); read(){return this.transport.get<string>('/item');}}";
    const sources=new Map([['api.ts',content]]);
    const result=new MultiClientAdapter().extractRequests(ts.createSourceFile('api.ts',content,ts.ScriptTarget.Latest,true),new UrlConstantResolver(sources),new TypeScriptContractParser(sources));
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].expectedResponseType).toMatchObject({kind:'PRIMITIVE',scalar:'string'});
  });
  const files = new Map([
    ['tsconfig.base.json',JSON.stringify({compilerOptions:{baseUrl:'.',paths:{'@domain/*':['domain/*']}}})],
    ['tsconfig.json',JSON.stringify({extends:'./tsconfig.base.json'})],
    ['domain/page.ts','export interface Page<T> { items: T[]; total: number; }'],
    ['domain/value.ts','export interface Value { id: string; label?: string | null; }'],
    ['domain/index.ts',"export {Page as Envelope} from './page'; export {Value} from './value';"],
    ['client.ts',"import {Envelope,Value} from '@domain/index'; type Result = Envelope<Value>;"],
    ['isolated/tsconfig.json',JSON.stringify({compilerOptions:{baseUrl:'.',paths:{'@domain/*':['private/*']}}})],
    ['isolated/client.ts',"import {Value} from '@domain/value';"],
  ]);
  it('resolves aliases and inherited config from captured files',()=>expect(new SnapshotModuleResolver(files).resolve('@domain/value','client.ts')).toBe('domain/value.ts'));
  it('does not cross nested project boundaries to a similarly named DTO',()=>expect(new SnapshotModuleResolver(files).resolve('@domain/value','isolated/client.ts')).toBeUndefined());
  it('instantiates imported generic aliases through a barrel',()=>{
    const result = new TypeScriptContractParser(files).parseTypeByName('Result','client.ts');
    expect(result.blockers).toEqual([]);
    expect(result.wireType).toMatchObject({kind:'OBJECT',properties:[{wireName:'items',type:{kind:'ARRAY',elementType:{kind:'OBJECT',properties:expect.arrayContaining([{wireName:'id',type:expect.objectContaining({kind:'PRIMITIVE',scalar:'string'}),optional:false,nullable:false,validationConstraints:[],provenance:expect.any(Object)}])}}},{wireName:'total'}]});
  });
  it('keeps missing generic arguments unresolved',()=>expect(new TypeScriptContractParser(files).parseTypeByName('Page','domain/page.ts').wireType.kind).toBe('UNKNOWN'));
  it('bounds recursive generic DTOs',()=>{
    const parser = new TypeScriptContractParser(new Map([['node.ts','interface Node<T> {value:T; next:Node<T>;}']]));
    expect(parser.parseTypeByName('Node<string>','node.ts').blockers.length).toBeGreaterThan(0);
  });
  it('specializes inherited members without duplicate wire keys',()=>{
    const parser = new TypeScriptContractParser(new Map([['dto.ts','interface Base {id:string; name:string;} interface Detailed extends Base {name:string; extra:number;}']]));
    const result=parser.parseTypeByName('Detailed','dto.ts');
    expect(result.blockers).toEqual([]);
    expect(result.wireType.kind==='OBJECT'&&result.wireType.properties.map(p=>p.wireName)).toEqual(['id','name','extra']);
  });
  it('never links unknown routes to root routes or wildcard handlers',()=>{
    for(const route of ['/','/**','<dynamic>']) expect(matchRoutes(normalizeRouteSegments('<dynamic>'),normalizeRouteSegments(route)).matches).toBe(false);
    expect(matchRoutes(normalizeRouteSegments('/'),normalizeRouteSegments('/')).matches).toBe(true);
  });
  it('preserves every literal route and explicit HTTP verb',()=>expect(parseSpringMapping('@RequestMapping(path={"/public/**", "/proxy/**"}, method={RequestMethod.GET, RequestMethod.POST})')).toEqual({paths:['/public/**','/proxy/**'],methods:['GET','POST'],unresolved:false}));
  it('does not assume GET for method-unrestricted mappings',()=>expect(parseSpringMapping('@RequestMapping("/proxy/**")')?.methods).toContain('POST'));
  it('keeps route constants and request conditions unqualified',()=>{
    expect(parseSpringMapping('@GetMapping(API_PATH)')).toEqual({paths:[],methods:['GET'],unresolved:true});
    expect(parseSpringMapping('@GetMapping(path="/items", params="active=true")')).toMatchObject({params:['active=true'],unresolved:false});
  });
  it('expands class and method route arrays without inventing root endpoints',()=>{
    const text = `package demo;
@RestController
@RequestMapping({"/a", "/b"})
public class Routes {
  @RequestMapping(path={"/x", "/y"}, method={RequestMethod.GET, RequestMethod.POST})
  public String read() {return "ok";}
}`;
    const host = new JavaSealedCompilerHost({trackedFiles:['Routes.java'],readTextFile:()=>text});
    const result = new JavaWireModelEngine(host).extractControllerEndpoints(host.getAllClasses()[0]);
    expect(result.endpoints.filter(e=>e.identity.direction==='RESPONSE').map(e=>`${e.identity.httpMethod} ${e.identity.normalizedRoute.rawPath}`).sort()).toEqual(['GET /a/x','GET /a/y','GET /b/x','GET /b/y','POST /a/x','POST /a/y','POST /b/x','POST /b/y']);
  });
  it('supports direct Observable returns and text bodies without masking observe envelopes',()=>{
    const content = `import {HttpClient} from '@angular/common/http'; import {Observable} from 'rxjs'; interface Item {id:string;} class Api {constructor(private http:HttpClient){} read():Observable<Item>{return this.http.get('/item');} text(){return this.http.get('/text',{responseType:'text'});} envelope(){return this.http.get('/text',{observe:'response',responseType:'text'});} }`;
    const sources = new Map([['api.ts',content]]);
    const result = new MultiClientAdapter().extractRequests(ts.createSourceFile('api.ts',content,ts.ScriptTarget.Latest,true),new UrlConstantResolver(sources),new TypeScriptContractParser(sources));
    expect(result.requests.map(r=>r.expectedResponseType?.kind)).toEqual(['OBJECT','PRIMITIVE','PRIMITIVE']);
    expect(result.requests[2].httpOptionsEvidence).toMatchObject({observe:'response',responseType:'text'});
    expect(result.requests[1].expectedResponseType).toMatchObject({scalar:'string'});
  });
  it('keeps large sealed artifacts compact without changing contract facts or integrity',()=>{
    const envelope=sealEnvelope({envelopeVersion:'SAJIMORA_CONTRACT_ARTIFACT_V1',reportSchemaVersion:'SAJIMORA_CROSS_LANGUAGE_IMPACT_V1',kind:'FRONTEND_CONTRACT',snapshot:{repositoryId:'fixture',serviceId:'frontend',apiVersion:'v1',parentCommit:'base',candidateSnapshot:'candidate'},profile:{toolVersion:'test',configFingerprint:null,clientProfile:'MULTI_CLIENT_V1'},completeness:{complete:false,unresolvedEndpoints:['x'.repeat(1024*1024)],blockers:[]},payload:{clientContracts:[]}});
    const serialized=serializeEnvelope(envelope);
    expect(serialized).not.toContain('\n');
    expect(parseEnvelope(serialized)).toEqual(envelope);
    expect(verifyEnvelopeIntegrity(parseEnvelope(serialized))).toBe(true);
  });
});
