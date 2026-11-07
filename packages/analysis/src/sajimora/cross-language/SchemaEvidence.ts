import {createHash} from 'node:crypto';
import * as path from 'node:path';
import {GraphNode,TypeGraph} from './RecursiveWireGraph';
import {canonicalJson} from './ContractArtifactEnvelope';

export interface SchemaEvidence {
  readonly version:'SAJIMORA_SCHEMA_EVIDENCE_V1';readonly repositoryId:string;readonly revision:string;
  readonly endpoint:string;readonly method:string;readonly status:number;readonly mediaType:string;readonly codecProfile:string;
  readonly dialect:'https://json-schema.org/draft/2020-12/schema';readonly root:string;
  readonly documents:Readonly<Record<string,{sha256:string;schema:unknown}>>;
}
export interface SchemaEvidenceResult {readonly graph?:TypeGraph;readonly status:'DECLARED_CONTRACT'|'EVIDENCE_REQUIRED';readonly missingEvidence:readonly string[];readonly implementationConformance:'NOT_ESTABLISHED';}
const sha=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** Immutable captured references only. No schema fetches or repository execution. */
export function importSchemaEvidence(input:SchemaEvidence,expected:{repositoryId:string;revision:string;endpoint:string;method:string;status:number;mediaType:string;codecProfile:string}):SchemaEvidenceResult {
  const missing=new Set<string>(),definitions:Record<string,GraphNode>={},active=new Map<string,string>();let nodes=0;
  const pending=(reason:string):SchemaEvidenceResult=>({status:'EVIDENCE_REQUIRED',missingEvidence:[reason],implementationConformance:'NOT_ESTABLISHED'});
  if(!object(input)||input.version!=='SAJIMORA_SCHEMA_EVIDENCE_V1'||input.dialect!=='https://json-schema.org/draft/2020-12/schema'||typeof input.root!=='string')return pending('Qualified JSON Schema 2020-12 evidence envelope required');
  if(Object.entries(expected).some(([key,value])=>input[key as keyof SchemaEvidence]!==value))return pending('Schema repository/revision/endpoint/status/media/codec identity does not match the requested obligation');
  if(!object(input.documents)||Object.keys(input.documents).length>128||Buffer.byteLength(canonicalJson(input))>8*1024*1024)return pending('Schema document count/byte admission budget exceeded');
  for(const [file,document]of Object.entries(input.documents))if(!object(document)||typeof document.sha256!=='string'||sha(document.schema)!==document.sha256||file.startsWith('/')||file.includes('..')||file.includes('\\'))return pending('Schema manifest digest or repository-relative document identity is invalid');
  const gap=(reason:string):GraphNode=>{missing.add(reason);return {kind:'UNKNOWN',reason};};
  const resolve=(reference:string,from:string):GraphNode=>{
    const marker=reference.indexOf('#'),name=marker<0?reference:reference.slice(0,marker),fragment=marker<0?'':reference.slice(marker+1);
    if(/^[a-z][a-z0-9+.-]*:/i.test(name))return gap('External schema reference must be captured in the immutable manifest: '+name);
    const file=name?path.posix.normalize(path.posix.join(path.posix.dirname(from),name)):from;
    if(file.startsWith('../')||!Object.hasOwn(input.documents,file))return gap('Captured schema reference required: '+file);
    const key=file+'#'+fragment,existing=active.get(key);if(existing)return {kind:'REF',typeId:existing};
    const id=sha([input.repositoryId,input.revision,input.codecProfile,key,input.documents[file].sha256]);active.set(key,id);definitions[id]={kind:'UNKNOWN',reason:'Schema reference placeholder'};
    let value=input.documents[file].schema;
    if(fragment){if(!fragment.startsWith('/')){definitions[id]=gap('Named schema anchors require a captured anchor resolution profile');return {kind:'REF',typeId:id};}
      for(const encoded of fragment.slice(1).split('/')){let part:string;try{part=decodeURIComponent(encoded).replace(/~1/g,'/').replace(/~0/g,'~');}catch{definitions[id]=gap('Malformed schema reference pointer');return {kind:'REF',typeId:id};}if(!object(value)||!Object.hasOwn(value,part)){definitions[id]=gap('Schema pointer is absent: '+key);return {kind:'REF',typeId:id};}value=value[part];}
    }
    definitions[id]=lower(value,file,0);return {kind:'REF',typeId:id};
  };
  const lower=(schema:unknown,file:string,depth:number):GraphNode=>{
    if(++nodes>4096||depth>64)return gap('Schema graph node/depth budget exhausted');
    if(!object(schema))return gap('Boolean/unconstrained schema requires admitted-value or construction evidence');
    if(schema.$schema!==undefined&&schema.$schema!==input.dialect)return gap('Nested schema dialect differs from the qualified evidence dialect');
    if(schema.$id!==undefined)return gap('Schema $id base-URI changes require captured URI resolution qualification');
    const allowed=new Set(['$schema','$id','$defs','$ref','title','description','examples','default','deprecated','readOnly','writeOnly','type','properties','required','additionalProperties','items','prefixItems','minItems','maxItems','enum','const','anyOf']);
    const unsupported=Object.keys(schema).filter(key=>!allowed.has(key));if(unsupported.length)return gap('Unsupported schema assertion/composition: '+unsupported.sort().join(', '));
    if(schema.$ref!==undefined){if(typeof schema.$ref!=='string')return gap('Schema reference must be a string');if(Object.keys(schema).some(key=>!['$ref','$defs','$schema','$id','title','description'].includes(key)))return gap('Reference sibling assertions require conjunction qualification');return resolve(schema.$ref,file);}
    if(Array.isArray(schema.anyOf)){if(Object.keys(schema).some(key=>!['anyOf','$defs','$schema','title','description','examples','default','deprecated','readOnly','writeOnly'].includes(key)))return gap('Schema union sibling assertions require conjunction qualification');if(!schema.anyOf.length||schema.anyOf.length>64)return gap('Schema union alternative budget exceeded');return {kind:'UNION',types:schema.anyOf.map(value=>lower(value,file,depth+1))};}
    if(schema.enum!==undefined||schema.const!==undefined){
      if(schema.enum!==undefined&&schema.const!==undefined)return gap('Combined enum/const assertions require finite conjunction qualification');
      const values=schema.enum??[schema.const];if(!Array.isArray(values)||values.length===0||values.length>512)return gap('Finite schema enum required');
      const allowedType=(value:unknown,type:unknown)=>type==='null'?value===null:type==='integer'?typeof value==='number'&&Number.isInteger(value):typeof value===type;
      const filtered=schema.type===undefined?values:values.filter(value=>(Array.isArray(schema.type)?schema.type:[schema.type]).some(type=>allowedType(value,type)));
      if(!filtered.length)return gap('Schema enum/type conjunction has no admitted finite value; conformance evidence required');
      const types:GraphNode[]=filtered.map(value=>value===null?{kind:'NULL'}:['string','number','boolean'].includes(typeof value)?{kind:'LITERAL',value:value as string|number|boolean}:gap('Object/array enum requires finite literal-value graph qualification'));return types.length===1?types[0]:{kind:'UNION',types};
    }
    if(Array.isArray(schema.type))return {kind:'UNION',types:schema.type.map(type=>lower({...schema,type},file,depth+1))};
    if(schema.type==='null')return {kind:'NULL'};
    if(['string','number','boolean'].includes(String(schema.type)))return {kind:'PRIMITIVE',scalar:schema.type as 'string'|'number'|'boolean'};
    if(schema.type==='integer')return gap('Integer numeric subdomain requires qualified numeric constraint inclusion');
    if(schema.type==='array'){
      if(Array.isArray(schema.prefixItems)){if(schema.items!==false||schema.minItems!==schema.prefixItems.length||schema.maxItems!==schema.prefixItems.length)return gap('Variable schema tuple length requires positional language qualification');return {kind:'TUPLE',elements:schema.prefixItems.map(value=>lower(value,file,depth+1))};}
      if(schema.minItems!==undefined||schema.maxItems!==undefined)return gap('Array cardinality constraints require qualified inclusion');
      return {kind:'ARRAY',elementType:lower(schema.items,file,depth+1)};
    }
    if(schema.type==='object'){
      if(schema.additionalProperties!==undefined&&typeof schema.additionalProperties!=='boolean')return gap('Typed additionalProperties requires dictionary graph lowering');
      if(schema.required!==undefined&&(!Array.isArray(schema.required)||!schema.required.every(value=>typeof value==='string')))return gap('Schema required properties must be a string set');
      if(schema.properties!==undefined&&!object(schema.properties))return gap('Schema properties must be an object');
      const properties=schema.properties as Record<string,unknown>??{},required=new Set(schema.required as string[]??[]),names=[...new Set([...Object.keys(properties),...required])].sort();
      if(names.length>512)return gap('Schema object property budget exceeded');
      return {kind:'OBJECT',strict:schema.additionalProperties===false,properties:names.map(wireName=>({wireName,type:lower(properties[wireName],file,depth+1),optional:!required.has(wireName),nullable:false,validationConstraints:[]}))};
    }
    return gap('Explicit supported schema type required');
  };
  const root=resolve(input.root,''),typeId=root.kind==='REF'?root.typeId:'unresolved-root';if(root.kind!=='REF')definitions[typeId]=root;
  const graph:TypeGraph={version:'SAJIMORA_TYPE_GRAPH_V2',roots:{body:typeId},definitions,manifest:{snapshot:input.revision,serializerProfile:'DECLARED_JSON_V1',compilerProfile:'JSON_SCHEMA_2020_12_POSITIVE_V1',optionsHash:sha([expected,input.root]),sourceHashes:Object.fromEntries(Object.entries(input.documents).map(([file,document])=>[file,document.sha256])),missingEvidence:[...missing].sort()}};
  return {graph,status:missing.size?'EVIDENCE_REQUIRED':'DECLARED_CONTRACT',missingEvidence:[...missing].sort(),implementationConformance:'NOT_ESTABLISHED'};
}
