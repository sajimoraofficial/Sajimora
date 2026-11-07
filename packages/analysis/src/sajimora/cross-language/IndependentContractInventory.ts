import * as ts from 'typescript';
import {createHash} from 'node:crypto';
import {ContractObligation,ObligationKind,obligationId} from './ContractQualification';

/** Discovery is independent of the wire model and adapters. Unreviewed candidates
 * are retained; callers must qualify binding, inheritance and wrapper coverage. */
export function discoverContractObligations(files: ReadonlyMap<string,string>, repository: string, revision: string): ContractObligation[] {
  const rows: ContractObligation[]=[];
  const add=(file:string,text:string,line:number,column:number,family:string,kind:ObligationKind,discoveryEvidence:string)=>{
    const source={repository,revision,file,sourceSha256:createHash('sha256').update(text).digest('hex'),line,column,family,kind};
    rows.push({...source,id:obligationId(source),discoveryEvidence});
  };
  let javaParser:any;
  try {const Parser=require('tree-sitter');javaParser=new Parser();javaParser.setLanguage(require('tree-sitter-java'));} catch { /* one failure obligation for every unparsed Java source */ }
  for(const [file,text] of files) {
    if(file.endsWith('.java')) {
      if(!javaParser){add(file,text,1,1,'java-discovery','DISCOVERY_FAILURE','Java structural parser unavailable');continue;}
      let tree:any;
      try {
        tree=javaParser.parse(text,undefined,{bufferSize:Math.max(32768,text.length*2+1024)});
        if(tree.rootNode.hasError) add(file,text,1,1,'java-discovery','DISCOVERY_FAILURE','Java syntax tree has errors');
        const visit=(node:any,controller=false,classHasPath=false)=>{
          const annotationName=(annotation:any)=>(annotation.childForFieldName('name')?.text??'').split('.').pop();
          if(['class_declaration','interface_declaration','record_declaration'].includes(node.type)) {
            const modifiers=node.namedChildren.find((child:any)=>child.type==='modifiers');
            controller=!!modifiers?.namedChildren.some((child:any)=>['annotation','marker_annotation'].includes(child.type)&&['RestController','Controller'].includes(annotationName(child)));
            classHasPath=!!modifiers?.namedChildren.some((child:any)=>['annotation','marker_annotation'].includes(child.type)&&annotationName(child)==='Path')||/@(?:(?:javax|jakarta)\.ws\.rs\.)?Path\b/.test(modifiers?.text??'');
          }
          if(node.type==='method_declaration') {
            const modifiers=node.namedChildren.find((child:any)=>child.type==='modifiers');
            const annotations=modifiers?.namedChildren.filter((child:any)=>['annotation','marker_annotation'].includes(child.type))??[];
            const mapping=annotations.find((child:any)=>['RequestMapping','GetMapping','PostMapping','PutMapping','PatchMapping','DeleteMapping'].includes(annotationName(child)));
            const jaxrs=annotations.find((child:any)=>['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(annotationName(child)));
            if(mapping||jaxrs) {
              const family=jaxrs?(classHasPath?'jaxrs-candidate':'unqualified-jaxrs'):controller?'spring-mvc':'unqualified-inherited-mapping';
              const name=node.childForFieldName('name')?.text??'<unnamed>';
              add(file,text,node.startPosition.row+1,node.startPosition.column+1,family,'RESPONSE',`${name}: ${(mapping??jaxrs).text}; all route alternatives require reconciliation`);
              const parameters=node.childForFieldName('parameters');
              for(const parameter of parameters?.namedChildren??[]) {
                if(/@(?:RequestBody|RequestParam|PathVariable|RequestHeader)\b/.test(parameter.text)) add(file,text,parameter.startPosition.row+1,parameter.startPosition.column+1,family,/@RequestBody\b/.test(parameter.text)?'REQUEST':'PARAMETER',parameter.text);
              }
            }
          }
          for(const child of node.namedChildren)visit(child,controller,classHasPath);
        };
        visit(tree.rootNode);
      } catch(error) {add(file,text,1,1,'java-discovery','DISCOVERY_FAILURE',String(error));}
      finally {tree?.delete?.();}
      continue;
    }
    if(!/\.[jt]sx?$/.test(file)||file.endsWith('.d.ts'))continue;
    const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
    if((sf as any).parseDiagnostics?.length)add(file,text,1,1,'typescript-discovery','DISCOVERY_FAILURE','TypeScript syntax tree has errors');
    const clientTypes=new Set<string>(), nonClientTypes=new Set<string>(),injectFactories=new Set<string>();
    for(const statement of sf.statements)if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.moduleSpecifier.text==='@angular/core'&&statement.importClause?.namedBindings&&ts.isNamedImports(statement.importClause.namedBindings))for(const specifier of statement.importClause.namedBindings.elements)if((specifier.propertyName?.text??specifier.name.text)==='inject')injectFactories.add(specifier.name.text);
    for(const statement of sf.statements)if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.moduleSpecifier.text==='@angular/common/http'&&statement.importClause?.namedBindings&&ts.isNamedImports(statement.importClause.namedBindings))for(const specifier of statement.importClause.namedBindings.elements){
      if((specifier.propertyName?.text??specifier.name.text)==='HttpClient')clientTypes.add(specifier.name.text);else nonClientTypes.add(specifier.name.text);
    }
    const clients=new Set<string>(),nonClients=new Set<string>();
    const find=(node:ts.Node)=>{
      if((ts.isPropertyDeclaration(node)||ts.isVariableDeclaration(node))&&node.initializer&&ts.isCallExpression(node.initializer)&&ts.isIdentifier(node.initializer.expression)&&injectFactories.has(node.initializer.expression.text)&&node.initializer.arguments.length===1&&ts.isIdentifier(node.initializer.arguments[0])&&clientTypes.has(node.initializer.arguments[0].text))clients.add(node.name.getText(sf));
      if((ts.isParameter(node)||ts.isPropertyDeclaration(node)||ts.isVariableDeclaration(node))&&node.type&&ts.isTypeReferenceNode(node.type)&&ts.isIdentifier(node.type.typeName)){
        const name=node.name.getText(sf),type=node.type.typeName.text;
        if(clientTypes.has(type))clients.add(name);if(nonClientTypes.has(type))nonClients.add(name);
      }
      ts.forEachChild(node,find);
    };find(sf);
    const visit=(node:ts.Node)=>{
      if(ts.isCallExpression(node)) {
        let family:string|undefined;
        if(ts.isIdentifier(node.expression)&&node.expression.text==='fetch')family='fetch-candidate';
        if(ts.isPropertyAccessExpression(node.expression)&&['get','post','put','patch','delete','head','options','request','jsonp'].includes(node.expression.name.text)) {
          const receiver=node.expression.expression.getText(sf),name=receiver.replace(/^this\./,'');
          if(clients.has(name))family='angular-httpclient';
          else if(!nonClients.has(name)&&/(?:http|axios|api|client)/i.test(receiver))family='unqualified-client-wrapper';
        }
        if(family){
          const location=sf.getLineAndCharacterOfPosition(node.getStart(sf));
          for(const kind of ['REQUEST','RESPONSE','CONSUMER'] as const)add(file,text,location.line+1,location.character+1,family,kind,node.getText(sf));
        }
      }
      ts.forEachChild(node,visit);
    };visit(sf);
  }
  return rows;
}
