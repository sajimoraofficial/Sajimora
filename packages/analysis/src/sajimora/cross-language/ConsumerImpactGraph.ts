import * as ts from 'typescript';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import { ConsumerSite } from './CrossLanguageContracts';
import { SnapshotModuleResolver } from './SnapshotModuleResolver';
import {CallIdentity, sourceHash} from './CallIdentity';
import {findBinding,importedFrom} from './ClientAstBindings';
import {snapshotSourceFile} from './SnapshotSourcePool';

export interface ConsumerSiteDetail extends ConsumerSite {
  readonly column: number;
  readonly consumerKind: 'PROPERTY_ACCESS' | 'DESTRUCTURING' | 'JSX_EXPRESSION' | 'ARGUMENT' | 'ASSIGNMENT' | 'RETURN' | 'BARREL_EXPORT' | 'TYPE_ALIAS';
  readonly propertyPath: string;
  readonly evidenceChain: readonly string[];
}

/** Sealed source-only receiver and import identity, including stale accesses. */
export class ConsumerImpactGraph {
  private program!: ts.Program;
  private checker!: ts.TypeChecker;
  private readonly files = new Map<string, string>();
  private readonly identifiers = new Map<string,ts.Identifier[]>();
  private readonly callIndexes = new Map<string, Map<number, ts.CallExpression>>();
  private modules!:SnapshotModuleResolver;
  private readonly aliasNames:ts.Identifier[]=[];
  private aliasesBySymbol?:Map<ts.Symbol,Set<string>>;
  private readonly referenceCache=new Map<ts.Symbol,ts.Identifier[]>();
  private projectKey?:string;
  private readonly projectGraphs=new Map<string,ConsumerImpactGraph>();

