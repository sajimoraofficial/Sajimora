import {WireType} from './CanonicalContractIR';
import {ConsumerSite} from './CrossLanguageContracts';
import {propertyType} from './WireInclusion';
const absent:WireType={kind:'PRIMITIVE',scalar:'void'};
function member(type:WireType,key:string):WireType {
  if(type.kind==='UNKNOWN')return type;
  if(type.kind==='NULLABLE'||type.kind==='OPTIONAL')return {kind:'UNION',types:[member(type.innerType,key),absent]};
  if(type.kind==='UNION')return {kind:'UNION',types:type.types.map(branch=>member(branch,key))};
  if(key==='[]')return type.kind==='ARRAY'?type.elementType:absent;
  if(key==='length'&&(type.kind==='ARRAY'||type.kind==='PRIMITIVE'&&type.scalar==='string'||type.kind==='LITERAL'&&typeof type.value==='string'))return {kind:'PRIMITIVE',scalar:'number'};
  if(type.kind==='OBJECT'){const property=type.properties.find(p=>p.wireName===key);return property?propertyType(property):absent;}
  return absent;
}
export function wireAtConsumerPath(type:WireType|null,path:string):WireType {
  let current=type??absent;for(const key of path.replace(/^\$\.?/,'').split(/(\[\])|\./).filter((key):key is string=>!!key))current=member(current,key);return current;
}
type Requirement='NUMBER'|'STRING'|'ARRAY'|'NON_NIL';
function methodRequirement(method:string):Requirement|undefined {
  if(['toFixed','toExponential','toPrecision'].includes(method))return 'NUMBER';
  if(['trim','trimStart','trimEnd','toUpperCase','toLowerCase','charAt','charCodeAt'].includes(method))return 'STRING';
  if(['map','filter','reduce','forEach','every','some','find','findIndex','flat','flatMap','push','sort'].includes(method))return 'ARRAY';
  return undefined;
}
function admitted(type:WireType,requirement:Requirement):boolean|undefined {
  if(type.kind==='UNKNOWN'||type.kind==='PRIMITIVE'&&type.scalar==='any')return undefined;
  if(type.kind==='NULLABLE'||type.kind==='OPTIONAL')return false;
  if(type.kind==='UNION'){const branches=type.types.map(t=>admitted(t,requirement));return branches.some(result=>result===false)?false:branches.some(result=>result===undefined)?undefined:true;}
  if(type.kind==='PRIMITIVE'&&type.scalar==='void')return false;
  if(requirement==='NON_NIL')return true;
  if(requirement==='ARRAY')return type.kind==='ARRAY';
  const scalar=requirement==='NUMBER'?'number':'string';
  if(type.kind==='PRIMITIVE')return type.scalar===scalar;
  if(type.kind==='LITERAL')return typeof type.value===scalar;
  if(type.kind==='ENUM')return type.values.every(value=>typeof value===scalar);
  return false;
}
/** A read or cast alone is not a rejecting runtime validator. Establish a newly
 * invalid operation under the declared native JavaScript operation profile. */
export function operationFailure(before:WireType|null,after:WireType|null,consumer:ConsumerSite):{path:string;reason:string;before:string;after:string}|undefined {
  if(!consumer.propertyPath||consumer.guards?.length||!consumer.operation)return undefined;
  const separator=consumer.propertyPath.lastIndexOf('.');if(separator<0)return undefined;
  const receiver=consumer.propertyPath.slice(0,separator),method=consumer.propertyPath.slice(separator+1);
  let requirement:Requirement|undefined=consumer.operation==='PROPERTY_READ'?'NON_NIL':undefined;
  if(consumer.operation==='METHOD_CALL'){
    requirement=methodRequirement(method);
  }
  if(!requirement)return undefined;
  const previous=wireAtConsumerPath(before,receiver),candidate=wireAtConsumerPath(after,receiver);
  if(admitted(previous,requirement)!==true||admitted(candidate,requirement)!==false)return undefined;
  return {path:receiver,reason:consumer.operation==='METHOD_CALL'?`Captured ${method}() call requires a ${requirement.toLowerCase()} receiver`:'Captured property dereference requires a non-null, present receiver',before:'declared base receiver admits this operation',after:'candidate admits a value rejected by this operation'};
}
export interface ConditionalOperationFinding {
  readonly kind:'CONDITIONAL_OPERATION_FAILURE';
  readonly consumer:ConsumerSite;
  readonly receiverPath:string;
  readonly baselineReceiverKind:string;
  readonly candidateReceiverKind:string;
  readonly reason:string;
  readonly preconditions:readonly string[];
  readonly universalCompatibility:false;
}
function branches(type:WireType):WireType[]{
  if(type.kind==='UNION')return type.types.flatMap(branches);
  if(type.kind==='NULLABLE'||type.kind==='OPTIONAL')return [...branches(type.innerType),absent];
  return [type];
}
// Coarse categories deliberately cannot establish a new object-shape failure.
function category(type:WireType):string|undefined{
  if(type.kind==='PRIMITIVE')return ['number','string','boolean','void','null'].includes(type.scalar)?type.scalar:undefined;
  if(type.kind==='LITERAL')return type.value===null?'null':typeof type.value;
  if(type.kind==='ARRAY')return 'array';
  if(type.kind==='OBJECT')return 'object';
  if(type.kind==='ENUM'){const kinds=[...new Set(type.values.map(v=>typeof v))];return kinds.length===1?kinds[0]:undefined;}
  return undefined;
}
/** A branch-specific source finding, never a universal assessment upgrade. */
export function conditionalOperationFailure(before:WireType|null,after:WireType|null,consumer:ConsumerSite):ConditionalOperationFinding|undefined{
  if(!before||!after||consumer.operation!=='METHOD_CALL'||!consumer.propertyPath||consumer.guards?.length||operationFailure(before,after,consumer))return undefined;
  const separator=consumer.propertyPath.lastIndexOf('.');if(separator<0)return undefined;
  const receiver=consumer.propertyPath.slice(0,separator),method=consumer.propertyPath.slice(separator+1),requirement=methodRequirement(method);if(!requirement)return undefined;
  const previous=branches(wireAtConsumerPath(before,receiver)),candidate=branches(wireAtConsumerPath(after,receiver));
  if(previous.some(t=>category(t)===undefined))return undefined;
  const supported=previous.find(t=>admitted(t,requirement)===true),rejected=candidate.find(t=>category(t)!==undefined&&admitted(t,requirement)===false&&!previous.some(p=>category(p)===category(t)));
  if(!supported||!rejected)return undefined;
  const oldKind=category(supported)!,newKind=category(rejected)!;
  return {kind:'CONDITIONAL_OPERATION_FAILURE',consumer,receiverPath:receiver,baselineReceiverKind:oldKind,candidateReceiverKind:newKind,reason:`New ${newKind} receiver at ${receiver} rejects ${method}() under the native JavaScript operation profile`,preconditions:[`The candidate emits a ${newKind} value at ${receiver} in the captured response domain`,`That value reaches ${consumer.file}:${consumer.line} without an unmodeled decoder or normalization`,`The corresponding baseline case reaches this operation with a ${oldKind} receiver`,`Captured standard JavaScript operation semantics and response-effect assumptions hold`],universalCompatibility:false};
}
