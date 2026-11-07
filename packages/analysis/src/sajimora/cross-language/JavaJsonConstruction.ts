import {createHash} from 'node:crypto';
import {GraphNode,TypeGraph,graphComponents,graphReferences} from './RecursiveWireGraph';
import {canonicalJson} from './ContractArtifactEnvelope';

let parser:any;
export interface JavaJsonConstructionResult {readonly status:'CONSTRUCTED_DOMAIN'|'EVIDENCE_REQUIRED';readonly graph?:TypeGraph;readonly missingEvidence:readonly string[];}
/** Positive Jackson tree-builder fragment. Parse statements; never run Java. */
export function summarizeJavaJsonConstruction(input:{text:string;file:string;method:string;line?:number;snapshot:string;libraryProfile?:'JACKSON_TREE_2_18_POSITIVE_V1'}):JavaJsonConstructionResult {
  const missing=new Set<string>(),definitions:Record<string,GraphNode>={},bindings=new Map<string,string>(),active=new Set<string>();let steps=0;
  const pending=(reason:string):JavaJsonConstructionResult=>({status:'EVIDENCE_REQUIRED',missingEvidence:[reason]});
  if(input.libraryProfile!=='JACKSON_TREE_2_18_POSITIVE_V1')return pending('Exact historical Jackson tree-builder profile required for '+input.file+'#'+input.method);
  if(Buffer.byteLength(input.text)>1024*1024)return pending('Java JSON source exceeds 1 MiB admission budget');
  if(!parser){const Parser=require('tree-sitter');parser=new Parser();parser.setLanguage(require('tree-sitter-java'));}
  const tree=parser.parse(input.text,undefined,{bufferSize:Math.max(32768,input.text.length*2+1024)}),hash=createHash('sha256').update(input.text).digest('hex');
  const gap=(reason:string):GraphNode=>{missing.add(reason);return {kind:'UNKNOWN',reason};};
  const methods:any[]=[],imports=new Set<string>();
  const collect=(node:any)=>{if(node.type==='method_declaration')methods.push(node);if(node.type==='import_declaration')imports.add(node.text.replace(/^import\s+|;$/g,'').trim());for(const child of node.namedChildren)collect(child);};
  let instances=0,owner:any;
  const methodOwner=(node:any)=>{for(let current=node.parent;current;current=current.parent)if(current.type==='class_declaration'||current.type==='record_declaration')return current;return undefined;};
  const id=(node:any)=>createHash('sha256').update(input.snapshot+hash+node.startIndex+':'+instances++).digest('hex');
  const fresh=(node:any,value:GraphNode):GraphNode=>{const typeId=id(node);definitions[typeId]=value;return {kind:'REF',typeId};};
  const key=(node:any):string|undefined=>{if(node?.type!=='string_literal')return undefined;try{return JSON.parse(node.text);}catch{return undefined;}};
  const argumentsOf=(node:any):any[]=>node.childForFieldName('arguments')?.namedChildren??[];
  const qualifiedFactory=()=>imports.has('com.fasterxml.jackson.databind.node.JsonNodeFactory')||imports.has('com.fasterxml.jackson.databind.node.*');
  const evaluate=(node:any,depth:number):GraphNode=>{
    if(!node)return gap('Java JSON return value is absent');if(++steps>1024||depth>32)return gap('Java JSON helper/value budget exhausted');
    if(node.type==='identifier'){const typeId=bindings.get(node.text);return typeId?{kind:'REF',typeId}:gap('Java JSON value/caller domain required for '+node.text);}
    if(node.type==='string_literal'){const value=key(node);return value===undefined?gap('Java string escape/text block requires decoding qualification'):{kind:'LITERAL',value};}
    if(node.type==='null_literal')return {kind:'ABSENT'};
    if(node.type==='true'||node.type==='false'||node.type==='boolean_literal')return {kind:'LITERAL',value:node.text==='true'};
    if(/^(?:decimal_integer_literal|decimal_floating_point_literal)$/.test(node.type)){const value=Number(node.text.replace(/[fFdDlL]$/,''));if(node.type==='decimal_integer_literal'&&!Number.isSafeInteger(value)||/[fF]$/.test(node.text)&&Math.fround(value)!==value)return gap('Java large-integral/float rounding requires an exact numeric encoder domain');return Number.isFinite(value)?{kind:'LITERAL',value}:gap('Java nonfinite number conversion requires encoder qualification');}
    if(node.type==='parenthesized_expression')return evaluate(node.namedChildren[0],depth+1);
    if(node.type==='method_invocation'){
      const method:string=node.childForFieldName('name')?.text??'',object:string|undefined=node.childForFieldName('object')?.text,args=argumentsOf(node);
      if(qualifiedFactory()&&object==='JsonNodeFactory.instance'&&args.length===0&&['objectNode','arrayNode'].includes(method))return fresh(node,method==='objectNode'?{kind:'OBJECT',strict:true,properties:[]}:{kind:'TUPLE',elements:[]});
      if(qualifiedFactory()&&object==='JsonNodeFactory.instance'&&method==='nullNode'&&args.length===0)return fresh(node,{kind:'NULL'});
      if(qualifiedFactory()&&object==='JsonNodeFactory.instance'&&args.length===1&&['numberNode','textNode','booleanNode'].includes(method)){
        const value=evaluate(args[0],depth+1),scalar=method==='numberNode'?'number':method==='textNode'?'string':'boolean';if(value.kind!=='LITERAL'||typeof value.value!==scalar)return gap('Exact JsonNodeFactory scalar overload required');return fresh(node,value);
      }
      const receiverId=object===undefined?undefined:bindings.get(object),receiver=receiverId===undefined?undefined:definitions[receiverId];
      if(receiverId&&receiver?.kind==='OBJECT'&&['put','putNull','set','remove'].includes(method)){
        if(method==='remove'&&args.length!==1)return gap('Exact ObjectNode.remove overload required');
        const name=key(args[0]);if(name===undefined)return gap('Literal ObjectNode key required for '+method);
        const fields=new Map(receiver.properties.map(property=>[property.wireName,property]));
        const removed=fields.get(name)?.type??{kind:'ABSENT' as const};
        if(method==='remove')fields.delete(name);
        else{if(method==='putNull'&&args.length!==1||method!=='putNull'&&args.length!==2)return gap('Exact ObjectNode overload/arguments required for '+method);let value=method==='putNull'?{kind:'NULL' as const}:evaluate(args[1],depth+1);if(method==='set'&&value.kind!=='REF'&&value.kind!=='ABSENT')return gap('ObjectNode.set requires a qualified JsonNode argument, not an invented scalar overload');if(method==='put'&&value.kind==='ABSENT')return gap('Ambiguous ObjectNode.put(null) overload requires Java type evidence');if(method==='set'&&(value.kind==='ABSENT'||value.kind==='REF'&&definitions[value.typeId]?.kind==='ABSENT'))value={kind:'NULL'};fields.set(name,{wireName:name,type:value,optional:false,nullable:false,validationConstraints:[]});}
        definitions[receiverId]={...receiver,properties:[...fields.values()]};return method==='remove'?removed.kind==='REF'?removed:fresh(node,removed):{kind:'REF',typeId:receiverId};
      }
      if(receiverId&&receiver?.kind==='TUPLE'&&method==='add'&&args.length===1){definitions[receiverId]={kind:'TUPLE',elements:[...receiver.elements,evaluate(args[0],depth+1)]};return {kind:'REF',typeId:receiverId};}
      if(!object||object==='this'){
        const candidates=methods.filter(candidate=>methodOwner(candidate)?.startIndex===owner?.startIndex&&candidate.childForFieldName('name')?.text===method&&(candidate.childForFieldName('parameters')?.namedChildren??[]).length===args.length);
        if(candidates.length===1&&args.length===0&&!active.has(method)){active.add(method);const outer=new Map(bindings);bindings.clear();const result=execute(candidates[0].childForFieldName('body'),depth+1);bindings.clear();for(const [name,typeId]of outer)bindings.set(name,typeId);active.delete(method);return result;}
      }
      // A builder escape can mutate any aliased node; invalidate the reachable
      // domains rather than keeping stale keys from before the call.
      for(const name of bindings.values())definitions[name]=gap('Java JSON node escape/mutation summary required at '+input.file+':'+(node.startPosition.row+1));
      return gap('Java JSON operation '+node.text.slice(0,120)+' requires an exact source/library summary');
    }
    return gap('Java JSON expression '+node.type+' requires a construction/encoder summary');
  };
  const execute=(body:any,depth:number):GraphNode=>{
    if(!body)return gap('Captured Java helper body required');
    for(const statement of body.namedChildren){
      if(++steps>1024)return gap('Java JSON statement budget exhausted');
      if(statement.type==='local_variable_declaration'){
        const declared=statement.childForFieldName('type')?.text;if(!['ObjectNode','ArrayNode','JsonNode'].includes(declared))return gap('Java JSON local type '+declared+' requires a typed value summary');
        for(const declaration of statement.namedChildren.filter((child:any)=>child.type==='variable_declarator')){const name=declaration.childForFieldName('name')?.text,value=evaluate(declaration.childForFieldName('value'),depth+1);if(value.kind==='REF')bindings.set(name,value.typeId);else{const ref=fresh(declaration,value) as Extract<GraphNode,{kind:'REF'}>;bindings.set(name,ref.typeId);}}
      }else if(statement.type==='expression_statement')evaluate(statement.namedChildren[0],depth+1);
      else if(statement.type==='return_statement'){const value=evaluate(statement.namedChildren[0],depth+1);if(value.kind!=='REF'&&value.kind!=='ABSENT'&&value.kind!=='UNKNOWN')return gap('Java JsonNode return requires a node construction, not an invalid scalar return');return value;}
      else return gap('Java JSON control-flow '+statement.type+' requires branch/loop guard qualification at '+input.file+':'+(statement.startPosition.row+1));
    }
    return gap('Java JSON method has no established body return');
  };
  try{
    collect(tree.rootNode);if(tree.rootNode.hasError)return pending('Java source syntax diagnostics prevent JSON construction qualification');
    if(/\bclass\s+JsonNodeFactory\b/.test(input.text))return pending('Shadowed Jackson factory requires qualified symbol identity');
    const candidates=methods.filter(method=>method.childForFieldName('name')?.text===input.method&&(input.line===undefined||method.startPosition.row+1<=input.line&&method.endPosition.row+1>=input.line));
    if(candidates.length!==1)return pending('Unique captured Java method identity required');
    owner=methodOwner(candidates[0]);active.add(input.method);const value=execute(candidates[0].childForFieldName('body'),0),root='returned';definitions[root]=value;
    const graph:TypeGraph={version:'SAJIMORA_TYPE_GRAPH_V2',roots:{body:root},definitions,manifest:{snapshot:input.snapshot,serializerProfile:'DECLARED_JSON_V1',compilerProfile:input.libraryProfile,optionsHash:createHash('sha256').update(canonicalJson([input.file,input.method,input.libraryProfile])).digest('hex'),sourceHashes:{[input.file]:hash},missingEvidence:[...missing].sort()}};
    const reachable=new Set<string>([root]),queue=[root];for(let index=0;index<queue.length;index++)for(const reference of graphReferences(definitions[queue[index]]))if(!reachable.has(reference)){reachable.add(reference);queue.push(reference);}
    const admitted={...graph,definitions:Object.fromEntries([...reachable].map(typeId=>[typeId,definitions[typeId]]))};
    if(graphComponents(admitted).some(component=>component.length>1||graphReferences(admitted.definitions[component[0]]).includes(component[0])))missing.add('Runtime circular JsonNode identity requires a qualified serializer profile');
    let returned=definitions[root];for(let index=0;returned.kind==='REF'&&index<4096;index++)returned=definitions[returned.typeId];if(returned.kind==='ABSENT')missing.add('Returned Java null requires status/media and absent-body transport evidence');
    return {status:missing.size?'EVIDENCE_REQUIRED':'CONSTRUCTED_DOMAIN',graph:{...admitted,manifest:{...admitted.manifest,missingEvidence:[...missing].sort()}},missingEvidence:[...missing].sort()};
  }finally{tree.delete?.();}
}
