import { describe, it, expect, vi } from 'vitest';
import * as ts from 'typescript';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ConsumerImpactGraph } from '../../../src/sajimora/cross-language/ConsumerImpactGraph';
import { FourWayCompatibilityEngine } from '../../../src/sajimora/cross-language/FourWayCompatibilityEngine';
import { analyzeCrossLanguageImpact } from '../../../src/sajimora/cross-language/CrossLanguageImpactAnalyzer';
import { compareDirectionalWire } from '../../../src/sajimora/cross-language/DirectionalWireCompatibility';
import { MultiClientAdapter } from '../../../src/sajimora/cross-language/HttpClientAdapters';
import { TypeScriptContractParser } from '../../../src/sajimora/cross-language/TypeScriptContractParser';
import { UrlConstantResolver } from '../../../src/sajimora/cross-language/UrlConstantResolver';
import { normalizeRouteSegments } from '../../../src/sajimora/cross-language/EndpointIdentity';
import { EndpointContract, WireType, WirePropertyContract, mkPrimitiveWireType as scalar, mkArrayWireType as array, mkObjectWireType as object } from '../../../src/sajimora/cross-language/CanonicalContractIR';
import { JavaSealedCompilerHost } from '../../../src/sajimora/languages/java/programs/JavaSealedCompilerHost';
import { JavaWireModelEngine } from '../../../src/sajimora/cross-language/JavaWireModelEngine';
import { captureSnapshotPair } from '../../../src/sajimora/cross-language/CrossLanguageSnapshotPair';
import { GitRepository } from '../../../src/sajimora/snapshots/GitRepository';

const property = (wireName: string, type: WireType, extras: Partial<WirePropertyContract> = {}): WirePropertyContract => ({ wireName, type, optional: false, nullable: false, validationConstraints: [], ...extras });
const endpoint = (body: WireType | null, direction: 'REQUEST' | 'RESPONSE' = 'RESPONSE', file = 'client.ts', service: string | null = null): EndpointContract => ({ identity: { service, httpMethod: 'POST', normalizedRoute: normalizeRouteSegments('/users'), direction }, body, pathParameters: [], queryParameters: [], headers: [], provenance: { language: file.endsWith('.java') ? 'JAVA' : 'TYPESCRIPT', file, line: 1 } });
function engine(parent: WireType, candidate: WireType, expected: WireType | null, direction: 'REQUEST' | 'RESPONSE' = 'RESPONSE') {
  return new FourWayCompatibilityEngine().analyze({ parentJavaEndpoints: [endpoint(parent, direction, 'Controller.java')], candidateJavaEndpoints: [endpoint(candidate, direction, 'Controller.java')], parentTsRequests: [], candidateTsRequests: [endpoint(expected, direction)], candidateConsumerGraph: new ConsumerImpactGraph(new Map()) });
}
function adapters(text: string, additional = new Map<string, string>()) {
  const files = new Map([...additional, ['client.ts', text]]);
  return new MultiClientAdapter().extractRequests(ts.createSourceFile('client.ts', text, ts.ScriptTarget.Latest, true), new UrlConstantResolver(files), new TypeScriptContractParser(files));
}
const javaFiles = (dto: string) => new Map([['Controller.java', 'package demo;\n@RestController\npublic class Controller {\n@GetMapping("/users")\npublic User getUser() { return null; }\n}'], ['User.java', dto]]);
const identity = { repositoryId: 'fixture', parentCommit: 'parent', candidateSnapshot: 'candidate' };
function analyze(parentJavaFiles: Map<string, string>, candidateJavaFiles: Map<string, string>, candidateTsFiles: Map<string, string>, configs: { parentConfigFiles?: Map<string, string>; candidateConfigFiles?: Map<string, string> } = {}) {
  return analyzeCrossLanguageImpact({ identity, parentJavaFiles, candidateJavaFiles, parentTsFiles: candidateTsFiles, candidateTsFiles, ...configs });
}
function wire(files: Map<string, string>, name = 'demo.User') {
  const host = new JavaSealedCompilerHost({ trackedFiles: [...files.keys()], readTextFile: p => files.get(p) });
  return new JavaWireModelEngine(host).extractWireType(name);
}

