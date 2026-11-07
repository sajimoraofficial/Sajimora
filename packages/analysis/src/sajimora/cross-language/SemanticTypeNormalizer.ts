import * as ts from 'typescript';
import {createHash} from 'node:crypto';
import {SnapshotModuleResolver} from './SnapshotModuleResolver';
import {GraphNode,TypeGraph} from './RecursiveWireGraph';
import {WireType} from './CanonicalContractIR';
import {canonicalJson} from './ContractArtifactEnvelope';

export interface SemanticNormalization {
  readonly status:'NORMALIZED'|'SOURCE_CONTRACT_INVALID'|'EVIDENCE_REQUIRED';
  readonly graph?:TypeGraph;
  readonly wireType?:WireType;
  readonly diagnostics:readonly {code:number;file?:string;line?:number;message:string}[];
  readonly missingEvidence:readonly string[];
}
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
/** One requested type and its captured import closure; never all repository roots. */
export class SemanticTypeNormalizer {
  private readonly cache=new Map<string,SemanticNormalization>();
  constructor(private readonly files:ReadonlyMap<string,string>,private readonly limits={maxFiles:512,maxBytes:16*1024*1024,maxNodes:4096}){}
  normalize(expression:string,origin:string,snapshot='captured'):SemanticNormalization {
    const missing=new Set<string>(),modules=new SnapshotModuleResolver(this.files),project=modules.context(origin);
    const key=sha(canonicalJson([snapshot,origin,this.files.get(origin),expression,project.optionsHash,this.files.size]));const cached=this.cache.get(key);if(cached)return cached;
    const finish=(result:SemanticNormalization)=>{this.cache.set(key,result);return result;};
    if(ts.version!=='5.9.3')return finish({status:'EVIDENCE_REQUIRED',diagnostics:[],missingEvidence:['Semantic normalizer requires qualified TypeScript 5.9.3']});
    if(!project.configFile)missing.add('Captured project configuration required for semantic normalization');
    for(const request of project.missingEvidence)missing.add(request);
    const libraries=(this.files as ReadonlyMap<string,string>&{compilerLibraries?:(origin:string,options:ts.CompilerOptions)=>{defaultLibrary:string|null;missingEvidence:string[]}}).compilerLibraries?.(origin,project.options);
    if(project.options.noLib!==true&&!libraries?.defaultLibrary)missing.add('Exact compiler standard-library declaration closure required');
    for(const request of libraries?.missingEvidence??[])missing.add(request);
    const original=this.files.get(origin);if(original===undefined)return finish({status:'EVIDENCE_REQUIRED',diagnostics:[],missingEvidence:['Captured type source required: '+origin]});
    const queryName='__SajimoraQuery_'+sha(expression).slice(0,16),source=original+'\n type '+queryName+' = '+expression+';\n';
    const probe=ts.createSourceFile(origin,source,ts.ScriptTarget.Latest,true),last=probe.statements[probe.statements.length-1];
    if(!ts.isTypeAliasDeclaration(last)||last.name.text!==queryName||probe.statements.length!==ts.createSourceFile(origin,original,ts.ScriptTarget.Latest,true).statements.length+1)return finish({status:'SOURCE_CONTRACT_INVALID',diagnostics:[],missingEvidence:['One valid type expression is required']});
    if(missing.size)return finish({status:'EVIDENCE_REQUIRED',diagnostics:[],missingEvidence:[...missing].sort()});
    let bytes=0,count=0;const hashes:Record<string,string>={},loaded=new Map<string,ts.SourceFile>();
    const host:ts.CompilerHost={
      getSourceFile:(file,version)=>{
        const cachedSource=loaded.get(file);if(cachedSource)return cachedSource;
        const text=file===origin?source:this.files.get(file);if(text===undefined){missing.add('Captured declaration/source required: '+file);return undefined;}
        if(++count>this.limits.maxFiles||(bytes+=Buffer.byteLength(text))>this.limits.maxBytes){missing.add('Semantic import closure exceeds file/source-byte budget');return undefined;}
        hashes[file]=sha(file===origin?original:text);const sf=ts.createSourceFile(file,text,version,true);loaded.set(file,sf);return sf;
      },getDefaultLibFileName:()=>libraries?.defaultLibrary??'',writeFile:()=>{},getCurrentDirectory:()=>'',getDirectories:()=>[],
      fileExists:file=>this.files.has(file)||file===origin,readFile:file=>file===origin?source:this.files.get(file),getCanonicalFileName:file=>file,useCaseSensitiveFileNames:()=>true,getNewLine:()=>'\n',
      resolveModuleNames:(names,containingFile)=>names.map(name=>{const resolvedFileName=modules.resolve(name,containingFile);if(!resolvedFileName)missing.add(`Exact captured module ${name} required by ${containingFile}`);return resolvedFileName?{resolvedFileName}:undefined;})
    };
    const program=ts.createProgram([origin],{...project.options,noLib:project.options.noLib===true||!libraries?.defaultLibrary},host),sf=program.getSourceFile(origin)!;
    const format=(diagnostic:ts.Diagnostic)=>({code:diagnostic.code,...(diagnostic.file?{file:diagnostic.file.fileName,line:diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start??0).line+1}:{}),message:ts.flattenDiagnosticMessageText(diagnostic.messageText,' ')});
    const syntax=program.getSyntacticDiagnostics(),semantic=program.getSemanticDiagnostics(),diagnostics=[...syntax,...semantic].map(format);
    if(syntax.length)return finish({status:'SOURCE_CONTRACT_INVALID',diagnostics,missingEvidence:[...missing]});
    if(missing.size)return finish({status:'EVIDENCE_REQUIRED',diagnostics,missingEvidence:[...missing].sort()});
    if(semantic.some(d=>[2307,2688,7016].includes(d.code)))return finish({status:'EVIDENCE_REQUIRED',diagnostics,missingEvidence:semantic.map(d=>'Captured dependency context: '+format(d).message)});
    if(semantic.length)return finish({status:'SOURCE_CONTRACT_INVALID',diagnostics,missingEvidence:[]});
    const checker=program.getTypeChecker(),alias=sf.statements[sf.statements.length-1] as ts.TypeAliasDeclaration;
    const definitions:Record<string,GraphNode>={},interned=new Map<ts.Type,string>();let nodes=0;
    const gap=(reason:string):GraphNode=>{missing.add(reason);return {kind:'UNKNOWN',reason};};
    const lower=(type:ts.Type,depth:number):GraphNode=>{
      if(depth>64||++nodes>this.limits.maxNodes)return gap('Semantic type-node/depth budget exhausted');
      const existing=interned.get(type);if(existing)return {kind:'REF',typeId:existing};
      const id=sha(canonicalJson([key,interned.size,checker.typeToString(type,alias,ts.TypeFormatFlags.NoTruncation)]));interned.set(type,id);definitions[id]={kind:'UNKNOWN',reason:'Type placeholder'};
      let node:GraphNode;const flags=type.flags;
      if(flags&(ts.TypeFlags.Any|ts.TypeFlags.Unknown))node=gap('Unconstrained semantic any/unknown domain requires an encoder/consumer obligation');
      else if(flags&ts.TypeFlags.Never)node=gap('Empty semantic type requires producer construction/reachability evidence');
      else if(flags&ts.TypeFlags.Null)node={kind:'NULL'};
      else if(flags&ts.TypeFlags.Undefined)node={kind:'ABSENT'};
      else if(flags&ts.TypeFlags.StringLiteral)node={kind:'LITERAL',value:(type as ts.StringLiteralType).value};
      else if(flags&ts.TypeFlags.NumberLiteral)node={kind:'LITERAL',value:(type as ts.NumberLiteralType).value};
      else if(flags&ts.TypeFlags.BooleanLiteral)node={kind:'LITERAL',value:checker.typeToString(type)==='true'};
      else if(flags&ts.TypeFlags.String)node={kind:'PRIMITIVE',scalar:'string'};
      else if(flags&ts.TypeFlags.Number)node={kind:'PRIMITIVE',scalar:'number'};
      else if(flags&ts.TypeFlags.Boolean)node={kind:'PRIMITIVE',scalar:'boolean'};
      else if(type.isUnion())node={kind:'UNION',types:type.types.map(t=>lower(t,depth+1))};
      else if(checker.isTupleType(type)){
        const tuple=type as ts.TupleTypeReference;
        if(tuple.target.elementFlags.some(flag=>flag&(ts.ElementFlags.Optional|ts.ElementFlags.Rest|ts.ElementFlags.Variadic)))node=gap('Optional/rest tuple requires positional language qualification');
        else node={kind:'TUPLE',elements:checker.getTypeArguments(tuple).map(t=>lower(t,depth+1))};
      }else if(checker.isArrayType(type)){
        const element=checker.getIndexTypeOfType(type,ts.IndexKind.Number);node=element?{kind:'ARRAY',elementType:lower(element,depth+1)}:gap('Array element declaration required');
      }else if(type.isIntersection()&&checker.typeToString(type,alias,ts.TypeFormatFlags.NoTruncation)==='never')node=gap('Empty semantic intersection requires producer construction/reachability evidence');
      else if(flags&(ts.TypeFlags.Object|ts.TypeFlags.Intersection)){
        if(type.getCallSignatures().length||type.getConstructSignatures().length)node=gap('Function/class construction domain requires serialization or hydration evidence');
        else if(checker.getIndexInfosOfType(type).length)node=gap('Index-signature key/value language requires graph dictionary lowering');
        else{
          const properties=checker.getPropertiesOfType(type).sort((a,b)=>a.getName().localeCompare(b.getName()));
          if(properties.length>512)node=gap('Semantic object property budget exceeded');
          else node={kind:'OBJECT',strict:false,properties:properties.map(symbol=>({wireName:symbol.getName(),type:lower(checker.getTypeOfSymbolAtLocation(symbol,symbol.valueDeclaration??symbol.declarations?.[0]??alias),depth+1),optional:!!(symbol.flags&ts.SymbolFlags.Optional),nullable:false,validationConstraints:[]}))};
        }
      }else node=gap('Unsupported semantic wire domain: '+checker.typeToString(type));
      definitions[id]=node;return {kind:'REF',typeId:id};
    };
    const lowered=lower(checker.getTypeFromTypeNode(alias.type),0),root=lowered.kind==='REF'?lowered:{kind:'REF' as const,typeId:sha(key+':budget-root')};
    if(lowered.kind!=='REF')definitions[root.typeId]=lowered;
    const dependency=(this.files as ReadonlyMap<string,string>&{manifest?:()=>unknown}).manifest?.();
    const graph:TypeGraph={version:'SAJIMORA_TYPE_GRAPH_V2',roots:{[expression]:root.typeId},definitions,manifest:{snapshot,serializerProfile:'DECLARED_JSON_V1',compilerProfile:'TS_SEMANTIC_V1:'+ts.version,optionsHash:project.optionsHash,sourceHashes:hashes,missingEvidence:[...missing].sort(),...(dependency?{dependencyFingerprint:sha(canonicalJson(dependency))}:{})}};
    const tree=graphToLegacyWire(graph,expression);
    return finish({status:missing.size?'EVIDENCE_REQUIRED':'NORMALIZED',graph,...(tree?{wireType:tree}:{}),diagnostics,missingEvidence:[...missing].sort()});
  }
}
/** Legacy IR can carry only acyclic JSON DTOs; references are never erased. */
export function graphToLegacyWire(graph:TypeGraph,root:string):WireType|undefined {
  const visit=(node:GraphNode,active:Set<string>,depth:number):WireType|undefined=>{
    if(depth>64)return undefined;
    if(node.kind==='REF'){if(active.has(node.typeId))return undefined;return visit(graph.definitions[node.typeId],new Set([...active,node.typeId]),depth+1);}
    if(node.kind==='NULL'||node.kind==='ABSENT'||node.kind==='TUPLE'||node.kind==='UNKNOWN')return undefined;
    if(node.kind==='OBJECT'){const properties=[];for(const property of node.properties){const type=visit(property.type,active,depth+1);if(!type)return undefined;properties.push({...property,type});}return {...node,properties};}
    if(node.kind==='ARRAY'){const elementType=visit(node.elementType,active,depth+1);return elementType?{kind:'ARRAY',elementType}:undefined;}
    if(node.kind==='UNION'){
      const dereference=(input:GraphNode):GraphNode|undefined=>{const seen=new Set<string>();while(input.kind==='REF'){if(seen.has(input.typeId))return undefined;seen.add(input.typeId);input=graph.definitions[input.typeId];}return input;};
      const alternatives=node.types.map(dereference);if(alternatives.some(t=>!t))return undefined;
      const nonNull=alternatives.filter((t):t is GraphNode=>!!t&&t.kind!=='NULL'&&t.kind!=='ABSENT'),types=nonNull.map(t=>visit(t,active,depth+1));if(types.some(t=>!t)||!types.length)return undefined;
      let type:WireType=types.length===1?types[0]!:{kind:'UNION',types:types as WireType[]};if(alternatives.some(t=>t?.kind==='NULL'))type={kind:'NULLABLE',innerType:type};if(alternatives.some(t=>t?.kind==='ABSENT'))type={kind:'OPTIONAL',innerType:type};return type;
    }
    if(node.kind==='NULLABLE'||node.kind==='OPTIONAL'){const innerType=visit(node.innerType,active,depth+1);return innerType?{kind:node.kind,innerType}:undefined;}
    return node.kind==='PRIMITIVE'||node.kind==='LITERAL'||node.kind==='ENUM'?node:undefined;
  };return visit({kind:'REF',typeId:graph.roots[root]},new Set(),0);
}