  constructor(private readonly inputFiles: ReadonlyMap<string, string>,private readonly demand?:{roots:readonly string[];maxFiles?:number}) {
    for (const [file,text]of inputFiles)this.files.set(path.posix.normalize(file.replace(/\\/g,'/')),text);
  }
  private initialize(origin?:string):void {
    if(this.program)return;
    const files=this.inputFiles;
    const modules = new SnapshotModuleResolver(files);
    this.modules=modules;
    for (const [file, text] of files) this.files.set(path.posix.normalize(file.replace(/\\/g, '/')), text);
    const entry=origin??this.demand?.roots[0]??[...files.keys()].find(f=>/\.(?:[jt]sx?|[mc][jt]s)$/.test(f))??'index.ts';
    const project=modules.context(entry);this.projectKey=project.optionsHash;
    if(project.missingEvidence.length)this.inventoryGap=project.missingEvidence.join('; ');
    const libraries=(files as ReadonlyMap<string,string>&{compilerLibraries?:(origin:string,options:ts.CompilerOptions)=>{defaultLibrary:string|null;missingEvidence:string[]}}).compilerLibraries?.(entry,project.options);
    if(libraries?.missingEvidence.length)this.inventoryGap=[this.inventoryGap,...libraries.missingEvidence].filter(Boolean).join('; ');
    for(const [file,text]of files)this.files.set(path.posix.normalize(file.replace(/\\/g,'/')),text);
    const options: ts.CompilerOptions = { ...project.options,noLib: project.options.noLib===true||!libraries?.defaultLibrary, allowJs:true, jsx: project.options.jsx??ts.JsxEmit.Preserve };
    let loadedFiles=0,loadedBytes=0;
    const host: ts.CompilerHost = {
      getSourceFile: (file, version) => {
        const text=this.inputFiles.get(file)??this.files.get(file);
        if(text!==undefined&&(++loadedFiles>5000||(loadedBytes+=Buffer.byteLength(text))>32*1024*1024)){this.inventoryGap='Consumer semantic closure exceeds 5000 files or 32 MiB source budget; deeper analysis required';return undefined;}
        return snapshotSourceFile(this.inputFiles,file)??snapshotSourceFile(this.files,file);
      },
      getDefaultLibFileName: () => libraries?.defaultLibrary??'', writeFile: () => {}, getCurrentDirectory: () => '',
      getDirectories: () => [], fileExists: file => this.files.has(file)||this.inputFiles.has(file), readFile: file => this.files.get(file)??this.inputFiles.get(file),
      getCanonicalFileName: file => file, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
      resolveModuleNames: (names, containingFile) => names.map(name => {
        const resolvedFileName = modules.resolve(name, containingFile);
        return resolvedFileName ? { resolvedFileName } : undefined;
      }),
    };
    let roots=[...this.files.keys()].filter(f => /\.(?:[jt]sx?|[mc][jt]s)$/.test(f) && !/\.d\.[cm]?ts$/.test(f)&&modules.context(f).optionsHash===project.optionsHash);
    if(this.demand){
      // A syntax-only reverse import inventory finds potential callers. External
      // declarations are acquired only when the resulting program needs them.
      const inventory=new SnapshotModuleResolver(new Map(this.files)),neighbors=new Map<string,Set<string>>();
      for(const file of roots){
        for(const imported of ts.preProcessFile(this.files.get(file)!,true,true).importedFiles){
          const target=inventory.resolve(imported.fileName,file);if(!target||/\.d\.ts$/.test(target))continue;
          const reverse=neighbors.get(target)??new Set<string>();reverse.add(file);neighbors.set(target,reverse);
        }
      }
      const selected=new Set(this.demand.roots.map(file=>file.replace(/\\/g,'/'))),queue=[...selected];
      for(let index=0;index<queue.length;index++)for(const file of neighbors.get(queue[index])??[])if(!selected.has(file)){selected.add(file);queue.push(file);}
      roots=roots.filter(file=>selected.has(file));
    }
    const maxFiles=this.demand?.maxFiles??5000;
    if(roots.length>maxFiles){this.inventoryGap=`Consumer source closure exceeds ${maxFiles} file budget; deeper analysis required`;roots=roots.slice(0,maxFiles);}
    this.program = ts.createProgram(roots, options, host);
    this.checker = this.program.getTypeChecker();
    for(const sf of this.program.getSourceFiles()) {
      if(sf.isDeclarationFile) continue;
      const calls=new Map<number,ts.CallExpression>();this.callIndexes.set(sf.fileName,calls);
      const visit=(node:ts.Node)=>{if(ts.isCallExpression(node))calls.set(node.getStart(sf),node);if(ts.isIdentifier(node)){const list=this.identifiers.get(node.text)??[];list.push(node);this.identifiers.set(node.text,list);if((ts.isImportSpecifier(node.parent)||ts.isExportSpecifier(node.parent))&&node.parent.name===node)this.aliasNames.push(node);}ts.forEachChild(node,visit);};visit(sf);
    }
  }
  private inventoryGap?:string;