describe('directional contract acceptance', () => {
  it('detects TS-only primitive incompatibility', () => expect(engine(scalar('number'), scalar('number'), scalar('string')).verdict).toBe('LIKELY_VIOLATED'));
  it('detects object/scalar response incompatibility', () => expect(engine(object([]), object([]), scalar('string')).verdict).toBe('LIKELY_VIOLATED'));
  it('detects absent candidate-required properties even absent in Java parent', () => expect(engine(object([]), object([]), object([property('id', scalar('number'))])).verdict).toBe('LIKELY_VIOLATED'));
  it('detects nested and array changes', () => expect(engine(array(object([property('id', scalar('number'))])), array(object([property('id', scalar('string'))])), array(object([property('id', scalar('number'))]))).findings[0].wirePath).toBe('$[*].id'));
  it('accepts coordinated candidate type repair', () => expect(engine(scalar('number'), scalar('string'), scalar('string')).verdict).toBe('LIKELY_PRESERVED'));
  it('conserves comparison-budget exhaustion', () => {
    let type:WireType=scalar('number');for(let i=0;i<90;i++)type=array(type);
    expect(compareDirectionalWire(type,type).unresolved.some(message=>message.includes('budget'))).toBe(true);
  });
  it('does not preserve missing request bodies', () => expect(engine(object([]), object([]), null, 'REQUEST').verdict).toBe('INCONCLUSIVE'));
  it('does not skip scalar requests', () => expect(engine(scalar('number'), scalar('number'), scalar('string'), 'REQUEST').verdict).toBe('LIKELY_VIOLATED'));
  it('detects array/scalar requests', () => expect(engine(array(scalar('number')), array(scalar('number')), scalar('number'), 'REQUEST').verdict).toBe('LIKELY_VIOLATED'));
  it('does not preserve nested unknown domains', () => expect(engine(object([]), object([property('id', { kind: 'UNKNOWN', reason: 'fixture' })]), object([property('id', scalar('number'))])).verdict).toBe('INCONCLUSIVE'));
  it('checks optional and nullable request values', () => {
    const required = object([property('id', scalar('number'))]);
    const possible = object([property('id', scalar('number'), { optional: true, nullable: true })]);
    expect(engine(required, required, possible, 'REQUEST').verdict).toBe('LIKELY_VIOLATED');
  });
  it('checks nullable responses and accepts a nullable expectation', () => {
    const source = object([property('name', scalar('string'), { nullable: true })]);
    expect(engine(source, source, object([property('name', scalar('string'))])).verdict).toBe('LIKELY_VIOLATED');
    expect(engine(source, source, source).verdict).toBe('LIKELY_PRESERVED');
  });
  it('conserves unknown validation obligations', () => {
    const java = object([property('age', scalar('number'), { validationConstraints: [{ kind: 'MIN', value: 10 }] })]);
    expect(engine(java, java, object([property('age', scalar('number'))]), 'REQUEST').verdict).toBe('INCONCLUSIVE');
    expect(engine(java, java, object([property('age', { kind: 'LITERAL', value: 2 })]), 'REQUEST').verdict).toBe('LIKELY_VIOLATED');
  });
  it('supports literal, enum, union, and nullable acceptance direction', () => {
    expect(compareDirectionalWire({ kind: 'ENUM', values: ['a', 'b'] }, scalar('string')).mismatches).toEqual([]);
    expect(compareDirectionalWire(scalar('string'), { kind: 'ENUM', values: ['a'] }).mismatches).toHaveLength(1);
    expect(compareDirectionalWire(scalar('string'), { kind: 'UNION', types: [scalar('number'), scalar('string')] }).unresolved).toEqual([]);
    expect(compareDirectionalWire({ kind: 'NULLABLE', innerType: scalar('number') }, scalar('number')).mismatches).toHaveLength(1);
  });
  it('checks all legitimate clients instead of treating them as ambiguity', () => {
    const java = endpoint(scalar('number'), 'RESPONSE', 'Controller.java');
    const result = new FourWayCompatibilityEngine().analyze({ parentJavaEndpoints: [java], candidateJavaEndpoints: [java], parentTsRequests: [], candidateTsRequests: [endpoint(scalar('number')), endpoint(scalar('string'), 'RESPONSE', 'other.ts')], candidateConsumerGraph: new ConsumerImpactGraph(new Map()) });
    expect(result.verdict).toBe('LIKELY_VIOLATED'); expect(result.blockers).toEqual([]);
  });
  it('blocks ambiguous backend service ownership', () => {
    const java = [endpoint(scalar('number'), 'RESPONSE', 'A.java', 'a'), endpoint(scalar('number'), 'RESPONSE', 'B.java', 'b')];
    const result = new FourWayCompatibilityEngine().analyze({ parentJavaEndpoints: java, candidateJavaEndpoints: java, parentTsRequests: [], candidateTsRequests: [endpoint(scalar('number'))], candidateConsumerGraph: new ConsumerImpactGraph(new Map()) });
    expect(result.verdict).toBe('INCONCLUSIVE'); expect(result.blockers[0].code).toBe('AMBIGUOUS_ENDPOINT');
  });
});

