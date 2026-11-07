import {describe,it,expect} from 'vitest';
import {TypeGraph,GraphNode,GraphProperty,validateTypeGraph,graphComponents,sealGraphArtifact,parseGraphArtifact} from '../../../src/sajimora/cross-language/RecursiveWireGraph';
import {graphInclusion} from '../../../src/sajimora/cross-language/GraphInclusion';
import {parseEnvelope} from '../../../src/sajimora/cross-language/ContractArtifactEnvelope';
import {TypeScriptGraphExtractor} from '../../../src/sajimora/cross-language/TypeScriptGraphExtractor';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve as resolvePath,join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
const number:GraphNode={kind:'PRIMITIVE',scalar:'number'},string:GraphNode={kind:'PRIMITIVE',scalar:'string'};
const ref=(typeId:string):GraphNode=>({kind:'REF',typeId});
const field=(wireName:string,type:GraphNode,optional=false):GraphProperty=>({wireName,type,optional,nullable:false,validationConstraints:[]});
const object=(properties:GraphProperty[]):GraphNode=>({kind:'OBJECT',strict:true,properties});
function graph(definitions:Record<string,GraphNode>,root='Node'):TypeGraph{return {version:'SAJIMORA_TYPE_GRAPH_V2',roots:{root},definitions,manifest:{snapshot:'fixture',serializerProfile:'DECLARED_JSON_V1',compilerProfile:'source-fixture',optionsHash:'fixture',sourceHashes:{},missingEvidence:[]}};}
const recursive=(name='id')=>graph({Node:object([field(name,number),field('children',{kind:'ARRAY',elementType:ref('Node')})])});
describe('spec 03 positive recursive wire graphs',()=>{
  it('proves regular recursive inclusion without unfolding',()=>{
    const result=graphInclusion(recursive(),recursive(),'root','root');
    expect(result.status).toBe('COMPATIBILITY_PROVED_IN_SCOPE');expect(result.pairs).toBeLessThan(10);
  });
  it('finds a renamed nested child field with a finite admitted JSON witness',()=>{
    const before=graph({Root:object([field('children',{kind:'ARRAY',elementType:ref('Child')})]),Child:object([field('id',number),field('children',{kind:'ARRAY',elementType:ref('Child')})])},'Root');
    const after=graph({...before.definitions,Child:object([field('label',number),field('children',{kind:'ARRAY',elementType:ref('Child')})])},'Root');
    const result=graphInclusion(after,before,'root','root',{maxSamples:128});
    expect(result.status).toBe('BREAK_PROVED');expect(result.witness?.path).toBe('$.children[0].id');
    expect(result.witness?.value).toEqual(expect.objectContaining({children:expect.arrayContaining([expect.objectContaining({label:expect.any(Number)})])}));
  });
  it('handles mutual and nullable structural cycles and seals deterministic SCCs',()=>{
    const g=graph({A:object([field('b',ref('B'),true)]),B:{kind:'NULLABLE',innerType:object([field('a',ref('A'),true)])}},'A');
    expect(graphComponents(g)).toEqual([['A','B']]);
    expect(graphInclusion(g,g,'root','root').status).toBe('COMPATIBILITY_PROVED_IN_SCOPE');
    const sealed=sealGraphArtifact(g);expect(parseGraphArtifact(JSON.stringify(sealed))).toEqual(sealed);
    expect(()=>parseEnvelope(JSON.stringify(sealed))).toThrow();
  });
  it('does not accept an incompatible root because its cyclic child matches',()=>{
    const before=recursive(),after=graph({Node:object([field('id',string),field('children',{kind:'ARRAY',elementType:ref('Node')})])});
    expect(graphInclusion(after,before,'root','root').status).toBe('BREAK_PROVED');
  });
  it('does not turn different failed union trials into a false break',()=>{
    const source=graph({Node:object([field('tag',{kind:'UNION',types:[{kind:'LITERAL',value:'a'},{kind:'LITERAL',value:'b'}]})])});
    const target=graph({Node:{kind:'UNION',types:[object([field('tag',{kind:'LITERAL',value:'a'})]),object([field('tag',{kind:'LITERAL',value:'b'})])]}});
    expect(graphInclusion(source,target,'root','root').status).toBe('COMPATIBILITY_PROVED_IN_SCOPE');
    const distributed=graph({Node:{kind:'UNION',types:[object([field('tag',{kind:'LITERAL',value:'a'})]),object([field('tag',{kind:'LITERAL',value:'b'})])]}});
    expect(graphInclusion(distributed,target,'root','root').status).toBe('COMPATIBILITY_PROVED_IN_SCOPE');
  });
  it('removes an OR choice contradicted by a reachable recursive obligation',()=>{
    const source=recursive(),target=graph({Node:{kind:'UNION',types:[ref('Wrong'),ref('Other')]},Wrong:object([field('id',string),field('children',{kind:'ARRAY',elementType:ref('Wrong')})]),Other:object([field('name',number),field('children',{kind:'ARRAY',elementType:ref('Other')})])});
    expect(graphInclusion(source,target,'root','root').status).toBe('BREAK_PROVED');
  });
  it('does not use a non-consuming OR cycle as universal acceptance',()=>{
    const source=graph({Node:string}),receiver=graph({Node:{kind:'UNION',types:[{kind:'LITERAL',value:'a'},ref('Node')]}});
    expect(graphInclusion(source,receiver,'root','root').status).toBe('BREAK_PROVED');
    const singleton=graph({Node:{kind:'LITERAL',value:'a'}});
    expect(graphInclusion(singleton,receiver,'root','root').status).toBe('COMPATIBILITY_PROVED_IN_SCOPE');
  });
  it('keeps unknown, nonstructural alias cycles and exhausted budgets pending',()=>{
    expect(graphInclusion(graph({Node:{kind:'UNKNOWN',reason:'external data'}}),recursive(),'root','root').status).toBe('EVIDENCE_REQUIRED');
    expect(graphInclusion(graph({Node:ref('Node')}),graph({Node:ref('Node')}),'root','root').status).toBe('EVIDENCE_REQUIRED');
    expect(graphInclusion(recursive(),recursive(),'root','root',{maxPairs:0}).status).toBe('EVIDENCE_REQUIRED');
    const nonproductive=graph({Node:object([field('next',ref('Node'))])});
    expect(graphInclusion(nonproductive,nonproductive,'root','root').status).toBe('EVIDENCE_REQUIRED');
  });
  it('rejects dangling references and integrity changes',()=>{
    expect(validateTypeGraph(graph({Node:ref('Missing')}))).toBe(false);
    const sealed=sealGraphArtifact(recursive());
    expect(()=>parseGraphArtifact(JSON.stringify({...sealed,graph:recursive('renamed')}))).toThrow('integrity');
  });
  it('preserves tuple positions and explicit null versus omission',()=>{
    expect(graphInclusion(graph({Node:{kind:'TUPLE',elements:[number,string]}}),graph({Node:{kind:'TUPLE',elements:[number,number]}}),'root','root').status).toBe('BREAK_PROVED');
    expect(graphInclusion(graph({Node:object([field('id',number,true)])}),graph({Node:object([field('id',number)])}),'root','root').status).toBe('BREAK_PROVED');
    expect(graphInclusion(graph({Node:object([{...field('id',number),nullable:true}])}),graph({Node:object([field('id',number,true)])}),'root','root').status).toBe('BREAK_PROVED');
  });
  it('extracts regular generic cycles with distinct qualified argument identities',()=>{
    const files=new Map([['node.ts','export interface Node<T=string>{value:T;children:Node<T>[];}']]);
    const extractor=new TypeScriptGraphExtractor(files),strings=extractor.extract('Node<string>','node.ts','base'),numbers=extractor.extract('Node<number>','node.ts','base');
    expect(validateTypeGraph(strings)).toBe(true);expect(Object.keys(strings.definitions)).toHaveLength(1);
    expect(Object.values(strings.roots)[0]).not.toBe(Object.values(numbers.roots)[0]);
    expect(graphComponents(strings)[0]).toHaveLength(1);
    expect(graphInclusion(strings,strings,'Node<string>','Node<string>').status).toBe('COMPATIBILITY_PROVED_IN_SCOPE');
    expect(graphInclusion(numbers,strings,'Node<number>','Node<string>').status).toBe('BREAK_PROVED');
    expect(extractor.extract('Node<string>','node.ts','base')).toEqual(strings);
  });
  it('preserves imported aliases, defaults and re-export cycles without a global name fallback',()=>{
    const files=new Map([['node.ts','export interface Node<T=string>{value:T;next?:Node<T>;}'],['barrel.ts',"export {Node as Item} from './node';export * from './loop';"],['loop.ts',"export * from './barrel';"],['client.ts',"import {Item as Response} from './barrel';"]]);
    const result=new TypeScriptGraphExtractor(files).extract('Response','client.ts','base');
    expect(result.manifest.missingEvidence).toEqual([]);expect(Object.keys(result.definitions)).toHaveLength(1);
    expect(Object.keys(result.manifest.sourceHashes).sort()).toEqual(['barrel.ts','client.ts','node.ts']);
    const missing=new TypeScriptGraphExtractor(files).extract('Unrelated','client.ts','base');
    expect(Object.values(missing.definitions)[0].kind).toBe('UNKNOWN');
  });
  it('keeps growing generic instantiations and source syntax defects pending',()=>{
    const growing=new TypeScriptGraphExtractor(new Map([['node.ts','export interface Node<T>{value:T;next?:Node<Node<T>>;}']]),{maxInstantiations:8,maxDepth:32}).extract('Node<string>','node.ts','base');
    expect(validateTypeGraph(growing)).toBe(true);expect(growing.manifest.missingEvidence.some(m=>/budget/.test(m))).toBe(true);
    expect(graphInclusion(growing,growing,'Node<string>','Node<string>').status).toBe('EVIDENCE_REQUIRED');
    const invalid=new TypeScriptGraphExtractor(new Map([['node.ts','export interface Broken {value:;}']])).extract('Broken','node.ts','base');
    expect(invalid.manifest.missingEvidence.some(m=>m.includes('syntax contract invalid'))).toBe(true);
  });
  it('compares graph structure across qualified Java and TypeScript identities',()=>{
    const java=graph({'java.Node':object([field('id',number),field('children',{kind:'ARRAY',elementType:ref('java.Node')})])},'java.Node');
    const source={...java,manifest:{...java.manifest,compilerProfile:'JAVA_SOURCE_GRAPH_V1'}};
    expect(graphInclusion(source,recursive(),'root','root').status).toBe('COMPATIBILITY_PROVED_IN_SCOPE');
  });
  it('exports two frozen revisions through the V2 CLI and finds the recursive rename',()=>{
    const root=resolvePath('scratch');mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,'spec03-cli-'));
    const git=(...args:string[])=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    git('init');writeFileSync(join(directory,'node.ts'),'export interface Node {id:number;children:Node[];}');git('add','node.ts');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','base');const base=git('rev-parse','HEAD');
    writeFileSync(join(directory,'node.ts'),'export interface Node {label:number;children:Node[];}');git('add','node.ts');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','rename');const candidate=git('rev-parse','HEAD');
    const command=(args:string[])=>spawnSync(process.execPath,['scripts/test-runtime/run-tsx-command.cjs','scripts/sajimora/typeGraph.ts',...args],{encoding:'utf8',timeout:20000});
    const oldPath=join(directory,'base.graph.json'),newPath=join(directory,'candidate.graph.json');
    for(const [revision,out]of [[base,oldPath],[candidate,newPath]]){const run=command(['export','--repo',directory,'--revision',revision,'--file','node.ts','--type','Node','--out',out]);expect(run.status,run.stderr).toBe(0);}
    const compare=command(['compare','--producer',newPath,'--consumer',oldPath,'--producer-root','Node','--consumer-root','Node','--trusted-local']);expect(compare.status,compare.stderr).toBe(0);
    expect(JSON.parse(compare.stdout)).toMatchObject({status:'BREAK_PROVED',witness:{path:'$.id'}});
    expect(parseGraphArtifact(readFileSync(oldPath,'utf8')).graph.manifest.snapshot).toContain(base);
  },30000);
});
