import {describe,it,expect} from 'vitest';
import * as ts from 'typescript';
import {createHash} from 'node:crypto';
import {AngularAdapter} from '../../../src/sajimora/cross-language/HttpClientAdapters';
import {UrlConstantResolver} from '../../../src/sajimora/cross-language/UrlConstantResolver';
import {TypeScriptContractParser} from '../../../src/sajimora/cross-language/TypeScriptContractParser';
import {ConsumerImpactGraph} from '../../../src/sajimora/cross-language/ConsumerImpactGraph';
import {AngularInterceptorSummary} from '../../../src/sajimora/cross-language/AngularInterceptorSummary';
import {callIdentity} from '../../../src/sajimora/cross-language/CallIdentity';
import {assessBackendChanges} from '../../../src/sajimora/cross-language/ScopedChangeAssessment';
import {sealEnvelope,FrontendClientContract,ContractArtifactEnvelope} from '../../../src/sajimora/cross-language/ContractArtifactEnvelope';
import {EndpointContract,mkObjectWireType,mkPrimitiveWireType} from '../../../src/sajimora/cross-language/CanonicalContractIR';
import {normalizeRouteSegments} from '../../../src/sajimora/cross-language/EndpointIdentity';

function exported(source:string,extra=new Map<string,string>()){
  const files=new Map([...extra,['api.ts',source]]),sf=ts.createSourceFile('api.ts',source,ts.ScriptTarget.Latest,true),resolver=new UrlConstantResolver(files);
  const extracted=new AngularAdapter().extractRequests(sf,resolver,new TypeScriptContractParser(files));
  const req=extracted.requests[0],flow=new ConsumerImpactGraph(files).analyzeCallConsumers('api.ts',req.provenance.line,undefined,req.provenance.column,req.provenance.callIdentity);
  const effects=new AngularInterceptorSummary(files,resolver).analyze();
  const client:FrontendClientContract={httpMethod:req.method,normalizedRoute:req.rawUrl,targetServiceId:'api',targetApiVersion:'v1',sourceFile:'api.ts',sourceLine:req.provenance.line,sourceSha256:req.provenance.callIdentity!.sourceSha256,callIdentity:req.provenance.callIdentity,requestBody:null,expectedResponse:req.expectedResponseType!,decoderKind:'INFERRED_TYPE',consumers:flow.consumers,responseUsage:flow.consumers.filter(c=>c.propertyPath?.startsWith('$')),consumerTraversalComplete:flow.complete,responseEffectsQualified:req.responseEffectsQualified===true&&effects.responseQualified,responseProjections:effects.responseProjections,unresolvedEvidence:flow.unresolved};
  return {files,extracted,flow,effects,client};
}
function backend(body:EndpointContract['body'],revision:string,complete=false):ContractArtifactEnvelope {
  return sealEnvelope({envelopeVersion:'SAJIMORA_CONTRACT_ARTIFACT_V1',reportSchemaVersion:'SAJIMORA_CROSS_LANGUAGE_IMPACT_V1',kind:'BACKEND_CONTRACT',snapshot:{repositoryId:'backend',serviceId:'api',apiVersion:'v1',parentCommit:'base',candidateSnapshot:revision},profile:{toolVersion:'test',configFingerprint:'same',frameworkProfile:'SPRING_MVC',codecProfile:'JACKSON_DEFAULT_V1'},completeness:{complete,unresolvedEndpoints:complete?[]:['unrelated endpoint requires declarations'],blockers:[]},payload:{baseUrls:[],proxyPrefixes:[],endpoints:[{identity:{service:'api',httpMethod:'GET',direction:'RESPONSE',normalizedRoute:normalizeRouteSegments('/x')},body,pathParameters:[],queryParameters:[],headers:[],provenance:{language:'JAVA',file:'Dto.java',line:1,sha256:createHash('sha256').update(revision).digest('hex')}}]}});
}
function target(client:FrontendClientContract):ContractArtifactEnvelope {
  return sealEnvelope({envelopeVersion:'SAJIMORA_CONTRACT_ARTIFACT_V1',reportSchemaVersion:'SAJIMORA_CROSS_LANGUAGE_IMPACT_V1',kind:'FRONTEND_CONTRACT',snapshot:{repositoryId:'frontend',serviceId:'web',apiVersion:'v1',parentCommit:'base',candidateSnapshot:'consumer'},profile:{toolVersion:'test',configFingerprint:null,clientProfile:'MULTI_CLIENT_V1'},completeness:{complete:false,unresolvedEndpoints:['unrelated missing dependency'],blockers:[]},payload:{clientContracts:[client]}});
}
const shape=(name:string)=>mkObjectWireType([{wireName:name,type:mkPrimitiveWireType('number'),optional:false,nullable:false,validationConstraints:[]}]);
const source=`import {HttpClient} from '@angular/common/http';interface Item {total:number;} function options(config?:any){if(!config){config={};}return {headers:{'Content-Type':'application/json'}};} class Api {constructor(private http:HttpClient){} read(){return this.http.get<Item>('/x',options());}} const api=new Api(null!);api.read().subscribe(item=>item.total.toFixed());`;