describe('receiver identity and completeness', () => {
  const files = new Map([['client.ts', 'export interface User { name: string }; export function stale(u:User){return u.displayName;}'], ['view.ts', "import {User as ApiUser} from './client'; export function stale(u:ApiUser){ const alias=u; return alias['displayName']; }"], ['other.ts', 'interface User {displayName:string}; const other:User={displayName:"ok"}; console.log(other.displayName);']]);
  it('includes same-file stale consumers and follows imported aliases/value aliases', () => {
    const result = new ConsumerImpactGraph(files).analyzePropertyConsumers('User', 'displayName', 'client.ts');
    expect(result.complete).toBe(true); expect(result.consumers.map(c => c.file).sort()).toEqual(['client.ts', 'view.ts']);
  });
  it('does not label unrelated same-name types as consumers', () => expect(new ConsumerImpactGraph(files).findPropertyConsumers('User', 'displayName', 'client.ts').some(c => c.file === 'other.ts')).toBe(false));
  it('marks unresolved receivers as incomplete, not proven broken consumers', () => {
    const result = new ConsumerImpactGraph(new Map([...files, ['unknown.ts', 'declare const dynamic:any; dynamic.displayName;']])).analyzePropertyConsumers('User', 'displayName', 'client.ts');
    expect(result.complete).toBe(false); expect(result.consumers.some(c => c.file === 'unknown.ts')).toBe(false);
  });
  it('detects destructuring from the imported target', () => {
    const graph = new ConsumerImpactGraph(new Map([...files, ['destructure.ts', "import {User} from './client'; export function view(u:User){const {displayName: old}=u;return old;}"]]));
    expect(graph.findPropertyConsumers('User', 'displayName', 'client.ts').some(c => c.consumerKind === 'DESTRUCTURING')).toBe(true);
  });
});