  /** Bounded response flow. Unsupported operators, escapes and template bindings
   * remain explicit unresolved branches even when other consumers are found. */
  private forProject(file:string):ConsumerImpactGraph {
    this.initialize(file);
    const key=this.modules.context(file).optionsHash;
    if(key===this.projectKey)return this;
    let graph=this.projectGraphs.get(key);
    if(!graph){graph=new ConsumerImpactGraph(this.inputFiles,{roots:[file],maxFiles:this.projectGraphs.size>=4?0:this.demand?.maxFiles});this.projectGraphs.set(key,graph);}
    return graph;
  }
  public getSourceFile(file:string):ts.SourceFile|undefined {const graph=this.forProject(file);return graph===this?this.program.getSourceFile(file.replace(/\\/g,'/')):graph.getSourceFile(file);}
  public analyzeCallConsumers(file:string,line:number,callText?:string,column?:number,identity?:CallIdentity,transport?:{observe?:string|null}):{consumers:ConsumerSite[];complete:boolean;unresolved:string[]} {
    const graph=this.forProject(file);if(graph!==this)return graph.analyzeCallConsumers(file,line,callText,column,identity,transport);
    const sf=this.program.getSourceFile(file.replace(/\\/g,'/'));
    const consumers:ConsumerSite[]=[],unresolved=new Set<string>(),sites=new Set<string>();
    if(this.inventoryGap)unresolved.add(this.inventoryGap);
    if(!sf)return {consumers,complete:false,unresolved:[...unresolved,'Call source is absent from the sealed consumer program']};
    const calls:ts.CallExpression[]=[];
    if(identity){
      const call=this.callIndexes.get(sf.fileName)?.get(identity.startOffset);
      if(identity.file!==sf.fileName||identity.sourceSha256!==sourceHash(sf)||!call||call.getEnd()!==identity.endOffset)return {consumers,complete:false,unresolved:['INTERNAL_CALL_IDENTITY_DEFECT: source hash or AST span mismatch']};
      calls.push(call);
    }else for(const call of this.callIndexes.get(sf.fileName)?.values()??[]){const location=sf.getLineAndCharacterOfPosition(call.getStart(sf));if(location.line+1===line&&(!column||location.character+1===column)&&(!callText||call.getText(sf)===callText))calls.push(call);}
    if(calls.length!==1)return {consumers,complete:false,unresolved:['HTTP call identity is ambiguous or absent in consumer traversal']};
    let activeGuards:readonly string[]=[];
    let activeReturns:readonly {owner:ts.Node;site:ts.CallExpression}[]=[];
    let activeRole:'BODY'|'ENVELOPE'|'EVENTS'=identity?.adapterKind==='FETCH'||identity?.adapterKind==='AXIOS'||transport?.observe==='response'?'ENVELOPE':transport?.observe==='events'?'EVENTS':'BODY';
    let intermediateCount = 0;
    const intermediateSites = new Set<string>();
    const pathPool = new Map<string, string>();
    const intern = (s: string) => { let v = pathPool.get(s); if (!v) { v = s; pathPool.set(s, v); } return v; };

    const record=(node:ts.Node,propertyPath?:string,operation:'PROPERTY_READ'|'METHOD_CALL'='PROPERTY_READ')=>{
      const source=node.getSourceFile(),loc=source.getLineAndCharacterOfPosition(node.getStart(source));
      if (!propertyPath) {
        if (intermediateCount++ > 64) return;
      }
      const internedFile = intern(source.fileName);
      const internedPropPath = propertyPath ? intern(propertyPath) : undefined;
      const key=`${internedFile}:${node.pos}:${internedPropPath??''}:${operation}`;
      if(!sites.has(key)){
        sites.add(key);
        const guards=[...activeGuards];
        for(let ancestor:ts.Node|undefined=node.parent;ancestor&&!ts.isFunctionLike(ancestor);ancestor=ancestor.parent){
          if(ts.isIfStatement(ancestor)||ts.isConditionalExpression(ancestor)||ts.isTryStatement(ancestor)){
            guards.push('Branch/error reachability requires qualification at '+internedFile+':'+(source.getLineAndCharacterOfPosition(ancestor.getStart()).line+1));
          }
        }
        const distinctGuards = [...new Set(guards)].slice(0, 3);
        const text = node.getText(source).replace(/\s+/g, ' ').trim().slice(0, 120);
        consumers.push({
          file: internedFile,
          sourceSha256: sourceHash(source),
          line: loc.line + 1,
          usage: text,
          ...(distinctGuards.length ? { guards: distinctGuards } : {}),
          ...(internedPropPath ? { propertyPath: internedPropPath, operation, consumerKind: 'PROPERTY_ACCESS' as const, evidenceChain: [identity ? JSON.stringify(identity) : file + ':' + line] } : {})
        });
      }
    };
    const canonical=(symbol:ts.Symbol|undefined)=>symbol&&symbol.flags&ts.SymbolFlags.Alias?this.checker.getAliasedSymbol(symbol):symbol;
    const references=(name:ts.Identifier)=>{
      const symbol=canonical(this.checker.getSymbolAtLocation(name));if(!symbol){unresolved.add(`Unresolved response binding ${name.text}`);return [];}
      const cached=this.referenceCache.get(symbol);if(cached)return cached.filter(node=>node!==name);
      if(!this.aliasesBySymbol){
        this.aliasesBySymbol=new Map();
        for(const alias of this.aliasNames){const target=canonical(this.checker.getSymbolAtLocation(alias));if(target){const names=this.aliasesBySymbol.get(target)??new Set<string>();names.add(alias.text);this.aliasesBySymbol.set(target,names);}}
      }
      const names=new Set([name.text]);
      for(const alias of this.aliasesBySymbol.get(symbol)??[])names.add(alias);
      const result=[...names].flatMap(text=>this.identifiers.get(text)??[]).filter(node=>{const candidate=canonical(this.checker.getSymbolAtLocation(node));return candidate===symbol||!!candidate?.declarations?.some(declaration=>symbol.declarations?.includes(declaration));});
      this.referenceCache.set(symbol,result);return result.filter(node=>node!==name);
    };
    type Flow={node:ts.Node;stream:boolean;path:string;role:typeof activeRole;guards:readonly string[];returns:typeof activeReturns};
    const queue:Flow[]=[{node:calls[0],stream:true,path:'$',role:activeRole,guards:[],returns:[]}],seen=new Map<ts.Node,Set<string>>();
    const enqueue=(node:ts.Node,stream:boolean,path:string,role=activeRole,guards=activeGuards)=>queue.push({node,stream,path,role,guards:[...guards],returns:[...activeReturns]});
    const bind=(name:ts.BindingName,stream:boolean,path='$')=>{
      if(ts.isIdentifier(name))for(const reference of references(name))enqueue(reference,stream,path);
      else {record(name);for(const element of name.elements)if(ts.isBindingElement(element)){if(element.dotDotDotToken)unresolved.add('Response rest destructuring is unqualified');const key=element.propertyName?.getText()??element.name.getText();record(element,path+'.'+key);bind(element.name,false,path+'.'+key);}}
    };
    const callback=(node:ts.Node|undefined,path='$')=>{if(node&&(ts.isArrowFunction(node)||ts.isFunctionExpression(node))){for(const parameter of node.parameters.slice(0,1))bind(parameter.name,false,path);return true;}return false;};
    const operatorName=(expression:ts.Identifier):string|undefined=>{
      const binding=findBinding(expression.text,expression);
      if(!binding||!ts.isImportSpecifier(binding)||!(importedFrom(binding,'rxjs')||importedFrom(binding,'rxjs/operators')))return undefined;
      const imported=binding.propertyName?.text??binding.name.text;
      let declaration:ts.Node=binding;while(declaration.parent&&!ts.isImportDeclaration(declaration))declaration=declaration.parent;
      if(!ts.isImportDeclaration(declaration)||!ts.isStringLiteral(declaration.moduleSpecifier))return undefined;
      const resolved=this.modules.resolve(declaration.moduleSpecifier.text,expression.getSourceFile().fileName);
      if(!resolved)return undefined;
      const marker='node_modules/rxjs/',index=resolved.lastIndexOf(marker);
      if(index<0)return undefined;
      const manifest=this.inputFiles.get(resolved.slice(0,index)+marker+'package.json');
      try {if(JSON.parse(manifest??'{}').version!=='7.8.2')return undefined;}catch{return undefined;}
      return imported;
    };
    const projection=(node:ts.Node|undefined,inputPath:string):string|undefined=>{
      if(!node||!(ts.isArrowFunction(node)||ts.isFunctionExpression(node))||node.parameters.length!==1||!ts.isIdentifier(node.parameters[0].name))return undefined;
      let expression:ts.Expression|undefined=ts.isBlock(node.body)?(node.body.statements.length===1&&ts.isReturnStatement(node.body.statements[0])?node.body.statements[0].expression:undefined):node.body;
      const parts:string[]=[];
      while(expression&&ts.isPropertyAccessExpression(expression)){parts.unshift(expression.name.text);expression=expression.expression;}
      if(!expression||!ts.isIdentifier(expression)||findBinding(expression.text,expression)!==node.parameters[0])return undefined;
      return inputPath+(parts.length?'.'+parts.join('.'):'');
    };
    const transferPipe=(call:ts.CallExpression,start:number,inputPath:string)=>{
      let outputPath:string|undefined=inputPath;
      // A downstream error handler can consume exceptions from earlier reads.
      // Retain the reads, but do not present them as unconditional failures.
      if(call.arguments.some(a=>ts.isCallExpression(a)&&ts.isIdentifier(a.expression)&&operatorName(a.expression)==='catchError'))activeGuards=[...activeGuards,'RxJS catchError fallback/error reachability requires qualification'];
      for(const argument of call.arguments.slice(start)){
        if(!ts.isCallExpression(argument)||!ts.isIdentifier(argument.expression)){unresolved.add(`Unqualified RxJS operator: ${argument.getText().slice(0,80)}`);outputPath=undefined;continue;}
        const operator=operatorName(argument.expression);
        if(operator&&['tap','map','filter'].includes(operator)&&outputPath){
          if(!callback(argument.arguments[0],outputPath))unresolved.add(`Opaque RxJS ${operator} callback`);
          if(operator==='map'){outputPath=projection(argument.arguments[0],outputPath);if(!outputPath)unresolved.add('RxJS projection output requires contract reconciliation');}
          if(operator==='filter'){activeGuards=[...activeGuards,'RxJS filter predicate requires reachability qualification'];unresolved.add('RxJS filter output guard requires qualification');}
        }else if(operator&&['switchMap','mergeMap','concatMap','exhaustMap'].includes(operator)&&outputPath){
          if(!callback(argument.arguments[0],outputPath))unresolved.add(`Opaque RxJS ${operator} callback`);
          // The outer body ends here. Returned inner HTTP streams carry their
          // own call identities when independently traversed.
          outputPath=undefined;
        }else if(operator==='catchError'){
          unresolved.add('RxJS catchError fallback alternatives require a response contract');
        }else if(operator==='finalize'){
          unresolved.add('RxJS finalize side effects require a captured effect summary');
        }else{activeGuards=[...activeGuards,'Unqualified operator callback invocation and origin'];callback(argument.arguments[0],'?');unresolved.add(`Unqualified RxJS operator/version: ${argument.getText().slice(0,80)}`);outputPath=undefined;}
      }
      if(outputPath)enqueue(call,true,outputPath);
    };
    let flowStates=0;
    while(queue.length) {
      if(++flowStates>20000){unresolved.add('Response consumer flow-state budget exceeded');break;}
      const {node,stream,path,role,guards,returns}=queue.shift()!;activeRole=role;activeGuards=guards;activeReturns=returns;
      const localGuards: string[] = [];
      for(let ancestor:ts.Node|undefined=node.parent;ancestor&&!ts.isFunctionLike(ancestor);ancestor=ancestor.parent){
        if(ts.isIfStatement(ancestor)||ts.isConditionalExpression(ancestor)||ts.isTryStatement(ancestor)){
          localGuards.push('Branch/error reachability requires qualification at '+ancestor.getSourceFile().fileName+':'+(ancestor.getSourceFile().getLineAndCharacterOfPosition(ancestor.getStart()).line+1));
        }
      }
      activeGuards=[...new Set([...guards, ...localGuards])].slice(0, 3);
      const flags=seen.get(node)??new Set<string>();const state=stream+':'+path+':'+role+':'+guards.join(';')+':'+returns.map(r=>r.site.getSourceFile().fileName+':'+r.site.pos).join(';');if(flags.has(state))continue;flags.add(state);seen.set(node,flags);
      if(seen.size>10000){unresolved.add('Response consumer traversal budget exceeded');break;}
      const parent=node.parent;if(!parent)continue;
      if(ts.isParenthesizedExpression(parent)||ts.isAsExpression(parent)||ts.isNonNullExpression(parent)){enqueue(parent,stream,path);continue;}
      if(ts.isAwaitExpression(parent)){enqueue(parent,false,path);continue;}
      if(ts.isVariableDeclaration(parent)&&parent.initializer===node){record(parent);bind(parent.name,stream,path);continue;}
      if(ts.isPropertyAccessExpression(parent)&&parent.expression===node) {
        if(stream&&ts.isCallExpression(parent.parent)&&parent.parent.expression===parent) {
          const call=parent.parent,operator=parent.name.text;
          if(operator==='subscribe'||operator==='then') {
            let handled=callback(call.arguments[0],path);
            if(call.arguments[0]&&ts.isObjectLiteralExpression(call.arguments[0]))for(const property of call.arguments[0].properties)if(ts.isPropertyAssignment(property)&&property.name.getText()==='next')handled=callback(property.initializer,path)||handled;
            if(call.arguments.length&&!handled)unresolved.add('Opaque subscription callback');
            record(call);continue;
          }
          if(operator==='pipe') {
            transferPipe(call,0,path);continue;
          }
          unresolved.add(`Unqualified response wrapper: ${operator}`);record(call);continue;
        }
        if(stream)unresolved.add('Observable response accessed without a qualified unwrap');
        if(role==='ENVELOPE'){
          const member=parent.name.text;
          if(identity?.adapterKind==='FETCH'&&['json','text','arrayBuffer','blob'].includes(member)&&ts.isCallExpression(parent.parent)&&parent.parent.expression===parent){record(parent.parent);enqueue(parent.parent,true,'$','BODY');if(member!=='json')unresolved.add('Non-JSON body decoder requires transport/serialization qualification: '+member);continue;}
          if((identity?.adapterKind==='AXIOS'&&member==='data')||(identity?.adapterKind==='ANGULAR'&&member==='body')){enqueue(parent,false,'$','BODY');continue;}
          record(parent,'@transport.'+member);continue;
        }
        if(role==='EVENTS'){record(parent,'@events.'+parent.name.text);unresolved.add('Discriminated HTTP event/body guard requires qualification');continue;}
        const propertyPath=path+'.'+parent.name.text;record(parent,propertyPath);enqueue(parent,false,propertyPath);continue;
      }
      if(ts.isElementAccessExpression(parent)&&parent.expression===node){const key=parent.argumentExpression;let propertyPath=path;if(key&&ts.isNumericLiteral(key))propertyPath=path+'[]';else if(key&&ts.isStringLiteral(key))propertyPath=path+'.'+key.text;else unresolved.add('Dynamic response property/index access');record(parent,propertyPath);enqueue(parent,false,propertyPath);continue;}
      if((ts.isArrowFunction(parent)&&parent.body===node)||ts.isReturnStatement(parent)&&parent.expression===node){
        const owner=ts.isArrowFunction(parent)?parent:parent.parent.parent;
        const frame=activeReturns[activeReturns.length-1];
        if(ts.isArrowFunction(parent)&&frame?.owner===parent){activeReturns=activeReturns.slice(0,-1);enqueue(frame.site,stream||!!ts.getModifiers(parent)?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword),path);continue;}
        if((ts.isArrowFunction(owner)||ts.isFunctionExpression(owner))&&ts.isCallExpression(owner.parent)&&ts.isPropertyAccessExpression(owner.parent.expression)&&owner.parent.expression.name.text==='then'){enqueue(owner.parent,true,path);continue;}
        if((ts.isArrowFunction(owner)||ts.isFunctionExpression(owner))&&ts.isCallExpression(owner.parent)&&ts.isIdentifier(owner.parent.expression)){
          const operator=operatorName(owner.parent.expression),pipe=owner.parent.parent;
          if(operator&&['switchMap','mergeMap','concatMap','exhaustMap'].includes(operator)&&ts.isCallExpression(pipe)&&ts.isPropertyAccessExpression(pipe.expression)&&pipe.expression.name.text==='pipe'){
            transferPipe(pipe,pipe.arguments.findIndex(a=>a===owner.parent)+1,path);continue;
          }
        }
      }
      if(ts.isReturnStatement(parent)) {
        record(parent);let owner:ts.Node|undefined=parent.parent;
        while(owner&&!ts.isMethodDeclaration(owner)&&!ts.isFunctionDeclaration(owner)&&!ts.isArrowFunction(owner)&&!ts.isFunctionExpression(owner))owner=owner.parent;
        const frame=activeReturns[activeReturns.length-1];
        if(frame&&frame.owner===owner){activeReturns=activeReturns.slice(0,-1);enqueue(frame.site,stream||!!ts.getModifiers(owner as ts.FunctionDeclaration)?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword),path);continue;}
        if(owner&&(ts.isMethodDeclaration(owner)||ts.isFunctionDeclaration(owner))&&owner.name&&ts.isIdentifier(owner.name)) {
          for(const reference of references(owner.name))if(ts.isCallExpression(reference.parent)&&reference.parent.expression===reference)enqueue(reference.parent,stream,path);else if(ts.isPropertyAccessExpression(reference.parent)&&reference.parent.name===reference&&ts.isCallExpression(reference.parent.parent))enqueue(reference.parent.parent,stream,path);else unresolved.add('Response method reference escapes captured calls');
          unresolved.add('Returned response has an unqualified external entry point');
        } else unresolved.add('Response return from callback or anonymous wrapper requires reconciliation');
        continue;
      }
      if(ts.isBinaryExpression(parent)&&parent.right===node&&parent.operatorToken.kind===ts.SyntaxKind.EqualsToken){
        record(parent);
        if(ts.isIdentifier(parent.left))bind(parent.left,stream,path);
        else if(ts.isPropertyAccessExpression(parent.left)&&ts.isIdentifier(parent.left.name)&&parent.left.expression.kind===ts.SyntaxKind.ThisKeyword){
          for(const reference of references(parent.left.name))if(ts.isPropertyAccessExpression(reference.parent)&&reference.parent.name===reference&&reference.parent!==parent.left)enqueue(reference.parent,stream,path);
          this.recordTemplateReads(parent.left.name.text,parent,path,consumers,unresolved);
        }else unresolved.add('Response assignment destination requires reconciliation');
        unresolved.add('Response assignment and Angular template binding require reconciliation');continue;
      }
      if(ts.isCallExpression(parent)){
        if(parent.expression===node&&!stream&&role==='BODY'){record(parent,path,'METHOD_CALL');unresolved.add('Response method return/effects require an operation summary');continue;}
        record(parent);const argument=parent.arguments.findIndex(a=>a===node),symbol=canonical(this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(parent.expression)?parent.expression.name:parent.expression));
        const definitions=(symbol?.getDeclarations()??[]).flatMap(d=>ts.isVariableDeclaration(d)&&d.initializer&&(ts.isArrowFunction(d.initializer)||ts.isFunctionExpression(d.initializer))?[d.initializer]:[d]).filter((d):d is ts.FunctionDeclaration|ts.MethodDeclaration|ts.ArrowFunction|ts.FunctionExpression=>(ts.isFunctionDeclaration(d)||ts.isMethodDeclaration(d)||ts.isArrowFunction(d)||ts.isFunctionExpression(d))&&!!d.body);
        const owner=definitions.length===1?definitions[0]:undefined;
        if(owner&&argument>=0&&owner.parameters[argument]&&!owner.parameters.some(p=>p.dotDotDotToken)){
          if(activeReturns.length>=16||activeReturns.some(frame=>frame.owner===owner)){unresolved.add('Recursive function response summary requires SCC qualification');continue;}
          const previous=activeReturns;activeReturns=[...previous,{owner,site:parent}];bind(owner.parameters[argument].name,stream,path);activeReturns=previous;continue;
        }
        unresolved.add('Response passed to an opaque function');continue;
      }
      if(ts.isExpressionStatement(parent)||ts.isPropertyAccessExpression(parent)&&parent.name===node)continue;
      record(parent);unresolved.add(`Unqualified response use: ${ts.SyntaxKind[parent.kind]}`);
    }
    return {consumers,complete:unresolved.size===0,unresolved:[...unresolved].sort()};
  }

  private recordTemplateReads(field:string,assignment:ts.Node,originPath:string,consumers:ConsumerSite[],unresolved:Set<string>):void {
    let owner:ts.Node|undefined=assignment;while(owner&&!ts.isClassDeclaration(owner))owner=owner.parent;
    if(!owner||!ts.isClassDeclaration(owner))return;
    const sf=owner.getSourceFile();
    for(const decorator of ts.getDecorators(owner)??[]){
      if(!ts.isCallExpression(decorator.expression)||!ts.isIdentifier(decorator.expression.expression))continue;
      const binding=findBinding(decorator.expression.expression.text,decorator);
      if(!binding||!ts.isImportSpecifier(binding)||!importedFrom(binding,'@angular/core')||(binding.propertyName?.text??binding.name.text)!=='Component')continue;
      const metadata=decorator.expression.arguments[0];if(!metadata||!ts.isObjectLiteralExpression(metadata))continue;
      for(const property of metadata.properties){
        if(!ts.isPropertyAssignment(property)||!ts.isStringLiteralLike(property.initializer))continue;
        let text:string|undefined,file=sf.fileName,baseLine=sf.getLineAndCharacterOfPosition(property.initializer.getStart()).line;
        if(property.name.getText()==='template')text=property.initializer.text;
        if(property.name.getText()==='templateUrl'){file=path.posix.normalize(path.posix.join(path.posix.dirname(sf.fileName),property.initializer.text));text=this.files.get(file);baseLine=0;}
        if(text===undefined)continue;
        // Only direct interpolations are source witnesses. Full aliases, guards,
        // directives and inputs need the exact framework template checker.
        for(const match of text.matchAll(/\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\}\}/g)){
          const [root,...parts]=match[1].split('.');if(root!==field)continue;
          consumers.push({file,sourceSha256:file===sf.fileName?sourceHash(sf):createHash('sha256').update(this.files.get(file)!).digest('hex'),guards:['Exact Angular template reachability requires qualification'],line:baseLine+text.slice(0,match.index).split('\n').length,usage:match[0],consumerKind:'PROPERTY_ACCESS',propertyPath:originPath+'.'+parts.join('.'),evidenceChain:[`Component field ${sf.fileName}:${field}`,'Direct template interpolation; full template semantics pending']});
        }
        unresolved.add(`Exact Angular template parser/checker and binding inventory required for ${file}`);
      }
    }
  }

  public findPropertyConsumers(targetTypeName: string, propertyName: string, clientFile?: string): readonly ConsumerSiteDetail[] {
    return this.analyzePropertyConsumers(targetTypeName, propertyName, clientFile).consumers;
  }

  public analyzePropertyConsumers(targetTypeName: string, propertyName: string, clientFile?: string): { consumers: ConsumerSiteDetail[]; complete: boolean } {
    if(clientFile){const graph=this.forProject(clientFile);if(graph!==this)return graph.analyzePropertyConsumers(targetTypeName,propertyName,clientFile);}
    this.initialize(clientFile);
    const consumers: ConsumerSiteDetail[] = [];
    let complete = true;
    const canonical = (symbol: ts.Symbol): ts.Symbol => this.checker.getExportSymbolOfSymbol(symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol);
    const targets = new Set<ts.Symbol>();
    const origin = clientFile ? this.program.getSourceFile(clientFile.replace(/\\/g, '/')) : undefined;
    if (origin) {
      for (const symbol of this.checker.getSymbolsInScope(origin, ts.SymbolFlags.Type | ts.SymbolFlags.Alias)) {
        const resolved = canonical(symbol);
        const decl = resolved.declarations?.[0] ?? symbol.declarations?.[0];
        if (decl && this.program.isSourceFileDefaultLibrary(decl.getSourceFile())) continue;
        if (symbol.name === targetTypeName || resolved.name === targetTypeName) targets.add(resolved);
      }
    }
    if (!targets.size) return { consumers, complete: false };
    const matches = (type: ts.Type): boolean => {
      if (type.isUnion()) return type.types.some(matches);
      return [type.aliasSymbol, type.getSymbol()].some(symbol => symbol && targets.has(canonical(symbol)));
    };
    const record = (node: ts.Node, receiver: ts.Node, kind: ConsumerSiteDetail['consumerKind']) => {
      const type = this.checker.getTypeAtLocation(receiver);
      if (!matches(type)) {
        if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) complete = false;
        return;
      }
      const sf = node.getSourceFile();
      const loc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      consumers.push({ file: sf.fileName, line: loc.line + 1, column: loc.character + 1,
        usage: node.getText(sf), consumerKind: kind, propertyPath: `$.${propertyName}`,
        evidenceChain: [`Receiver resolves to '${targetTypeName}' from ${clientFile}`, `Access at ${sf.fileName}:${loc.line + 1}:${loc.character + 1}`] });
    };
    for (const sf of this.program.getSourceFiles()) {
      const visit = (node: ts.Node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === propertyName) record(node, node.expression, 'PROPERTY_ACCESS');
        if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === propertyName) record(node, node.expression, 'PROPERTY_ACCESS');
        if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
          const name = node.propertyName ?? node.name;
          if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === propertyName) {
            const declaration = node.parent.parent;
            if (ts.isVariableDeclaration(declaration) && declaration.initializer) record(node, declaration.initializer, 'DESTRUCTURING');
            else if (ts.isParameter(declaration)) record(node, declaration, 'DESTRUCTURING');
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return { consumers, complete };
  }
}
