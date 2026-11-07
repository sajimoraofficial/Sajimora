import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { MultiClientAdapter } from '../../../src/sajimora/cross-language/HttpClientAdapters';
import { UrlConstantResolver } from '../../../src/sajimora/cross-language/UrlConstantResolver';
import { TypeScriptContractParser } from '../../../src/sajimora/cross-language/TypeScriptContractParser';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

function extract(sources: Record<string,string>, entry='src/calls.ts') {
  const files=new Map(Object.entries(sources));
  return new MultiClientAdapter().extractRequests(ts.createSourceFile(entry,files.get(entry)!,ts.ScriptTarget.Latest,true),new UrlConstantResolver(files),new TypeScriptContractParser(files));
}
const shared=`import axios from 'axios'; const api=axios.create({baseURL:'http://localhost:8080/api'}); export default api;`;
describe('sealed imported Axios instances',()=>{
  it('does not classify imported configuration keys as HTTP URLs',()=>{
    const result=extract({'src/calls.ts':"import config from 'config'; config.get('setting.key'); config.get(`logging.level`);"});
    expect(result.requests).toHaveLength(0);expect(result.blockers).toEqual([]);
  });
  it('resolves a default JS instance and typed body through a barrel alias',()=>{
    const result=extract({'src/axios.js':shared,'src/barrel.ts':"export {default as shared} from './axios.js';",'src/calls.ts':"import {shared as client} from './barrel'; interface Order {id:number}; client.get<Order>('/orders');"});
    expect(result.requests).toHaveLength(1);expect(result.requests[0].rawUrl).toBe('http://localhost:8080/api/orders');expect(result.requests[0].expectedResponseType?.kind).toBe('OBJECT');expect(result.blockers).toEqual([]);
  });
  it('supports named exported instances and their configuration constants',()=>{
    const result=extract({'src/config.ts':"export const HOST='http://service.test/api';",'src/axios.ts':"import axios from 'axios'; import {HOST} from './config'; export const client=axios.create({baseURL:HOST});",'src/calls.ts':"import {client as api} from './axios'; api.get('/orders');"});
    expect(result.requests[0].rawUrl).toBe('http://service.test/api/orders');
  });
  it('extracts JS/JSX calls without inventing response types',()=>{
    const result=extract({'src/axios.js':shared,'src/calls.jsx':"import api from './axios'; const ui=<div/>; api.get('/products');"},'src/calls.jsx');
    expect(result.requests).toHaveLength(1);expect(result.requests[0].expectedResponseType).toBeNull();
  });
  it('resolves an assertion on the exact response data binding',()=>{
    const result=extract({'src/axios.js':shared,'src/calls.ts':"import api from './axios'; type Order={id:number}; async function load(){const res=await api.get('/orders'); return res.data as Order[];}"});
    expect(result.requests[0].expectedResponseType?.kind).toBe('ARRAY');expect(result.requests[0].expectationKind).toBe('TYPE_ASSERTION');
  });
  it('qualifies literal credentials while retaining transform, spread and dynamic configuration warnings',()=>{
    for (const config of ['{withCredentials:true}', '{"withCredentials":false}', '{}']) {
      const result=extract({'src/axios.js':shared,'src/calls.ts':`import api from './axios';api.get('/orders',${config});api.post('/orders',undefined,${config});`});
      expect(result.requests).toHaveLength(2);expect(result.blockers).toEqual([]);
    }
    for (const config of ['{withCredentials:flag}', '{transformResponse:x=>x}', '{...options}', 'options', '{params:{page:1}}']) {
      const result=extract({'src/axios.js':shared,'src/calls.ts':`import api from './axios';api.get('/orders',${config});`});
      expect(result.blockers.map(b=>b.code)).toContain('UNSUPPORTED_CLIENT_WRAPPER');
    }
  });
  it('does not confuse a shadowed local receiver with the imported client',()=>{
    const result=extract({'src/axios.js':shared,'src/calls.ts':"import api from './axios'; function f(api:any){api.get('/fake');} api.get('/real');"});
    expect(result.requests.map(r=>r.rawUrl)).toEqual(['http://localhost:8080/api/real']);
  });
  it('reports unresolved imports and cycles instead of dropping HTTP-like calls',()=>{
    for(const sources of [{'src/calls.ts':"import api from './missing'; api.get('/orders');"},{'src/a.ts':"export {default} from './b';",'src/b.ts':"export {default} from './a';",'src/calls.ts':"import api from './a';api.get('/orders');"}] as Record<string,string>[]) {
      const result=extract(sources);expect(result.requests).toHaveLength(0);expect(result.blockers.map(b=>b.code)).toContain('UNRESOLVED_TS_CLIENT');
    }
  });
  it('retains uncertainty for dynamic base URLs and interceptors',()=>{
    const result=extract({'src/axios.js':"import axios from 'axios';const api=axios.create({baseURL:runtimeHost});api.interceptors.response.use(x=>x);export default api;",'src/calls.ts':"import api from './axios';api.get('/orders');"});
    expect(result.requests[0].rawUrl).toBe('<dynamic>');expect(result.blockers.map(b=>b.code)).toContain('UNSUPPORTED_CLIENT_WRAPPER');expect(result.blockers.map(b=>b.code)).toContain('DYNAMIC_URL');
  });
  it('does not use a nonexported lookalike or named Axios utility as a client',()=>{
    for(const sources of [{'src/private.ts':"import axios from 'axios';const api=axios.create();",'src/calls.ts':"import {api} from './private';api.get('/orders');"},{'src/calls.ts':"import {AxiosError as api} from 'axios';api.get('/orders');"}] as Record<string,string>[])expect(extract(sources).requests).toHaveLength(0);
  });
});

it('captures shared JavaScript modules and JSX call sites through the real exporter',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sajimora-imported-axios-'));
  const root=path.resolve(__dirname,'../../../../..');
  try {
    const sources={'frontend/src/axios.js':shared,'frontend/src/calls.ts':"import api from './axios';interface Order{id:number};api.get<Order>('/orders');",'frontend/src/view.jsx':"import api from './axios';const view=<div/>;api.get('/products');",'frontend/src-other/ignored.ts':"fetch('/outside-root')"};
    for(const [file,text] of Object.entries(sources)){fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.writeFileSync(path.join(dir,file),text);}
    execFileSync('git',['init','--quiet',dir]);
    execFileSync('git',['-C',dir,'add','.']);
    execFileSync('git',['-C',dir,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture']);
    const head=execFileSync('git',['-C',dir,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
    const stdout=execFileSync(process.execPath,[path.join(root,'scripts/test-runtime/run-tsx-command.cjs'),path.join(root,'scripts/sajimora/exportFrontendContract.ts'),'--repo',dir,'--parent',head,'--working-tree','--service-id','frontend','--target-service-id','backend','--ts-root','frontend/src'],{encoding:'utf8'});
    const envelope=JSON.parse(stdout);
    expect(envelope.payload.clientContracts.map((c:{normalizedRoute:string})=>c.normalizedRoute).sort()).toEqual(['http://localhost:8080/api/orders','http://localhost:8080/api/products']);
    expect(envelope.completeness.complete).toBe(false);
    expect(envelope.payload.clientContracts.some((c:{expectedResponse:{kind:string}})=>c.expectedResponse.kind==='UNKNOWN')).toBe(true);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
},30000);