describe('canonical pipeline extraction', () => {
  const dto = 'package demo;\npublic class User {\npublic int userAge;\n}';
  const client = new Map([['client.ts', 'interface User {userAge:number}; async function read(){const r=await fetch("/users");const data:User=await r.json();return data;}']]);
  it('uses both sealed Jackson naming configurations and binds real evidence hashes', () => {
    const result = analyze(javaFiles(dto), javaFiles(dto), client, { parentConfigFiles: new Map([['application.properties', 'spring.jackson.property-naming-strategy=LOWER_CAMEL_CASE']]), candidateConfigFiles: new Map([['application.properties', 'spring.jackson.property-naming-strategy=SNAKE_CASE']]) });
    expect(result.verdict).toBe('LIKELY_VIOLATED'); expect(result.findings[0].wirePath).toBe('$.userAge');
    expect(result.scope.parentConfigurationFingerprint).not.toBe(result.scope.candidateConfigurationFingerprint);
    expect(result.findings[0].evidence.every(e => /^[a-f0-9]{64}$/.test(e.sha256))).toBe(true);
  });
  it('gates preservation on extraction blockers', () => {
    const result = analyze(javaFiles(dto), javaFiles(dto.replace('public class User', '@JsonSerialize(using=Custom.class)\npublic class User')), client);
    expect(result.verdict).toBe('INCONCLUSIVE'); expect(result.scope.complete).toBe(false);
  });
  it('scopes YAML naming to spring.jackson and conserves other mapper settings', () => {
    const configured = analyze(javaFiles(dto), javaFiles(dto), client, { candidateConfigFiles: new Map([['application.yml', 'spring:\n  jackson:\n    property-naming-strategy: SNAKE_CASE']]) });
    expect(configured.verdict).toBe('LIKELY_VIOLATED');
    const unrelated = analyze(javaFiles(dto), javaFiles(dto), client, { candidateConfigFiles: new Map([['application.yml', 'other:\n  property-naming-strategy: SNAKE_CASE']]) });
    expect(unrelated.verdict).toBe('LIKELY_PRESERVED');
    const unsupported = analyze(javaFiles(dto), javaFiles(dto), client, { candidateConfigFiles: new Map([['application.yml', 'spring:\n  jackson:\n    serialization:\n      write-dates-as-timestamps: false']]) });
    expect(unsupported.verdict).toBe('INCONCLUSIVE');
  });
  it('discovers default-package controllers', () => {
    const parent = new Map([...javaFiles(dto)].map(([file, text]) => [file, text.replace('package demo;\n', '')]));
    const candidate = new Map(parent); candidate.set('User.java', 'public class User {\npublic int age;\n}');
    expect(analyze(parent, candidate, client).verdict).toBe('LIKELY_VIOLATED');
  });
  it('checks compact controllers structurally and rejects a scalar response where an object is required', () => {
    const files = new Map([['Controller.java', '@RestController public class Controller { @GetMapping("/users") public int get(){return 1;} }']]);
    expect(analyze(files, files, client).verdict).toBe('LIKELY_VIOLATED');
  });
  it('does not preserve client calls without any backend ownership', () => expect(analyze(new Map(), new Map(), client).verdict).toBe('INCONCLUSIVE'));
  it('does not preserve unexamined unchanged backend contracts', () => expect(analyze(javaFiles(dto),javaFiles(dto),new Map([['client.ts','this.wrapper.get("/users");']])).verdict).toBe('INCONCLUSIVE'));
  it('conserves duplicate DTO ownership across modules', () => {
    const files=new Map([...javaFiles(dto), ['other/User.java',dto.replace('int userAge','String userAge')]]);
    const result=analyze(files,files,client);expect(result.scope.complete).toBe(false);expect(result.blockers.some(b=>b.code==='AMBIGUOUS_WIRE_PROPERTY')).toBe(true);
  });
  it('ignores serializer comments and unrelated inner-class annotations', () => {
    expect(wire(new Map([['User.java', 'package demo;\n// @JsonSerialize(using=Custom.class)\npublic class User {\npublic int age;\n}']])).blockers).toEqual([]);
    expect(wire(new Map([['User.java', 'package demo;\npublic class User {\npublic int age;\n@JsonSerialize(using=Custom.class)\nclass Inner {\npublic int value;\n}\n}']])).blockers).toEqual([]);
  });
  it('supports legacy Jackson naming and inherited field overrides', () => {
    const files = new Map([['Base.java', 'package demo;\npublic class Base {\npublic int displayName;\n}'], ['User.java', 'package demo;\n@JsonNaming(PropertyNamingStrategy.SnakeCaseStrategy.class)\npublic class User extends Base {\npublic String displayName;\n}']]);
    const result = wire(files); expect(result.blockers).toEqual([]);
    expect(result.wireType.kind).toBe('OBJECT');
    if (result.wireType.kind === 'OBJECT') expect(result.wireType.properties.some(p => p.wireName === 'display_name')).toBe(true);
    const override = wire(new Map([...files, ['User.java', 'package demo;\npublic class User extends Base {\npublic String displayName;\n}']]));
    if (override.wireType.kind === 'OBJECT') expect(override.wireType.properties[0].type).toMatchObject({ kind: 'PRIMITIVE', scalar: 'string' });
  });
  it('keeps ordinary primitive request fields optional and scopes parameter annotations', () => {
    const files = new Map([['Controller.java', 'package demo;\n@RestController\npublic class Controller {\n@PostMapping("/users")\npublic void create(@RequestBody User body, @RequestParam String search) {}\n}'], ['User.java', 'package demo;\npublic class User {\npublic int id;\n@NotNull\npublic String email;\n}']]);
    const host = new JavaSealedCompilerHost({ trackedFiles: [...files.keys()], readTextFile: p => files.get(p) });
    const result = new JavaWireModelEngine(host).extractControllerEndpoints(host.getClassByFQCN('demo.Controller')!);
    const request = result.endpoints.find(e => e.identity.direction === 'REQUEST')!;
    expect(request.queryParameters.map(p => p.name)).toEqual(['search']);
    if (request.body?.kind === 'OBJECT') expect(request.body.properties.every(p => p.optional)).toBe(true);
  });
  it('conserves recursive DTO uncertainty instead of empty objects', () => {
    const result = wire(new Map([['User.java', 'package demo;\npublic class User {\npublic User parent;\n}']]));
    expect(result.blockers.some(b => b.code === 'UNRESOLVED_JAVA_GENERIC')).toBe(true);
  });
});

