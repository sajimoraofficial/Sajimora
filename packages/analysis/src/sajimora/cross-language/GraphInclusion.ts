import {canonicalJson} from './ContractArtifactEnvelope';
import {GraphNode,GraphProperty,TypeGraph,validateTypeGraph,graphReferences} from './RecursiveWireGraph';
import {finiteConstraintAcceptance} from './FiniteConstraintEvidence';

export interface GraphInclusionResult {
  readonly status:'COMPATIBILITY_PROVED_IN_SCOPE'|'BREAK_PROVED'|'EVIDENCE_REQUIRED';
  readonly checkedScope:readonly string[];
  readonly assumptions:readonly string[];
  readonly pairs:number;
  readonly missingEvidence:readonly string[];
  readonly witness?:{path:string;reason:string;value:unknown};
}
type Group={mode:'AND'|'OR';children:number[]};
type Pair={p:GraphNode;a:GraphNode;path:string;groups:Group[];local:'OK'|'FAIL'|'UNKNOWN';reason?:string};
const ABSENT=Symbol('absent');
function resolve(node:GraphNode,graph:TypeGraph):GraphNode {
  const seen=new Set<string>(),queue=[node],alternatives:GraphNode[]=[];let steps=0;
  while(queue.length){
    if(++steps>100000)return {kind:'UNKNOWN',reason:'Union/reference closure budget exhausted'};
    const current=queue.pop()!;
    if(current.kind==='REF'){if(!seen.has(current.typeId)){seen.add(current.typeId);queue.push(graph.definitions[current.typeId]);}continue;}
    if(current.kind==='UNION'){queue.push(...[...current.types].reverse());continue;}
    if(current.kind==='NULLABLE'||current.kind==='OPTIONAL'){queue.push(current.innerType,{kind:current.kind==='NULLABLE'?'NULL':'ABSENT'});continue;}
    if(current.kind==='ENUM'){if(current.values.length)queue.push(...current.values.map(value=>({kind:'LITERAL' as const,value})).reverse());else alternatives.push({kind:'UNKNOWN',reason:'Empty domain requires construction reachability evidence'});continue;}
    alternatives.push(current);
  }
  const unique=[...new Map(alternatives.map(n=>[canonicalJson(n),n])).values()];
  return unique.length>1?{kind:'UNION',types:unique}:unique[0]??{kind:'UNKNOWN',reason:'Nonstructural reference cycle'};
}
function property(p:GraphProperty):GraphNode {let n=p.type;if(p.nullable)n={kind:'NULLABLE',innerType:n};if(p.optional)n={kind:'OPTIONAL',innerType:n};return n;}
function finiteValues(node:GraphNode,graph:TypeGraph):unknown[]|undefined {
  node=resolve(node,graph);
  if(node.kind==='LITERAL')return [node.value];if(node.kind==='NULL')return [null];if(node.kind==='ABSENT')return [ABSENT];
  if(node.kind==='UNION'){const branches=node.types.map(type=>finiteValues(type,graph));if(branches.some(values=>!values))return undefined;const values=branches.flatMap(values=>values!);return values.length<=64?values:undefined;}
  return undefined;
}
function unknown(n:GraphNode):boolean {return n.kind==='UNKNOWN'||n.kind==='PRIMITIVE'&&['any','bigint','void'].includes(n.scalar);}
function productive(graph:TypeGraph,root:string):boolean {
  const ready=new Set<string>(),reverse=new Map(Object.keys(graph.definitions).map(id=>[id,new Set<string>()]));
  for(const [id,node]of Object.entries(graph.definitions))for(const dependency of graphReferences(node))reverse.get(dependency)!.add(id);
  const possible=(node:GraphNode):boolean=>{
    if(node.kind==='REF')return ready.has(node.typeId);
    if(node.kind==='UNKNOWN')return false;
    if(node.kind==='PRIMITIVE')return ['string','number','boolean'].includes(node.scalar);
    if(node.kind==='ARRAY'||node.kind==='NULL'||node.kind==='ABSENT'||node.kind==='LITERAL'||node.kind==='NULLABLE'||node.kind==='OPTIONAL')return true;
    if(node.kind==='ENUM')return node.values.length>0;
    if(node.kind==='UNION')return node.types.some(possible);
    if(node.kind==='TUPLE')return node.elements.every(possible);
    if(node.kind==='OBJECT')return node.properties.every(p=>p.optional||p.nullable||!p.validationConstraints.length&&possible(p.type));
    return false;
  };
  const queue=Object.keys(graph.definitions),queued=new Set(queue);
  for(let i=0;i<queue.length;i++){const id=queue[i];queued.delete(id);if(!ready.has(id)&&possible(graph.definitions[id])){ready.add(id);for(const parent of reverse.get(id)!)if(!queued.has(parent)){queue.push(parent);queued.add(parent);}}}
  return ready.has(graph.roots[root]);
}

