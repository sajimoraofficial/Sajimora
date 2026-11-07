import {createHash} from 'node:crypto';
import {canonicalJson} from './ContractArtifactEnvelope';
import type {ValidationConstraint,WireType} from './CanonicalContractIR';

export type GraphNode=
  | {readonly kind:'REF';readonly typeId:string}
  | {readonly kind:'NULL'|'ABSENT'}
  | Extract<WireType,{kind:'PRIMITIVE'|'LITERAL'|'ENUM'|'UNKNOWN'}>
  | {readonly kind:'ARRAY';readonly elementType:GraphNode}
  | {readonly kind:'TUPLE';readonly elements:readonly GraphNode[]}
  | {readonly kind:'UNION';readonly types:readonly GraphNode[]}
  | {readonly kind:'NULLABLE'|'OPTIONAL';readonly innerType:GraphNode}
  | {readonly kind:'OBJECT';readonly strict?:boolean;readonly properties:readonly GraphProperty[]};
export interface GraphProperty {
  readonly wireName:string;readonly type:GraphNode;readonly optional:boolean;readonly nullable:boolean;
  readonly validationConstraints:readonly ValidationConstraint[];
}
export interface TypeGraph {
  readonly version:'SAJIMORA_TYPE_GRAPH_V2';
  readonly roots:Readonly<Record<string,string>>;
  readonly definitions:Readonly<Record<string,GraphNode>>;
  readonly manifest:{readonly snapshot:string;readonly serializerProfile:string;readonly compilerProfile:string;readonly optionsHash:string;readonly dependencyFingerprint?:string;readonly sourceHashes:Readonly<Record<string,string>>;readonly missingEvidence:readonly string[]};
}
export interface GraphArtifact {readonly envelopeVersion:'SAJIMORA_GRAPH_ARTIFACT_V2';readonly graph:TypeGraph;readonly integrity:{readonly sha256:string};}
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** Graph data is finite; runtime cyclic object identity is never admitted. */
export function validateTypeGraph(input:unknown,maxDefinitions=50000):input is TypeGraph {
  if(!object(input)||input.version!=='SAJIMORA_TYPE_GRAPH_V2'||!object(input.roots)||!object(input.definitions)||!object(input.manifest))return false;
  const definitions=input.definitions,manifest=input.manifest,keys=Object.keys(definitions);
  if(keys.length>maxDefinitions||!Object.values(input.roots).every(id=>typeof id==='string'&&Object.hasOwn(definitions,id)))return false;
  if(!['snapshot','serializerProfile','compilerProfile','optionsHash'].every(k=>typeof manifest[k]==='string')||!object(manifest.sourceHashes)||!Object.values(manifest.sourceHashes).every(h=>typeof h==='string'&&/^[0-9a-f]{64}$/.test(h))||!Array.isArray(manifest.missingEvidence)||!manifest.missingEvidence.every(s=>typeof s==='string'))return false;
  const active=new Set<object>();
  const node=(value:unknown,depth:number):boolean=>{
    if(depth>80||!object(value)||active.has(value))return false;active.add(value);
    let valid=false;
    switch(value.kind){
      case 'REF':valid=typeof value.typeId==='string'&&Object.hasOwn(definitions,value.typeId);break;
      case 'NULL':case 'ABSENT':valid=true;break;
      case 'UNKNOWN':valid=typeof value.reason==='string';break;
      case 'PRIMITIVE':valid=['string','number','boolean','void','any','bigint'].includes(String(value.scalar));break;
      case 'LITERAL':valid=['string','number','boolean'].includes(typeof value.value)&&(typeof value.value!=='number'||Number.isFinite(value.value));break;
      case 'ENUM':valid=Array.isArray(value.values)&&value.values.every(v=>typeof v==='string'||typeof v==='number'&&Number.isFinite(v));break;
      case 'ARRAY':valid=node(value.elementType,depth+1);break;
      case 'TUPLE':valid=Array.isArray(value.elements)&&value.elements.length<=512&&value.elements.every(n=>node(n,depth+1));break;
      case 'UNION':valid=Array.isArray(value.types)&&value.types.length>0&&value.types.length<=512&&value.types.every(n=>node(n,depth+1));break;
      case 'NULLABLE':case 'OPTIONAL':valid=node(value.innerType,depth+1);break;
      case 'OBJECT':valid=(value.strict===undefined||typeof value.strict==='boolean')&&Array.isArray(value.properties)&&value.properties.length<=10000&&new Set(value.properties.map(p=>object(p)?p.wireName:null)).size===value.properties.length&&value.properties.every(p=>object(p)&&typeof p.wireName==='string'&&typeof p.optional==='boolean'&&typeof p.nullable==='boolean'&&Array.isArray(p.validationConstraints)&&p.validationConstraints.every(c=>object(c)&&['NOT_NULL','NOT_BLANK','NOT_EMPTY','SIZE','MIN','MAX','PATTERN','EMAIL'].includes(String(c.kind))&&(c.value===undefined||typeof c.value==='string'||typeof c.value==='number'&&Number.isFinite(c.value)))&&node(p.type,depth+1));break;
    }
    active.delete(value);return valid;
  };
  return keys.every(key=>node(definitions[key],0));
}
export function graphReferences(node:GraphNode):readonly string[]{
  const refs=new Set<string>(),queue=[node];
  while(queue.length){const n=queue.pop()!;switch(n.kind){case 'REF':refs.add(n.typeId);break;case 'ARRAY':queue.push(n.elementType);break;case 'TUPLE':queue.push(...n.elements);break;case 'UNION':queue.push(...n.types);break;case 'NULLABLE':case 'OPTIONAL':queue.push(n.innerType);break;case 'OBJECT':queue.push(...n.properties.map(p=>p.type));break;}}
  return [...refs].sort();
}
/** Iterative SCC traversal: definition cycles never recursively hash references. */
export function graphComponents(graph:TypeGraph):readonly (readonly string[])[]{
  if(!validateTypeGraph(graph))throw new Error('Invalid type graph');
  const nodes=Object.keys(graph.definitions).sort(),edges=new Map(nodes.map(id=>[id,graphReferences(graph.definitions[id])])),reverse=new Map(nodes.map(id=>[id,[] as string[]]));
  for(const [id,refs]of edges)for(const ref of refs)reverse.get(ref)!.push(id);
  const seen=new Set<string>(),order:string[]=[];
  for(const root of nodes){if(seen.has(root))continue;seen.add(root);const stack:{id:string;index:number}[]=[{id:root,index:0}];while(stack.length){const top=stack[stack.length-1],refs=edges.get(top.id)!;if(top.index<refs.length){const ref=refs[top.index++];if(!seen.has(ref)){seen.add(ref);stack.push({id:ref,index:0});}}else{order.push(top.id);stack.pop();}}}
  seen.clear();const components:string[][]=[];
  for(const root of order.reverse()){if(seen.has(root))continue;const component:string[]=[],stack=[root];seen.add(root);while(stack.length){const id=stack.pop()!;component.push(id);for(const ref of reverse.get(id)!)if(!seen.has(ref)){seen.add(ref);stack.push(ref);}}components.push(component.sort());}
  return components.sort((a,b)=>a[0].localeCompare(b[0]));
}
export function sealGraphArtifact(graph:TypeGraph):GraphArtifact {if(!validateTypeGraph(graph))throw new Error('Invalid type graph');return {envelopeVersion:'SAJIMORA_GRAPH_ARTIFACT_V2',graph,integrity:{sha256:hash({graph,components:graphComponents(graph)})}};}
export function parseGraphArtifact(text:string):GraphArtifact {
  if(Buffer.byteLength(text)>20*1024*1024)throw new Error('Graph artifact exceeds admission budget');
  const artifact:unknown=JSON.parse(text);
  if(!object(artifact)||artifact.envelopeVersion!=='SAJIMORA_GRAPH_ARTIFACT_V2'||!validateTypeGraph(artifact.graph)||!object(artifact.integrity)||artifact.integrity.sha256!==hash({graph:artifact.graph,components:graphComponents(artifact.graph)}))throw new Error('Invalid graph artifact or integrity');
  return artifact as unknown as GraphArtifact;
}
