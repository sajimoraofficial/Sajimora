import {createHash} from 'node:crypto';
import {TypeGraph,GraphNode,validateTypeGraph} from './RecursiveWireGraph';
import {graphInclusion} from './GraphInclusion';
import {canonicalJson} from './ContractArtifactEnvelope';

export interface ContractObservation {
  readonly version:'SAJIMORA_OBSERVATION_V1';readonly endpointId:string;readonly buildRevision:string;readonly environmentProfile:string;
  readonly status:number;readonly mediaType:string;readonly timestamp:string;readonly provenance:string;
  readonly consentScope:'LOCAL_SHAPE_ONLY'|'LOCAL_VALIDATION';readonly redaction:{shapeChanged:boolean};readonly payload:unknown;
}
export interface ObservationResult {
  readonly status:'OBSERVED_FAILURE'|'OBSERVED_ACCEPTANCE'|'EVIDENCE_REQUIRED';readonly universalCompatibility:false;
  readonly observationId?:string;readonly shape?:unknown;readonly testedScope:readonly string[];readonly missingEvidence:readonly string[];
  readonly witness?:{path:string;reason:string};
}
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Local imported evidence only; result stores no raw payload or literal values. */
export function assessObservation(input:ContractObservation,accepted:TypeGraph,expected:{endpointId:string;buildRevision:string;environmentProfile:string;status:number;mediaType:string}):ObservationResult {
  const pending=(reason:string):ObservationResult=>({status:'EVIDENCE_REQUIRED',universalCompatibility:false,testedScope:[],missingEvidence:[reason]});
  if(!input||input.version!=='SAJIMORA_OBSERVATION_V1'||!['LOCAL_SHAPE_ONLY','LOCAL_VALIDATION'].includes(input.consentScope))return pending('Explicit local observation consent and a versioned evidence envelope required');
  if(Object.entries(expected).some(([key,value])=>input[key as keyof ContractObservation]!==value))return pending('Observation build/environment/endpoint/status/media does not match this historical obligation');
  if(!input.redaction||input.redaction.shapeChanged)return pending('Shape-changing redaction prevents attaching this observation to the original contract');
  if(!input.provenance||!Number.isFinite(Date.parse(input.timestamp)))return pending('Observation provenance and a valid capture timestamp required');
  if(!validateTypeGraph(accepted)||!Object.hasOwn(accepted.roots,'body'))return pending('Qualified declared body graph required for local observation validation');
  if(accepted.manifest.snapshot!==expected.buildRevision)return pending('Declared contract graph revision does not match the observed build');
  let nodes=0;const ancestors=new Set<object>();
  const lower=(value:unknown,depth:number):GraphNode=>{
    if(++nodes>10000||depth>64)throw new Error('Observation node/depth admission budget exceeded');
    if(value===null)return {kind:'NULL'};
    if(typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return {kind:'LITERAL',value};
    if(typeof value!=='object'||!value)throw new Error('Observation must contain finite JSON values');
    if(ancestors.has(value))throw new Error('Cyclic observation payload is not JSON evidence');
    if(!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('Observation must be plain parsed JSON data');
    const descriptors=Object.getOwnPropertyDescriptors(value);if(Object.values(descriptors).some(d=>d.get||d.set))throw new Error('Observation accessors are not admitted');
    ancestors.add(value);let node:GraphNode;
    if(Array.isArray(value))node={kind:'TUPLE',elements:Array.from({length:value.length},(_,index)=>lower(descriptors[index]?.value,depth+1))};
    else node={kind:'OBJECT',strict:true,properties:Object.keys(descriptors).sort().map(wireName=>({wireName,type:lower(descriptors[wireName].value,depth+1),optional:false,nullable:false,validationConstraints:[]}))};
    ancestors.delete(value);return node;
  };
  let value:GraphNode;try{value=lower(input.payload,0);if(Buffer.byteLength(canonicalJson(input.payload))>1024*1024)return pending('Observation payload exceeds 1 MiB admission budget');}catch(error){return pending((error as Error).message);}
  const observationId=hash([expected,input.timestamp,input.provenance,input.payload]),source:TypeGraph={version:'SAJIMORA_TYPE_GRAPH_V2',roots:{body:'observed'},definitions:{observed:value},manifest:{snapshot:input.buildRevision,serializerProfile:'DECLARED_JSON_V1',compilerProfile:'ONE_RECORDED_JSON_VALUE_V1',optionsHash:hash(expected),sourceHashes:{},missingEvidence:[]}};
  const shape=(node:GraphNode):unknown=>{
    if(node.kind==='LITERAL')return {kind:typeof node.value};if(node.kind==='NULL')return {kind:'null'};
    if(node.kind==='TUPLE')return {kind:'array',length:node.elements.length,elements:node.elements.map(shape)};
    if(node.kind==='OBJECT')return {kind:'object',fields:node.properties.map(p=>({keyHash:hash(p.wireName),shape:shape(p.type)}))};return {kind:'unresolved'};
  };
  const result=graphInclusion(source,accepted,'body','body',{maxPairs:20000,maxSamples:1,deadlineMs:1000});
  const testedScope=['One locally supplied payload for '+input.endpointId+' at build '+input.buildRevision],retained={observationId,shape:shape(value),testedScope,universalCompatibility:false as const};
  if(result.status==='BREAK_PROVED'&&result.witness)return {...retained,status:'OBSERVED_FAILURE',missingEvidence:[],witness:{path:result.witness.path.replace(/(?:password|token|authorization|secret|api[_-]?key|[^.\[\]]+@[^.\[\]]+)/gi,'[REDACTED_KEY]'),reason:result.witness.reason}};
  if(result.status==='COMPATIBILITY_PROVED_IN_SCOPE')return {...retained,status:'OBSERVED_ACCEPTANCE',missingEvidence:[]};
  return {...retained,status:'EVIDENCE_REQUIRED',missingEvidence:result.missingEvidence};
}