describe('HTTP adapters and source resolution', () => {
  it('extracts typed function-parameter payloads and inline literal payloads', () => {
    const result = adapters('import axios from "axios"; interface Payload{id:number}; function save(p:Payload){fetch("/users",{method:"POST",body:JSON.stringify(p)});axios.post("/users",{id:1});}');
    expect(result.requests).toHaveLength(2); expect(result.requests.every(r => r.requestBodyType?.kind === 'OBJECT')).toBe(true);
  });
  it('respects payload shadowing', () => {
    const result = adapters('interface Payload{id:number};const p:Payload={id:1};function save(p:unknown){fetch("/users",{method:"POST",body:JSON.stringify(p)});}');
    expect(result.requests[0].requestBodyType).toMatchObject({ kind: 'PRIMITIVE', scalar: 'any' });
  });
  it('extracts Angular as Angular and refuses receiver-substring Axios admission', () => {
    const result = adapters('import {HttpClient} from "@angular/common/http"; interface User{id:number};class Client {constructor(private http:HttpClient){}read(){return this.http.get<User>("/users");}};const api={get:(x:string)=>x};api.get("/unrelated");');
    expect(result.requests).toHaveLength(1); expect(result.requests[0].clientKind).toBe('ANGULAR');
  });
  it('checks Axios import aliases, instances, base URLs, and lexical shadowing', () => {
    const result = adapters('import request from "axios";interface User{id:number};const api=request.create({baseURL:"https://example.com/api"});api.get<User>("/users");function unrelated(request:any){request.get("/ignored");}');
    expect(result.requests).toHaveLength(1); expect(result.requests[0].rawUrl).toBe('https://example.com/api/users');
    expect(result.requests[0].route.segments.map(s => s.text)).toEqual(['api','users']);
  });
  it('does not infer JSON DTOs from raw fetch Response annotations', () => expect(adapters('interface User{id:number};const r:User=await fetch("/users");').requests[0].expectedResponseType).toBeNull());
  it('fails closed on dynamic fetch options', () => expect(adapters('const options={method:"POST"};fetch("/users",options);').blockers.some(b => b.code === 'UNSUPPORTED_CLIENT_WRAPPER')).toBe(true));
  it('propagates object-form query expectations through imported decoded functions', () => {
    const result = adapters('import {useQuery} from "@tanstack/react-query";import {read} from "./query";interface User{id:number};useQuery<User>({queryKey:["cache-key"],queryFn:read});', new Map([['query.ts', 'export async function read(){const r=await fetch("/users");return r.json();}']]));
    expect(result.requests).toHaveLength(1); expect(result.requests[0].clientKind).toBe('TANSTACK_QUERY'); expect(result.requests[0].expectedResponseType?.kind).toBe('OBJECT'); expect(result.requests[0].rawUrl).toBe('/users');
  });
  it('does not use query keys as routes or apply DTO expectations to raw Responses', () => {
    const result = adapters('import {useQuery} from "@tanstack/react-query";interface User{id:number};useQuery<User>({queryKey:["/wrong"],queryFn:()=>fetch("/users")});');
    expect(result.requests.map(r => r.rawUrl)).toEqual(['/users']); expect(result.requests[0].expectedResponseType).toBeNull();
  });
  it('follows named barrel type exports and conserves unsupported alias mappings', () => {
    const parser = new TypeScriptContractParser(new Map([['dto.ts','export interface User{id:number}'], ['barrel.ts', 'export {User as Person} from "./dto";'], ['client.ts', 'import {Person as ApiUser} from "./barrel";']]));
    expect(parser.parseTypeByName('ApiUser','client.ts').wireType.kind).toBe('OBJECT'); expect(parser.parseTypeByName('User','client.ts').wireType.kind).toBe('UNKNOWN');
  });
  it('parses array, null, undefined and interface inheritance without treating null as any', () => {
    const parser = new TypeScriptContractParser(new Map([['client.ts', 'interface Base{id:number};interface User extends Base{name:string|null;age:number|undefined;}']]));
    const type = parser.parseTypeByName('User[]','client.ts').wireType;
    expect(type.kind).toBe('ARRAY'); if(type.kind==='ARRAY' && type.elementType.kind==='OBJECT'){expect(type.elementType.properties.map(p => p.wireName)).toEqual(['id','name','age']);expect(type.elementType.properties[1].nullable).toBe(true);expect(type.elementType.properties[2].optional).toBe(true);}
  });
  it('resolves URL import identity and preserves protocols without global-name fallback', () => {
    const files = new Map([['wrong.ts','export const ROUTE="/wrong";'], ['routes.ts','export const ROUTE="https://example.com";'], ['client.ts', 'import {ROUTE as API} from "./routes";fetch(API+"/users");fetch(ROUTE);']]);
    const result = new MultiClientAdapter().extractRequests(ts.createSourceFile('client.ts',files.get('client.ts')!,ts.ScriptTarget.Latest,true), new UrlConstantResolver(files),new TypeScriptContractParser(files));
    expect(result.requests[0].rawUrl).toBe('https://example.com/users');expect(result.requests[1].rawUrl).toBe('<dynamic>');expect(result.blockers).toHaveLength(1);
  });
  it('blocks dynamic template prefixes instead of claiming a static route', () => expect(adapters('fetch(`${getBase()}/users`);').blockers.some(b => b.code === 'DYNAMIC_URL')).toBe(true));
  it('does not resolve shadowed URL parameters to unrelated constants', () => {
    const result=adapters('const route="/users";function read(route:string){fetch(route);}');
    expect(result.requests[0].rawUrl).toBe('<dynamic>');expect(result.blockers[0].code).toBe('DYNAMIC_URL');
  });
  it('does not admit imports of non-exported declarations', () => {
    const parser = new TypeScriptContractParser(new Map([['dto.ts','interface User{id:number}'], ['client.ts', 'import {User} from "./dto";']]));
    expect(parser.parseTypeByName('User','client.ts').wireType.kind).toBe('UNKNOWN');
  });
  it('keeps unsupported object schema modifiers unresolved', () => {
    const parser = new TypeScriptContractParser(new Map([['client.ts','const Schema=z.object({id:z.number()}).refine(val=>val);']]));
    const result=parser.parseTypeByName('Schema','client.ts');expect(result.wireType.kind).toBe('UNKNOWN');expect(result.blockers).not.toEqual([]);
  });
  it('does not propagate a hook generic across mixed decoded/raw returns', () => {
    const result = adapters('import {useQuery} from "@tanstack/react-query";interface User{id:number};useQuery<User>({queryKey:["users"],queryFn:async()=>{const r=await fetch("/users");if(flag)return r.json();return r;}});');
    expect(result.requests[0].expectedResponseType).toBeNull();
  });
  it('accepts nullable union and split enum domain coverage', () => {
    expect(compareDirectionalWire({kind:'ENUM',values:['a','b']},{kind:'UNION',types:[{kind:'LITERAL',value:'a'},{kind:'LITERAL',value:'b'}]}).mismatches).toEqual([]);
    expect(compareDirectionalWire({kind:'NULLABLE',innerType:scalar('number')},{kind:'UNION',types:[scalar('string'),{kind:'NULLABLE',innerType:scalar('number')}]}).mismatches).toEqual([]);
  });
});

