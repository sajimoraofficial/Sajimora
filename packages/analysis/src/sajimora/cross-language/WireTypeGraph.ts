import {WireType} from './CanonicalContractIR';
import {GraphNode,TypeGraph} from './RecursiveWireGraph';
/** Explicit bridge for legacy declared JSON trees, never arbitrary serializers. */
export function declaredWireGraph(type:WireType|null,snapshot:string):TypeGraph {
  const lower=(node:WireType,depth:number):GraphNode=>{
    if(depth>64)return {kind:'UNKNOWN',reason:'Declared wire tree depth budget exceeded'};
    if(node.kind==='OBJECT')return {...node,properties:node.properties.map(p=>({...p,type:lower(p.type,depth+1)}))};
    if(node.kind==='ARRAY')return {kind:'ARRAY',elementType:lower(node.elementType,depth+1)};
    if(node.kind==='UNION')return {kind:'UNION',types:node.types.map(t=>lower(t,depth+1))};
    if(node.kind==='NULLABLE'||node.kind==='OPTIONAL')return {kind:node.kind,innerType:lower(node.innerType,depth+1)};
    if(node.kind==='MAP')return {kind:'UNKNOWN',reason:'Declared map requires a JSON dictionary graph profile'};
    if(node.kind==='PRIMITIVE'&&node.scalar==='void')return {kind:'ABSENT'};
    if(node.kind==='REF')return {kind:'REF',typeId:node.ref};
    return node;
  };
  return {version:'SAJIMORA_TYPE_GRAPH_V2',roots:{body:'body'},definitions:{body:type?lower(type,0):{kind:'ABSENT'}},manifest:{snapshot,serializerProfile:'DECLARED_JSON_V1',compilerProfile:'DECLARED_WIRE_TREE_V1',optionsHash:'declared',sourceHashes:{},missingEvidence:[]}};
}
