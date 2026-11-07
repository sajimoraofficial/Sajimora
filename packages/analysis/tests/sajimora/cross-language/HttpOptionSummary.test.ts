import {describe, it, expect} from 'vitest';
import * as ts from 'typescript';
import {AngularAdapter} from '../../../src/sajimora/cross-language/HttpClientAdapters';
import {UrlConstantResolver} from '../../../src/sajimora/cross-language/UrlConstantResolver';
import {TypeScriptContractParser} from '../../../src/sajimora/cross-language/TypeScriptContractParser';

function extract(options: string, helpers = '', extra = new Map<string, string>()) {
  const source = `import {HttpClient} from '@angular/common/http'; ${helpers}
    class Api {constructor(private http:HttpClient){} read(config:any){return this.http.get<string>('/items',${options});}}`;
  const files = new Map([...extra, ['api.ts', source]]);
  return new AngularAdapter().extractRequests(ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true), new UrlConstantResolver(files), new TypeScriptContractParser(files));
}
describe('bounded HTTP option helper summaries', () => {
  it('proves empty query builders from a pinned framework constructor and a transparent subclass',()=>{
    const extra=new Map([['node_modules/@angular/common/package.json','{"name":"@angular/common","version":"20.3.28","exports":{"./http":{"types":"./http/index.d.ts"}}}'],['node_modules/@angular/common/http/index.d.ts','export declare class HttpParams { constructor(options?:any); toString():string; }']]);
    const helper=`import {HttpParams} from '@angular/common/http'; class Params extends HttpParams {constructor(public metadata:any, params?:any){super({fromObject:params});}}`;
    expect(extract('{params:new Params(undefined)}',helper,extra).requests[0].httpOptionsEvidence?.queryParametersAbsent).toBe(true);
    for(const options of ['{params:new Params(undefined,{id:1})}','{...config, params:new Params(undefined)}'])expect(extract(options,helper,extra).requests[0].httpOptionsEvidence?.queryParametersAbsent).toBe(false);
    expect(extract('{params:new Params(undefined)}',helper.replace('super({fromObject:params});','super({fromObject:params}); escape(this);'),extra).requests[0].httpOptionsEvidence?.queryParametersAbsent).toBe(false);
    expect(extract('{params:new Params(undefined)}',helper.replace('}}','} toString(){return "page=1";}}'),extra).requests[0].httpOptionsEvidence?.queryParametersAbsent).toBe(false);
    expect(extract('{params:new Params(undefined)}',helper.replace('class Params','@decorate class Params'),extra).requests[0].httpOptionsEvidence?.queryParametersAbsent).toBe(false);
    expect(extract('{params:new Params(undefined)}',helper.replace('public metadata','public __proto__'),extra).requests[0].httpOptionsEvidence?.queryParametersAbsent).toBe(false);
    extra.set('node_modules/@angular/common/package.json','{"name":"@angular/common","version":"20.3.27","exports":{"./http":{"types":"./http/index.d.ts"}}}');
    expect(extract('{params:new Params(undefined)}',helper,extra).requests[0].httpOptionsEvidence?.queryParametersAbsent).toBe(false);
  });
  it('does not infer a bodyless request when options contain body data or unknown writes',()=>{
    expect(extract('{}').requests[0].httpOptionsEvidence?.requestBodyAbsent).toBe(true);
    for(const options of ['{body:{version:1}}','{...config,observe:"body",responseType:"json"}'])expect(extract(options).requests[0].httpOptionsEvidence?.requestBodyAbsent).toBe(false);
  });
  it('summarizes nested helpers, defaults and local constants', () => {
    const result = extract('outer()', `function inner(mode='json'){const options={responseType:mode};return options;} function outer(){return {...inner(),observe:'body'};}`);
    expect(result.blockers).toEqual([]);
    expect(result.requests[0].expectedResponseType).toMatchObject({kind:'PRIMITIVE',scalar:'string'});
  });
  it('resolves imported helpers from captured source', () => {
    const result = extract('settings()', `import {settings} from './options';`, new Map([['options.ts', `export function settings(){return {responseType:'text'};}`]]));
    expect(result.blockers).toEqual([]);
    expect(result.requests[0].expectedResponseType).toMatchObject({scalar:'string'});
  });
  it('honors ordered overwrites and retains acceptance obligations', () => {
    const result = extract(`{...config, observe:'body', responseType:'text'}`);
    expect(result.requests[0].expectedResponseType).toMatchObject({scalar:'string'});
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(extract(`{observe:'body',responseType:'text',...config}`).requests[0].expectedResponseType?.kind).toBe('UNKNOWN');
  });
  it('does not qualify a dynamic decoder, envelope or custom instance', () => {
    for (const options of [`{responseType:config.mode}`, `{observe:'events',responseType:'text'}`, 'opaque(config)']) {
      expect(extract(options).requests[0].expectedResponseType?.kind).toBe('UNKNOWN');
    }
    expect(extract(`helper()`, `function helper(){return {params:new CustomParams()};}`).blockers.length).toBeGreaterThan(0);
  });
  it('keeps header/parameter evidence requests after helper expansion', () => {
    const result = extract('helper()', `function helper(){return {headers:{Accept:'application/json'},params:{q:'x'}};}`);
    expect(result.blockers).toHaveLength(2);
    expect(result.blockers.every(b => b.message.includes('independent qualification'))).toBe(true);
  });
  it('retains decoder defaults through generic configuration and query-cleaning helpers',()=>{
    const result=extract('optionsFromConfig(config)',`
      import {HttpHeaders} from '@angular/common/http';
      function optionsFromConfig(config?:any){if(!config){config={};}return options(config.loading,config.errors,config.query);}
      function options(loading=false,errors=false,query?:any){const cleaned=clean(query);return {headers:new HttpHeaders({'Content-Type':'application/json'}),params:new CustomParams(loading,errors,cleaned)};}
      function clean(params?:any){if(!params){return undefined;}const entries=Object.entries(params);const cleaned=entries.filter(([_,value])=>value!==null&&value!==undefined);if(!cleaned.length){return undefined;}return Object.fromEntries(cleaned);}
    `);
    expect(result.requests[0].httpOptionsEvidence).toMatchObject({observe:'body',responseType:'json',decoderOptionsComplete:true});
    expect(result.requests[0].expectedResponseType).toMatchObject({kind:'PRIMITIVE',scalar:'string'});
    expect(result.requests[0].httpOptionsEvidence?.missingEvidence.some(reason=>reason.includes('CustomParams'))).toBe(true);
    expect(result.blockers.every(blocker=>blocker.message.includes('independent qualification'))).toBe(true);
  });
  it('retains a body obligation for a qualified response envelope',()=>{
    const result=extract("{observe:'response',responseType:'json'}");
    expect(result.requests[0].httpOptionsEvidence).toMatchObject({observe:'response',responseType:'json',decoderOptionsComplete:true});
    expect(result.requests[0].expectedResponseType).toMatchObject({kind:'PRIMITIVE',scalar:'string'});
    expect(result.blockers).toEqual([]);
  });
  it('rejects invalid transport modes instead of recording complete decoder facts',()=>{
    for(const options of ["{observe:'banana'}","{responseType:'banana'}"]){const result=extract(options);expect(result.requests[0].httpOptionsEvidence?.decoderOptionsComplete).toBe(false);expect(result.requests[0].expectedResponseType?.kind).toBe('UNKNOWN');}
  });
  it('does not execute or neutralize effects and recursion', () => {
    for (const helpers of [
      `function helper(){const options={responseType:'json'};const ignored=mutate(options);return options;}`,
      `function helper(){return helper();}`,
      `async function helper(){return {};}`,
      `function helper(){return {};} helper=unknownImplementation;`,
    ]) {
      const result = extract('helper()', helpers);
      expect(result.blockers.length).toBeGreaterThan(0);
      expect(result.requests[0].expectedResponseType?.kind).toBe('UNKNOWN');
    }
  });
  it('preserves plain-object alias identity when branching',()=>{
    const result=extract('helper(config.flag)',"function helper(flag:any){const options={responseType:'json'};const alias=options;if(flag){alias.responseType='text';}return options;}");
    expect(result.requests[0].httpOptionsEvidence?.decoderOptionsComplete).toBe(false);
    expect(result.requests[0].expectedResponseType?.kind).toBe('UNKNOWN');
  });
  it('does not replace a mutated captured constant with its initializer',()=>{
    const result=extract('settings',"const settings={responseType:'json'};settings.responseType='text';");
    expect(result.requests[0].httpOptionsEvidence?.decoderOptionsComplete).toBe(false);
    expect(result.requests[0].httpOptionsEvidence?.missingEvidence.join(' ')).toContain('reaching definitions');
  });
  it('summarizes captured constants and ordered local plain-object writes',()=>{
    const result=extract('helper()',"const mode='text'; function helper(){const options={responseType:'json'};options.responseType=mode;return options;}");
    expect(result.blockers).toEqual([]);expect(result.requests[0].httpOptionsEvidence?.responseType).toBe('text');
  });
  it('joins finite switch branches and applies Object.assign in overwrite order',()=>{
    const result=extract('helper(config)',"function helper(config:any){switch(config.mode){case 'a':return Object.assign({responseType:'text'},{responseType:'json'});default:return {responseType:'json'};}}");
    expect(result.requests[0].httpOptionsEvidence?.responseType).toBe('json');expect(result.blockers).toEqual([]);
    const conflicting=extract('helper(config)',"function helper(config:any){switch(config.mode){case 'a':return {responseType:'text'};default:return {responseType:'json'};}}");
    expect(conflicting.requests[0].httpOptionsEvidence?.decoderOptionsComplete).toBe(false);
  });
  it('keeps unrelated metadata uncertainty out of explicitly supplied decoder fields',()=>{
    const result=extract('helper(config)',"function helper(config:any){return {loading:spinner(config),observe:'body',responseType:'json'};}");
    expect(result.requests[0].httpOptionsEvidence?.decoderOptionsComplete).toBe(true);expect(result.requests[0].expectedResponseType?.kind).toBe('PRIMITIVE');
    const mutated=extract('helper()',"function helper(){const options={observe:'body',responseType:'json'};mutate(options);return options;}");
    expect(mutated.requests[0].httpOptionsEvidence?.decoderOptionsComplete).toBe(false);
  });
});