describe('integrated source-contract milestone',()=>{
  it('connects same-line exported call spans to the correct consumer origin',()=>{
    const result=exported(source);
    expect(result.flow.unresolved.some(r=>r.includes('identity'))).toBe(false);
    expect(result.flow.consumers).toEqual(expect.arrayContaining([expect.objectContaining({usage:'item.total',propertyPath:'$.total'})]));
    const sf=ts.createSourceFile('same.js','fetch("/a"); fetch("/b");',ts.ScriptTarget.Latest,true),calls:ts.CallExpression[]=[];
    sf.forEachChild(statement=>{if(ts.isExpressionStatement(statement)&&ts.isCallExpression(statement.expression))calls.push(statement.expression);});
    const graph=new ConsumerImpactGraph(new Map([['same.js',sf.text]]));
    expect(graph.analyzeCallConsumers('same.js',1,undefined,undefined,callIdentity(calls[1],'FETCH')).unresolved.some(r=>r.includes('identity'))).toBe(false);
    expect(graph.analyzeCallConsumers('same.js',1,undefined,undefined,{...callIdentity(calls[1],'FETCH'),sourceSha256:'0'.repeat(64)}).unresolved).toEqual(['INTERNAL_CALL_IDENTITY_DEFECT: source hash or AST span mismatch']);
  });
  it('proves a seeded consumed-field removal despite unrelated missing coverage',()=>{
    const result=exported(source),report=assessBackendChanges(backend(shape('total'),'base'),backend(shape('count'),'candidate'),[target(result.client)]);
    const finding=report.assessments.find(a=>a.status==='BREAK_PROVED');
    expect(finding?.witness?.path).toBe('$.total');
    expect(finding?.consumers).toEqual(expect.arrayContaining([expect.objectContaining({usage:'item.total.toFixed',operation:'PROPERTY_READ'})]));
    expect(report.coverage.completed).toBeGreaterThan(0);
    expect(report.coverage.pending).toBeGreaterThan(0);
  });
  it('does not label an untouched or coordinated safe control as a break',()=>{
    const result=exported(source);
    expect(assessBackendChanges(backend(shape('total'),'base'),backend(shape('total'),'candidate'),[target(result.client)]).assessments).toEqual([]);
    const optional={...shape('total'),properties:[...shape('total').properties,{wireName:'extra',type:mkPrimitiveWireType('string'),optional:true,nullable:false,validationConstraints:[]}]};
    expect(assessBackendChanges(backend(shape('total'),'base'),backend(optional,'candidate'),[target(result.client)]).coverage.breaks).toBe(0);
  });
  it('completes a narrowed source-contract check without a global preserved claim',()=>{
    const result=exported(source.replace('total:number','total:number|string').replace('toFixed','toString')),number=shape('total');
    const before={...number,properties:[{...number.properties[0],type:{kind:'UNION' as const,types:[mkPrimitiveWireType('number'),mkPrimitiveWireType('string')]}}]};
    const report=assessBackendChanges(backend(before,'base'),backend(number,'candidate'),[target(result.client)]);
    expect(report.assessments.find(a=>a.status==='COMPATIBILITY_PROVED_IN_SCOPE')?.checkedScope).toEqual(['declared response obligation $.total']);
  });
  it('does not complete incompatible array elements or unknown projection paths',()=>{
    const result=exported(source.replace('interface Item {total:number;}','type Item=number[];').replace('item.total.toFixed()','item[0].toFixed()')),before={kind:'ARRAY' as const,elementType:mkPrimitiveWireType('number')},after={kind:'ARRAY' as const,elementType:mkPrimitiveWireType('string')};
    const report=assessBackendChanges(backend(before,'base'),backend(after,'candidate'),[target(result.client)]);
    expect(report.coverage.breaks).toBe(1);
    expect(report.assessments[0].witness?.path).toBe('$[]');
    const unknown=assessBackendChanges(backend(shape('total'),'base'),backend({kind:'UNKNOWN',reason:'external data'},'candidate'),[target(result.client)]);
    expect(unknown.coverage.completed).toBe(0);
  });
  it('does not prove an element-type break from a consumer that only reads array length',()=>{
    const result=exported(source.replace('interface Item {total:number;}','type Item=number[];').replace('item.total.toFixed()','item.length'));
    const before={kind:'ARRAY' as const,elementType:mkPrimitiveWireType('number')},after={kind:'ARRAY' as const,elementType:mkPrimitiveWireType('string')};
    expect(assessBackendChanges(backend(before,'base'),backend(after,'candidate'),[target(result.client)]).coverage.breaks).toBe(0);
  });
  it('keeps an exhausted consumer source budget visible and incomplete',()=>{
    const result=exported(source),graph=new ConsumerImpactGraph(result.files,{roots:['api.ts'],maxFiles:0});
    const flow=graph.analyzeCallConsumers('api.ts',1,undefined,undefined,result.client.callIdentity);
    expect(flow.complete).toBe(false);
    expect(flow.unresolved.some(reason=>reason.includes('budget'))).toBe(true);
  });
  it('keeps a source-defined response-renaming interceptor pending',()=>{
    const providers=`import {HTTP_INTERCEPTORS} from '@angular/common/http';class Rename {intercept(req:any,next:any){return next.handle(req).pipe(map(event=>event.clone({body:{count:event.body.total}})));}} const providers=[{provide:HTTP_INTERCEPTORS,useClass:Rename,multi:true}];`;
    const result=exported(source,new Map([['providers.ts',providers]]));
    expect(result.effects.responseQualified).toBe(false);
    expect(assessBackendChanges(backend(shape('total'),'base'),backend(shape('count'),'candidate'),[target(result.client)]).coverage.breaks).toBe(0);
  });
  it('summarizes a pinned guarded interceptor projection and assesses the transformed body',()=>{
    const providers=`import {HTTP_INTERCEPTORS,HttpResponse} from '@angular/common/http';import {map} from 'rxjs/operators';class Rename{intercept(req:any,next:any){return next.handle(req).pipe(map(event=>event instanceof HttpResponse?event.clone({body:{label:event.body.total}}):event));}} const providers=[{provide:HTTP_INTERCEPTORS,useClass:Rename,multi:true}];`;
    const files=new Map([['providers.ts',providers],['node_modules/rxjs/package.json','{"name":"rxjs","version":"7.8.2"}'],['node_modules/rxjs/operators/index.d.ts','export declare function map(project:any):any;']]);
    const renamedSource=source.replace('total:number','label:number').replace('item.total.toFixed','item.label.toFixed');
    const result=exported(renamedSource,files);
    expect(result.effects.responseQualified).toBe(true);
    const report=assessBackendChanges(backend(shape('total'),'base'),backend(shape('count'),'candidate'),[target(result.client)]);
    expect(report.assessments).toEqual(expect.arrayContaining([expect.objectContaining({status:'BREAK_PROVED',witness:expect.objectContaining({path:'$.label'})})]));
  });
  it('traces component assignments to external template reads without claiming complete templates',()=>{
    const component=`import {HttpClient} from '@angular/common/http';import {Component} from '@angular/core';interface Item{total:number;} @Component({templateUrl:'./view.html'})class View{data:any;constructor(private http:HttpClient){}load(){this.http.get<Item>('/x').subscribe(value=>this.data=value);}}`;
    const result=exported(component,new Map([['view.html','<b>{{ data.total }}</b>']]));
    expect(result.flow.consumers).toEqual(expect.arrayContaining([expect.objectContaining({file:'view.html',propertyPath:'$.total'})]));
    expect(result.flow.complete).toBe(false);
  });
  it('preserves origin paths through a pinned imported RxJS projection alias',()=>{
    const stream=`import {HttpClient} from '@angular/common/http';import {map as project} from 'rxjs/operators';interface Item{total:number;}class Api{constructor(private http:HttpClient){}read(){this.http.get<Item>('/x').pipe(project(value=>value.total)).subscribe(total=>total.toFixed());}}`;
    const files=new Map([['node_modules/rxjs/package.json','{"name":"rxjs","version":"7.8.2","types":"index.d.ts"}'],['node_modules/rxjs/operators/index.d.ts','export declare function map(project:any):any;']]);
    const result=exported(stream,files);
    expect(result.flow.consumers).toEqual(expect.arrayContaining([expect.objectContaining({usage:'value.total',propertyPath:'$.total'}),expect.objectContaining({usage:'total.toFixed',propertyPath:'$.total.toFixed'})]));
    expect(result.flow.unresolved.some(r=>r.includes('Unqualified RxJS operator'))).toBe(false);
  });
});