async function inRepository(fn: (root: string, repository: GitRepository, parentCommit: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-review-regression-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
  try {
    git('init');git('config','user.name','Regression');git('config','user.email','regression@example.invalid');
    fs.writeFileSync(path.join(root,'a.ts'),'export const a=1;');fs.writeFileSync(path.join(root,'b.ts'),'export const b=1;');git('add','.');git('commit','-m','baseline');
    await fn(root, new GitRepository(root), git('rev-parse','HEAD'));
  } finally { vi.restoreAllMocks(); syncBuiltinESMExports(); removeTempDirectory(root); }
}
function removeTempDirectory(directory: string) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir())) throw new Error('Unexpected temporary-directory boundary');
  fs.rmSync(resolved, { recursive: true, force: true });
}
describe('working-tree snapshot hardening', () => {
  it('admits untracked files and treats unstaged deletions as absence', async () => inRepository(async(root,repository,parentCommit) => {
    fs.unlinkSync(path.join(root,'a.ts'));fs.writeFileSync(path.join(root,'new.ts'),'export const added=1;');
    const result = await captureSnapshotPair({repository,parentCommit,candidate:{kind:'working-tree'}});
    expect(result.blockers).toEqual([]);expect(result.changedPaths.added).toContain('new.ts');expect(result.changedPaths.deleted).toContain('a.ts');
    const trackedOnly = await captureSnapshotPair({repository,parentCommit,candidate:{kind:'working-tree'},includeUntracked:false});expect(trackedOnly.candidateFiles.has('new.ts')).toBe(false);
  }));
  it('rejects a junction ancestor before reading external bytes', async () => inRepository(async(root,repository,parentCommit) => {
    const outside=fs.mkdtempSync(path.join(os.tmpdir(),'cross-review-outside-'));
    try {
      fs.writeFileSync(path.join(outside,'leak.ts'),'external bytes');fs.symlinkSync(outside,path.join(root,'linked'),process.platform==='win32'?'junction':'dir');
      const blob=execFileSync('git',['-C',root,'hash-object','-w','--stdin'],{input:'placeholder',encoding:'utf8'}).trim();
      execFileSync('git',['-C',root,'update-index','--add','--cacheinfo',`100644,${blob},linked/leak.ts`]);
      const result=await captureSnapshotPair({repository,parentCommit,candidate:{kind:'working-tree'}});
      expect(result.blockers.some(b=>b.code==='UNSAFE_FILE_PATH')).toBe(true);expect(result.candidateFiles.has('linked/leak.ts')).toBe(false);
    } finally { fs.unlinkSync(path.join(root,'linked'));removeTempDirectory(outside); }
  }));
  it('detects earlier files changing while later files are captured', async () => inRepository(async(root,repository,parentCommit) => {
    const original=fs.readFileSync;let changed=false;
    vi.spyOn(fs,'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor,...args: unknown[])=>{
      if(file===path.join(root,'b.ts')&&!changed){changed=true;fs.writeFileSync(path.join(root,'a.ts'),'export const a=2;');}
      return (original as Function)(file,...args);
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();
    const result=await captureSnapshotPair({repository,parentCommit,candidate:{kind:'working-tree'}});
    expect(result.blockers.some(b=>b.code==='FILE_CHANGED_DURING_CAPTURE'&&b.file==='a.ts')).toBe(true);
  }));
  it('fails closed on JAX-RS Jersey resource with UNSUPPORTED_FRAMEWORK blocker instead of false PRESERVED', () => {
    const jaxFiles = new Map([
      ['JaxResource.java', 'package demo;\nimport javax.ws.rs.*;\n@Path("/users")\npublic class JaxResource {\n  @GET\n  @Produces("application/json")\n  public String getUser() { return "ok"; }\n}']
    ]);
    const tsFiles = new Map([
      ['client.ts', 'fetch("/users").then(r => r.json());']
    ]);
    const report = analyze(jaxFiles, jaxFiles, tsFiles);
    expect(report.verdict).toBe('INCONCLUSIVE');
    expect(report.scope.complete).toBe(false);
    expect(report.blockers.some(b => b.code === 'UNSUPPORTED_FRAMEWORK')).toBe(true);
    expect(report.blockers.find(b => b.code === 'UNSUPPORTED_FRAMEWORK')?.message).toContain('Spring MVC');
  });
});