/** Greatest-fixed-point inclusion over explicit AND/OR dependencies. A failed
 * union trial is never promoted to a break without one finite value that is
 * admitted by the producer and rejected by every receiver alternative. */
export function graphInclusion(produced:TypeGraph,accepted:TypeGraph,sourceRoot:string,targetRoot:string,budget:{maxPairs?:number;deadlineMs?:number;maxSamples?:number}={}):GraphInclusionResult {
  const started=performance.now();
  const assumptions=['Compared declared finite JSON-tree languages, not runtime construction or circular object identity'];
  const pending=(reason:string,pairs=0):GraphInclusionResult=>({status:'EVIDENCE_REQUIRED',checkedScope:[],assumptions,pairs,missingEvidence:[reason]});
  if(!validateTypeGraph(produced)||!validateTypeGraph(accepted))return pending('Valid V2 graph manifests with no dangling references required');
  if(!Object.hasOwn(produced.roots,sourceRoot)||!Object.hasOwn(accepted.roots,targetRoot))return pending('Both graph roots required');
  if(produced.manifest.serializerProfile!=='DECLARED_JSON_V1'||accepted.manifest.serializerProfile!=='DECLARED_JSON_V1')return pending('Qualified declared JSON graph profiles required; transport/encoder profiles remain separate');
  if(!productive(produced,sourceRoot))return pending('Producer graph has no established finite value; construction/base-case evidence required');
  const start=started,maxPairs=budget.maxPairs??50000,deadline=budget.deadlineMs??1000,pairs:Pair[]=[],index=new Map<string,number>();
  const add=(p:GraphNode,a:GraphNode,path:string):number=>{
    p=resolve(p,produced);a=resolve(a,accepted);const key=canonicalJson([p,a]),existing=index.get(key);if(existing!==undefined)return existing;
    if(pairs.length>=maxPairs||performance.now()-start>deadline)throw new Error('Graph pair/deadline budget exhausted');
    const id=pairs.length;index.set(key,id);pairs.push({p,a,path,groups:[],local:'OK'});return id;
  };
  try{
    add({kind:'REF',typeId:produced.roots[sourceRoot]},{kind:'REF',typeId:accepted.roots[targetRoot]},'$');
    for(let i=0;i<pairs.length;i++){
      if(performance.now()-start>deadline)throw new Error('Graph pair/deadline budget exhausted');
      const row=pairs[i],{p,a}=row;
      const fail=(reason:string)=>{row.local='FAIL';row.reason=reason;};
      const gap=(reason:string)=>{if(row.local!=='FAIL')row.local='UNKNOWN';row.reason=reason;};
      const all=(children:number[])=>row.groups.push({mode:'AND',children});
      if(unknown(p)||unknown(a)){gap(p.kind==='UNKNOWN'?p.reason:a.kind==='UNKNOWN'?a.reason:'Unconstrained or unsupported primitive domain');continue;}
      if(p.kind==='UNION'){all(p.types.map(n=>add(n,a,row.path)));continue;}
      if(a.kind==='UNION'){
        if(p.kind==='OBJECT'){
          let variants:GraphNode[]=[p],split=false;
          for(let fieldIndex=0;fieldIndex<p.properties.length;fieldIndex++){
            const domain=resolve(p.properties[fieldIndex].type,produced);if(domain.kind!=='UNION')continue;
            if(variants.length*domain.types.length>64){gap('Finite object-union distribution exceeds 64-alternative budget');break;}
            split=true;variants=variants.flatMap(variant=>domain.types.map(type=>({...(variant as Extract<GraphNode,{kind:'OBJECT'}>),properties:(variant as Extract<GraphNode,{kind:'OBJECT'}>).properties.map((field,i)=>i===fieldIndex?{...field,type}:field)})));
          }
          if(split&&row.local==='OK'){all(variants.map(n=>add(n,a,row.path)));continue;}
        }
        row.groups.push({mode:'OR',children:a.types.map(n=>add(p,n,row.path))});continue;
      }
      if(p.kind==='TUPLE'&&a.kind==='ARRAY'){all(p.elements.map((element,i)=>add(element,a.elementType,row.path+'['+i+']')));continue;}
      if(p.kind==='LITERAL'){
        const valid=a.kind==='LITERAL'?p.value===a.value:a.kind==='PRIMITIVE'&&typeof p.value===a.scalar;
        if(!valid)fail('Literal value rejected');continue;
      }
      if(p.kind!==a.kind){fail('Wire kind mismatch');continue;}
      if(p.kind==='NULL'||p.kind==='ABSENT')continue;
      if(p.kind==='PRIMITIVE'&&a.kind==='PRIMITIVE'){if(p.scalar!==a.scalar)fail('Primitive domain mismatch');continue;}
      if(p.kind==='ARRAY'&&a.kind==='ARRAY'){all([add(p.elementType,a.elementType,row.path+'[]')]);continue;}
      if(p.kind==='TUPLE'&&a.kind==='TUPLE'){if(p.elements.length!==a.elements.length)fail('Fixed tuple length mismatch');else all(p.elements.map((n,k)=>add(n,a.elements[k],row.path+'['+k+']')));continue;}
      if(p.kind==='OBJECT'&&a.kind==='OBJECT'){
        const supplied=new Map(p.properties.map(f=>[f.wireName,f])),required=new Map(a.properties.map(f=>[f.wireName,f]));
        const children:number[]=[];
        for(const target of a.properties){
          const source=supplied.get(target.wireName);
          if(!source){if(!target.optional)fail('Required field absent: '+target.wireName);continue;}
          if(source.validationConstraints.length)gap('Producer validation predicate semantics require qualification');
          if(target.validationConstraints.length){const values=finiteValues(property(source),produced);if(!values||!values.every(value=>finiteConstraintAcceptance(value,target.validationConstraints,ABSENT)==='ACCEPT'))gap('Validation predicate semantics require qualification');}
          children.push(add(property(source),property(target),row.path+'.'+target.wireName));
        }
        if(a.strict){for(const name of supplied.keys())if(!required.has(name))fail('Strict receiver rejects field '+name);if(p.strict!==true)gap('Producer additional-key domain requires qualification');}
        all(children);continue;
      }
      gap('Unsupported graph node relation');
    }
    const alive=pairs.map(p=>p.local==='OK');
    const dependents=pairs.map(()=>new Set<number>());
    pairs.forEach((p,i)=>p.groups.forEach(g=>g.children.forEach(child=>dependents[child].add(i))));
    const queue=pairs.map((_,i)=>i);const queued=new Set(queue);
    for(let position=0;position<queue.length;position++){
      if(performance.now()-start>deadline)throw new Error('Graph fixed-point deadline exhausted');
      const id=queue[position];queued.delete(id);if(!alive[id])continue;
      if(pairs[id].groups.some(g=>g.mode==='AND'?g.children.some(c=>!alive[c]):!g.children.some(c=>alive[c]))){alive[id]=false;for(const parent of dependents[id])if(!queued.has(parent)){queue.push(parent);queued.add(parent);}}
    }
    if(alive[0])return {status:'COMPATIBILITY_PROVED_IN_SCOPE',checkedScope:['declared JSON graph root '+sourceRoot],assumptions,pairs:pairs.length,missingEvidence:[]};
    const work={steps:0,deadline:start+deadline};
    const examples=samples({kind:'REF',typeId:produced.roots[sourceRoot]},produced,0,new Map(),Math.min(256,budget.maxSamples??64),work);
    for(const value of examples){
      if(performance.now()-start>deadline)throw new Error('Graph counterexample deadline exhausted');
      const source=accepts(value,{kind:'REF',typeId:produced.roots[sourceRoot]},produced,'$',0,work),target=accepts(value,{kind:'REF',typeId:accepted.roots[targetRoot]},accepted,'$',0,work);
      if(source.state==='ACCEPT'&&target.state==='REJECT'&&value!==ABSENT)return {status:'BREAK_PROVED',checkedScope:['declared JSON graph root '+sourceRoot],assumptions,pairs:pairs.length,missingEvidence:[],witness:{path:target.path,reason:target.reason,value}};
    }
    return pending([...new Set(pairs.filter(p=>p.local==='UNKNOWN').map(p=>p.reason!))].join('; ')||'No universal inclusion proof or validated finite counterexample within the supported budget',pairs.length);
  }catch(error){return pending((error as Error).message,pairs.length);}
}
type Acceptance={state:'ACCEPT'|'REJECT'|'UNKNOWN';path:string;reason:string};
type Work={steps:number;deadline:number};
function tick(work:Work):void {if(++work.steps>50000||performance.now()>work.deadline)throw new Error('Graph finite-witness work/deadline budget exhausted');}
function accepts(value:unknown,node:GraphNode,graph:TypeGraph,path:string,depth:number,work:Work):Acceptance {
  tick(work);
  const result=(state:Acceptance['state'],reason=''):Acceptance=>({state,path,reason});
  if(depth>80)return result('UNKNOWN','Counterexample validation depth exceeded');node=resolve(node,graph);
  if(unknown(node))return result('UNKNOWN','Unqualified value domain');
  if(node.kind==='UNION'){const outcomes=node.types.map(n=>accepts(value,n,graph,path,depth+1,work));return outcomes.some(o=>o.state==='ACCEPT')?result('ACCEPT'):outcomes.some(o=>o.state==='UNKNOWN')?result('UNKNOWN','Unqualified union alternative'):result('REJECT','Every receiver union alternative rejects this value');}
  if(node.kind==='NULL')return result(value===null?'ACCEPT':'REJECT','Expected null');
  if(node.kind==='ABSENT')return result(value===ABSENT?'ACCEPT':'REJECT','Expected omission');
  if(node.kind==='LITERAL')return result(value===node.value?'ACCEPT':'REJECT','Literal rejected');
  if(node.kind==='PRIMITIVE')return result(typeof value===node.scalar&&(typeof value!=='number'||Number.isFinite(value))?'ACCEPT':'REJECT','Primitive type rejected');
  if(node.kind==='ARRAY'||node.kind==='TUPLE'){
    if(!Array.isArray(value))return result('REJECT','Array required');
    if(node.kind==='TUPLE'&&value.length!==node.elements.length)return result('REJECT','Fixed tuple length rejected');
    const outcomes=value.map((v,i)=>accepts(v,node.kind==='ARRAY'?node.elementType:node.elements[i],graph,path+'['+i+']',depth+1,work));
    return outcomes.find(o=>o.state==='REJECT')??outcomes.find(o=>o.state==='UNKNOWN')??result('ACCEPT');
  }
  if(node.kind==='OBJECT'){
    if(value===null||typeof value!=='object'||Array.isArray(value))return result('REJECT','Object required');
    const record=value as Record<string,unknown>,outcomes:Acceptance[]=[];
    for(const field of node.properties){
      const supplied=Object.hasOwn(record,field.wireName)?record[field.wireName]:ABSENT;
      if(field.validationConstraints.length){const constraint=finiteConstraintAcceptance(supplied,field.validationConstraints,ABSENT);if(constraint!=='ACCEPT')outcomes.push({state:constraint,path:path+'.'+field.wireName,reason:constraint==='REJECT'?'Qualified finite validation predicate rejects this value':'Validation predicate semantics require qualification'});}
      outcomes.push(accepts(supplied,property(field),graph,path+'.'+field.wireName,depth+1,work));
    }
    if(node.strict)for(const key of Object.keys(record))if(!node.properties.some(p=>p.wireName===key))outcomes.push({state:'REJECT',path:path+'.'+key,reason:'Strict receiver rejects extra field'});
    return outcomes.find(o=>o.state==='REJECT')??outcomes.find(o=>o.state==='UNKNOWN')??result('ACCEPT');
  }
  return result('UNKNOWN','Unsupported counterexample domain');
}
function samples(node:GraphNode,graph:TypeGraph,depth:number,visits:Map<string,number>,cap:number,work:Work):unknown[]{
  tick(work);
  if(depth>80||cap<=0)return [];
  if(node.kind==='REF'){const count=visits.get(node.typeId)??0;if(count>=3)return [];const next=new Map(visits);next.set(node.typeId,count+1);return samples(graph.definitions[node.typeId],graph,depth+1,next,cap,work);}
  node=resolve(node,graph);
  if(node.kind==='UNION')return node.types.flatMap(n=>samples(n,graph,depth+1,new Map(visits),cap,work)).slice(0,cap);
  if(node.kind==='NULL')return [null];if(node.kind==='ABSENT')return [ABSENT];if(node.kind==='LITERAL')return [node.value];
  if(node.kind==='PRIMITIVE')return node.scalar==='number'?[0,1,-1,100]:node.scalar==='string'?['','example']:node.scalar==='boolean'?[false,true]:[];
  if(node.kind==='ARRAY')return [[],...samples(node.elementType,graph,depth+1,new Map(visits),cap-1,work).filter(v=>v!==ABSENT).map(v=>[v])].slice(0,cap);
  if(node.kind==='OBJECT'){
    if(node.properties.length>256||node.properties.some(p=>p.validationConstraints.length))return [];
    let values:Record<string,unknown>[]=[Object.create(null)];
    for(const field of node.properties){
      const options=samples(property(field),graph,depth+1,new Map(visits),cap,work);if(!options.length)return [];
      values=values.flatMap(base=>options.map(value=>value===ABSENT?{...base}:{...base,[field.wireName]:value})).slice(0,cap);
    }
    if(!node.strict&&values.length<cap){let key='__extra__';while(node.properties.some(p=>p.wireName===key))key+='_';values.push(...values.slice(0,cap-values.length).map(v=>({...v,[key]:null})));}
    return values;
  }
  if(node.kind==='TUPLE'){
    let values:unknown[][]=[[]];for(const element of node.elements){const options=samples(element,graph,depth+1,new Map(visits),cap,work).filter(v=>v!==ABSENT);if(!options.length)return [];values=values.flatMap(base=>options.map(value=>[...base,value])).slice(0,cap);}return values;
  }
  return [];
}
