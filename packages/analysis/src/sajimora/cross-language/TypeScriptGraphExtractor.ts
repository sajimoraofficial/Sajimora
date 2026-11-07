import * as ts from 'typescript';
import {createHash} from 'node:crypto';
import {canonicalJson} from './ContractArtifactEnvelope';
import {GraphNode,GraphProperty,TypeGraph} from './RecursiveWireGraph';
import {SnapshotModuleResolver} from './SnapshotModuleResolver';
import {snapshotSourceFile} from './SnapshotSourcePool';
import {sourceHash} from './CallIdentity';

type Declaration=ts.InterfaceDeclaration|ts.TypeAliasDeclaration|ts.ClassDeclaration;
type Binding={file:string;declarations:Declaration[]};
/** Positive source-declared structural fragment. Checker-dependent operators and
 * actual construction/serialization stay outside this extraction proof. */
export class TypeScriptGraphExtractor {
  private readonly modules:SnapshotModuleResolver;
  private readonly definitions:Record<string,GraphNode>=Object.create(null);
  private readonly hashes:Record<string,string>=Object.create(null);
  private readonly missing=new Set<string>();
  private instantiations=0;
  private snapshot='';
  constructor(private readonly files:ReadonlyMap<string,string>,private readonly budget={maxInstantiations:4096,maxDepth:64}){this.modules=new SnapshotModuleResolver(files);}
  extract(name:string,origin:string,snapshot:string):TypeGraph {
    for(const key of Object.keys(this.definitions))delete this.definitions[key];for(const key of Object.keys(this.hashes))delete this.hashes[key];this.missing.clear();this.instantiations=0;
    this.snapshot=snapshot;
    const rootSource=ts.createSourceFile('<graph-root>',`type __Root = ${name};`,ts.ScriptTarget.Latest,true);
    const declaration=rootSource.statements[0];
    const syntax=(rootSource as ts.SourceFile&{parseDiagnostics?:readonly ts.Diagnostic[]}).parseDiagnostics;
    const node=declaration&&ts.isTypeAliasDeclaration(declaration)&&rootSource.statements.length===1&&!syntax?.length?this.type(declaration.type,origin,new Map(),0):this.gap('Valid type root required');
    const root=node.kind==='REF'?node.typeId:this.id(['root',origin,name,snapshot]);
    if(node.kind!=='REF')this.definitions[root]=node;
    const project=this.modules.context(origin);
    const dependency=(this.files as ReadonlyMap<string,string>&{manifest?:()=>unknown;requests?:readonly {package:string;version?:string;integrity?:string;reason:string}[]}).manifest?.();
    const requests=(this.files as ReadonlyMap<string,string>&{requests?:readonly {package:string;version?:string;integrity?:string;reason:string}[]}).requests??[];
    return {version:'SAJIMORA_TYPE_GRAPH_V2',roots:{[name]:root},definitions:{...this.definitions},manifest:{snapshot,serializerProfile:'DECLARED_JSON_V1',compilerProfile:'TS_POSITIVE_SOURCE_V1:'+ts.version,optionsHash:project.optionsHash,...(dependency?{dependencyFingerprint:this.id(dependency)}:{}),sourceHashes:{...this.hashes},missingEvidence:[...this.missing,...project.missingEvidence,...requests.map(r=>[r.package,r.version??'exact version required',r.integrity??'',r.reason].filter(Boolean).join(': '))].sort()}};
  }
  private id(value:unknown):string{return createHash('sha256').update(canonicalJson(value)).digest('hex');}
  private gap(reason:string):GraphNode {this.missing.add(reason);return {kind:'UNKNOWN',reason};}
  private find(name:string,file:string,exported=false,visited=new Set<string>()):Binding|undefined {
    const key=file+'\0'+name+'\0'+exported;if(visited.has(key)||visited.size>128)return undefined;visited=new Set([...visited,key]);
    const sf=snapshotSourceFile(this.files,file);if(!sf)return undefined;this.hashes[file]=sourceHash(sf);
    const syntax=(sf as ts.SourceFile&{parseDiagnostics?:readonly ts.Diagnostic[]}).parseDiagnostics;if(syntax?.length){this.gap('Source syntax contract invalid: '+file+':TS'+syntax[0].code);return undefined;}
    const declarations=sf.statements.filter((s):s is Declaration=>(ts.isInterfaceDeclaration(s)||ts.isTypeAliasDeclaration(s)||ts.isClassDeclaration(s))&&((s.name?.text===name&&(!exported||ts.getModifiers(s)?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)))||(name==='default'&&!!ts.getModifiers(s)?.some(m=>m.kind===ts.SyntaxKind.DefaultKeyword))));
    if(declarations.length)return {file,declarations};
    for(const statement of sf.statements){
      if(!exported&&ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.importClause){
        const clause=statement.importClause;let imported:string|undefined;
        if(clause.name?.text===name)imported='default';
        const bindings=clause.namedBindings;
        if(bindings&&ts.isNamedImports(bindings)){const item=bindings.elements.find(e=>e.name.text===name);if(item)imported=item.propertyName?.text??item.name.text;}
        if(bindings&&ts.isNamespaceImport(bindings)&&name.startsWith(bindings.name.text+'.'))imported=name.slice(bindings.name.text.length+1);
        if(imported){const target=this.modules.resolve(statement.moduleSpecifier.text,file);return target?this.find(imported,target,true,visited):undefined;}
      }
      if(ts.isExportDeclaration(statement)&&statement.exportClause&&ts.isNamedExports(statement.exportClause)){
        const item=statement.exportClause.elements.find(e=>e.name.text===name);if(!item)continue;
        const target=statement.moduleSpecifier&&ts.isStringLiteral(statement.moduleSpecifier)?this.modules.resolve(statement.moduleSpecifier.text,file):file;
        return target?this.find(item.propertyName?.text??item.name.text,target,!!statement.moduleSpecifier,visited):undefined;
      }
    }
    const candidates:Binding[]=[];
    for(const statement of sf.statements)if(ts.isExportDeclaration(statement)&&!statement.exportClause&&statement.moduleSpecifier&&ts.isStringLiteral(statement.moduleSpecifier)){
      const target=this.modules.resolve(statement.moduleSpecifier.text,file),binding=target?this.find(name,target,true,visited):undefined;if(binding)candidates.push(binding);
    }
    const distinct=new Map(candidates.map(c=>[c.file+':'+c.declarations.map(d=>d.pos).join(','),c]));return distinct.size===1?[...distinct.values()][0]:undefined;
  }
  private instantiate(binding:Binding,args:readonly GraphNode[],depth:number):GraphNode {
    const declaration=binding.declarations[0],sf=declaration.getSourceFile();
    const project=this.modules.context(binding.file),environment=new Map<string,GraphNode>();
    const parameters=declaration.typeParameters??[];
    if(parameters.some(p=>p.constraint))return this.gap('Generic constraint qualification requires the pinned semantic normalizer: '+binding.file);
    if(args.length>parameters.length)return this.gap('Excess generic arguments for '+binding.file+':'+declaration.name?.text);
    for(let i=0;i<parameters.length;i++){const parameter=parameters[i];environment.set(parameter.name.text,args[i]??(parameter.default?this.type(parameter.default,binding.file,environment,depth+1):this.gap('Generic argument required: '+parameter.name.text)));}
    const id=this.id([this.snapshot,sourceHash(sf),binding.file,binding.declarations.map(d=>[d.getStart(sf),d.end]),[...environment],project.optionsHash,'DECLARED_JSON_V1']);
    if(Object.hasOwn(this.definitions,id))return {kind:'REF',typeId:id};
    if(++this.instantiations>this.budget.maxInstantiations)return this.gap('Growing generic/definition instantiation budget exhausted');
    this.definitions[id]={kind:'UNKNOWN',reason:'Unfinished extraction'};
    if(binding.declarations.some(ts.isClassDeclaration))this.definitions[id]=this.gap('Class construction/encoder summary required: '+binding.file+':'+declaration.name?.text);
    else if(ts.isTypeAliasDeclaration(declaration))this.definitions[id]=binding.declarations.length===1?this.type(declaration.type,binding.file,environment,depth+1):this.gap('Conflicting alias declarations: '+binding.file);
    else{
      const interfaces=binding.declarations.filter(ts.isInterfaceDeclaration);
      if(interfaces.some(d=>d.heritageClauses?.length))this.definitions[id]=this.gap('Interface heritage normalization required: '+binding.file+':'+declaration.name?.text);
      else this.definitions[id]=this.members(interfaces.flatMap(d=>[...d.members]),binding.file,environment,depth+1);
    }
    return {kind:'REF',typeId:id};
  }
  private members(members:readonly ts.TypeElement[],file:string,environment:ReadonlyMap<string,GraphNode>,depth:number):GraphNode {
    if(members.length>10000)return this.gap('Object field budget exhausted: '+file);
    const properties=new Map<string,GraphProperty>();
    for(const member of members){
      if(!ts.isPropertySignature(member)||!member.type||!member.name||!(ts.isIdentifier(member.name)||ts.isStringLiteral(member.name)||ts.isNumericLiteral(member.name)))return this.gap('Method/index/computed property requires semantic or encoder summary: '+file);
      const field:GraphProperty={wireName:member.name.text,type:this.type(member.type,file,environment,depth+1),optional:!!member.questionToken,nullable:false,validationConstraints:[]};
      const existing=properties.get(field.wireName);if(existing&&canonicalJson(existing)!==canonicalJson(field))return this.gap('Conflicting merged property: '+file+':'+field.wireName);
      properties.set(field.wireName,field);
    }
    return {kind:'OBJECT',strict:false,properties:[...properties.values()]};
  }
  private type(node:ts.TypeNode,file:string,environment:ReadonlyMap<string,GraphNode>,depth:number):GraphNode {
    if(depth>this.budget.maxDepth)return this.gap('Growing structural/generic depth budget exhausted');
    switch(node.kind){
      case ts.SyntaxKind.StringKeyword:return {kind:'PRIMITIVE',scalar:'string'};
      case ts.SyntaxKind.NumberKeyword:return {kind:'PRIMITIVE',scalar:'number'};
      case ts.SyntaxKind.BooleanKeyword:return {kind:'PRIMITIVE',scalar:'boolean'};
      case ts.SyntaxKind.UndefinedKeyword:return {kind:'ABSENT'};
    }
    if(ts.isParenthesizedTypeNode(node))return this.type(node.type,file,environment,depth+1);
    if(ts.isArrayTypeNode(node))return {kind:'ARRAY',elementType:this.type(node.elementType,file,environment,depth+1)};
    if(ts.isTupleTypeNode(node))return node.elements.some(e=>ts.isOptionalTypeNode(e)||ts.isRestTypeNode(e)||ts.isNamedTupleMember(e))?this.gap('Optional/rest/named tuple normalization required: '+file):{kind:'TUPLE',elements:node.elements.map(e=>this.type(e,file,environment,depth+1))};
    if(ts.isUnionTypeNode(node))return {kind:'UNION',types:node.types.map(n=>this.type(n,file,environment,depth+1))};
    if(ts.isLiteralTypeNode(node)){
      const literal=node.literal;if(literal.kind===ts.SyntaxKind.NullKeyword)return {kind:'NULL'};
      if(ts.isStringLiteral(literal))return {kind:'LITERAL',value:literal.text};if(ts.isNumericLiteral(literal))return Number.isFinite(Number(literal.text))?{kind:'LITERAL',value:Number(literal.text)}:this.gap('Nonfinite JSON numeric literal');
      if(literal.kind===ts.SyntaxKind.TrueKeyword||literal.kind===ts.SyntaxKind.FalseKeyword)return {kind:'LITERAL',value:literal.kind===ts.SyntaxKind.TrueKeyword};
      if(ts.isPrefixUnaryExpression(literal)&&literal.operator===ts.SyntaxKind.MinusToken&&ts.isNumericLiteral(literal.operand))return Number.isFinite(Number(literal.operand.text))?{kind:'LITERAL',value:-Number(literal.operand.text)}:this.gap('Nonfinite JSON numeric literal');
    }
    if(ts.isTypeLiteralNode(node))return this.members(node.members,file,environment,depth+1);
    if(ts.isTypeReferenceNode(node)){
      const name=node.typeName.getText();if(environment.has(name)&&!node.typeArguments?.length)return environment.get(name)!;
      const binding=this.find(name,file);return binding?this.instantiate(binding,(node.typeArguments??[]).map(a=>this.type(a,file,environment,depth+1)),depth+1):this.gap('Qualified declaration required: '+file+':'+name);
    }
    return this.gap('Unsupported positive source type '+ts.SyntaxKind[node.kind]+' at '+file);
  }
}
