import * as ts from 'typescript';
import {findBinding,importedFrom} from './ClientAstBindings';
import {UrlConstantResolver} from './UrlConstantResolver';
import {sourceHash} from './CallIdentity';

type Value={kind:'unknown'}|{kind:'nativeSource'}|{kind:'originContainer'}|{kind:'literal';value:string|number|boolean|null|undefined}|{kind:'request'}|{kind:'nullableRequest'}|{kind:'handler'}|{kind:'stream'}|{kind:'empty'};
type Env=Map<ts.Node,Value>;
const unknown:Value={kind:'unknown'},stream:Value={kind:'stream'},empty:Value={kind:'empty'};
const join=(a:Value,b:Value):Value=>a.kind===b.kind&&(a.kind!=='literal'||b.kind==='literal'&&a.value===b.value)?a:['stream','empty'].includes(a.kind)&&['stream','empty'].includes(b.kind)?stream:(a.kind==='request'&&b.kind==='literal'&&b.value==null||b.kind==='request'&&a.kind==='literal'&&a.value==null)?{kind:'nullableRequest'}:unknown;

/** Positive source-only success-event analysis. Error/retry/timing behavior stays
 * outside this proof. Recursive forwarding assumes preservation only while all
 * reachable returned operations are checked, with a real handler origin required. */
export function interceptorSuccessFlow(declaration:ts.ClassDeclaration,resolver:UrlConstantResolver,files:ReadonlyMap<string,string>,request:{url:string;bodyAbsent:boolean}):{qualified:boolean;missingEvidence:string[];sourceEvidence:{file:string;sha256:string}[]} {
  const gaps=new Set<string>(),sources=new Map<string,string>(),active=new Map<ts.Node,string>();let budget=4096,forwarded=false;
  const mark=(node:ts.Node)=>sources.set(node.getSourceFile().fileName,sourceHash(node.getSourceFile()));
  const gap=(node:ts.Node,reason:string):Value=>{gaps.add(`${node.getSourceFile().fileName}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line+1}: ${reason}`);return unknown;};
  const pinned=(module:string,origin:string,version:string)=>{
    const file=resolver.resolveModule(module,origin),marker='node_modules/'+(module.startsWith('@')?module.split('/').slice(0,2).join('/'):module.split('/')[0])+'/',index=file?.lastIndexOf(marker)??-1;
    if(!file||index<0)return false;const manifest=file.slice(0,index)+marker+'package.json',text=files.get(manifest);if(!text)return false;
    try{if(JSON.parse(text).version!==version)return false;sources.set(manifest,sourceHash(ts.createSourceFile(manifest,text,ts.ScriptTarget.Latest)));return true;}catch{return false;}
  };
  const operator=(node:ts.Expression):string|undefined=>{
    if(!ts.isIdentifier(node))return undefined;const binding=findBinding(node.text,node);
    if(!binding||!ts.isImportSpecifier(binding)||!(importedFrom(binding,'rxjs')||importedFrom(binding,'rxjs/operators'))||!pinned(importedFrom(binding,'rxjs/operators')?'rxjs/operators':'rxjs',node.getSourceFile().fileName,'7.8.2'))return undefined;
    return binding.propertyName?.text??binding.name.text;
  };
  const nativeProducer=(receiver:ts.Expression,name:string):boolean=>{
    if(!ts.isPropertyAccessExpression(receiver)||receiver.expression.kind!==ts.SyntaxKind.ThisKeyword)return false;
    const constructor=declaration.members.find(ts.isConstructorDeclaration),parameter=constructor?.parameters.find(p=>p.name.getText()===receiver.name.text);
    if(!parameter?.type||!ts.isTypeReferenceNode(parameter.type))return false;
    const target=resolver.resolveImportedDeclaration(parameter.type.typeName.getText(),declaration.getSourceFile().fileName)?.node;
    if(!target||!ts.isClassDeclaration(target))return false;mark(target);
    const method=target.members.find(member=>ts.isMethodDeclaration(member)&&member.name.getText()===name);
    if(!method||!ts.isMethodDeclaration(method)||!method.body)return false;
    const checked=new Set<ts.Node>();let remaining=512,constructed=false;
    const value=(expression:ts.Expression):boolean=>{
      if(--remaining<0)return false;
      if(ts.isParenthesizedExpression(expression)||ts.isAsExpression(expression)||ts.isNonNullExpression(expression))return value(expression.expression);
      if(expression.kind===ts.SyntaxKind.NullKeyword)return true;
      if(ts.isNewExpression(expression)&&ts.isIdentifier(expression.expression)){
        const binding=findBinding(expression.expression.text,expression.expression);
        if(binding&&ts.isImportSpecifier(binding)&&importedFrom(binding,'rxjs')&&['Observable','Subject','ReplaySubject','BehaviorSubject','AsyncSubject'].includes(binding.propertyName?.text??binding.name.text)&&pinned('rxjs',expression.getSourceFile().fileName,'7.8.2')){constructed=true;return true;}return false;
      }
      if(ts.isIdentifier(expression)){
        const binding=findBinding(expression.text,expression);if(!binding||!ts.isVariableDeclaration(binding)||!binding.initializer||checked.has(binding))return false;
        checked.add(binding);let admitted=value(binding.initializer);
        const scan=(node:ts.Node)=>{if(ts.isBinaryExpression(node)&&node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment&&ts.isIdentifier(node.left)&&findBinding(node.left.text,node.left)===binding)admitted=admitted&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&value(node.right);ts.forEachChild(node,scan);};scan(method.body!);checked.delete(binding);return admitted;
      }
      if(ts.isPropertyAccessExpression(expression)&&expression.expression.kind===ts.SyntaxKind.ThisKeyword){
        const field=target.members.find(member=>ts.isPropertyDeclaration(member)&&member.name.getText()===expression.name.text);
        if(!field||!ts.isPropertyDeclaration(field)||!field.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.PrivateKeyword)||!field.initializer||checked.has(field))return false;
        checked.add(field);let admitted=value(field.initializer);
        const scan=(node:ts.Node)=>{if(ts.isBinaryExpression(node)&&node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment&&ts.isPropertyAccessExpression(node.left)&&node.left.expression.kind===ts.SyntaxKind.ThisKeyword&&node.left.name.text===expression.name.text)admitted=admitted&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&value(node.right);ts.forEachChild(node,scan);};scan(target);checked.delete(field);return admitted;
      }return false;
    };
    const returns:ts.Expression[]=[];const collect=(node:ts.Node)=>{if(node!==method.body&&ts.isFunctionLike(node))return;if(ts.isReturnStatement(node)&&node.expression)returns.push(node.expression);else ts.forEachChild(node,collect);};collect(method.body);
    return returns.length>0&&returns.every(value)&&constructed;
  };
  const requestOrHandler=(value:Value)=>['request','nullableRequest','handler','originContainer'].includes(value.kind);
  const invoke=(fn:ts.FunctionLikeDeclaration,args:Value[],outer:Env,flowRequired=false):Value=>{
    mark(fn);const signature=JSON.stringify(args);if(active.has(fn))return active.get(fn)===signature?stream:gap(fn,'Recursive helper argument context changes require qualification');
    if(!fn.body||fn.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword))return gap(fn,'Captured synchronous helper body required');
    const capturesOrigin=(node:ts.Node):boolean=>ts.isIdentifier(node)&&requestOrHandler(outer.get(findBinding(node.text,node)!)??unknown)||ts.forEachChild(node,capturesOrigin)===true;
    let pureScalar=false;
    if(ts.isBlock(fn.body)&&fn.body.statements.length===1&&ts.isReturnStatement(fn.body.statements[0])&&fn.body.statements[0].expression){
      let nodes=0;pureScalar=true;const inspect=(node:ts.Node)=>{if(++nodes>80||ts.isCallExpression(node)||ts.isNewExpression(node)||ts.isFunctionLike(node)||ts.isDeleteExpression(node)||ts.isPostfixUnaryExpression(node)||ts.isBinaryExpression(node)&&node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment)pureScalar=false;ts.forEachChild(node,inspect);};inspect(fn.body.statements[0].expression);
    }
    // Scalar metadata stays unknown when it cannot access this request/handler.
    // Its unknown value still explores both guards; it never proves a body fact.
    if(!flowRequired&&!args.some(requestOrHandler)&&!capturesOrigin(fn.body)&&!pureScalar)return unknown;
    const local=new Map(outer);for(let index=0;index<fn.parameters.length;index++){const parameter=fn.parameters[index];if(!ts.isIdentifier(parameter.name)||parameter.dotDotDotToken)return gap(parameter,'Helper parameter binding requires qualification');local.set(parameter,args[index]??unknown);}
    active.set(fn,signature);const result=ts.isBlock(fn.body)?execute([...fn.body.statements],local):evaluate(fn.body,local);active.delete(fn);return result;
  };
  const evaluate=(node:ts.Expression,env:Env):Value=>{
    mark(node);if(--budget<0)return gap(node,'Interceptor success-flow budget exhausted');
    if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isNonNullExpression(node)||ts.isTypeAssertionExpression(node))return evaluate(node.expression,env);
    if(ts.isStringLiteralLike(node))return {kind:'literal',value:node.text};
    if(node.kind===ts.SyntaxKind.NullKeyword)return {kind:'literal',value:null};
    if(node.kind===ts.SyntaxKind.TrueKeyword||node.kind===ts.SyntaxKind.FalseKeyword)return {kind:'literal',value:node.kind===ts.SyntaxKind.TrueKeyword};
    if(ts.isIdentifier(node)){const binding=findBinding(node.text,node);if(binding&&env.has(binding))return env.get(binding)!;if(!binding&&node.text==='undefined')return {kind:'literal',value:undefined};return unknown;}
    if(ts.isPropertyAccessExpression(node)){
      const receiver=evaluate(node.expression,env);
      if(receiver.kind==='request'){if(node.name.text==='body'&&request.bodyAbsent)return {kind:'literal',value:null};if(node.name.text==='url')return request.url==='<dynamic>'||request.url.includes('${')?unknown:{kind:'literal',value:request.url};}
      if(receiver.kind==='literal'&&receiver.value==null&&node.questionDotToken)return {kind:'literal',value:undefined};
      return unknown;
    }
    if(ts.isPrefixUnaryExpression(node)&&node.operator===ts.SyntaxKind.ExclamationToken){const value=evaluate(node.operand,env);return value.kind==='literal'?{kind:'literal',value:!value.value}:unknown;}
    if(ts.isObjectLiteralExpression(node)){let tainted=false;for(const property of node.properties){if(ts.isPropertyAssignment(property))tainted=requestOrHandler(evaluate(property.initializer,env))||tainted;else if(ts.isShorthandPropertyAssignment(property))tainted=requestOrHandler(evaluate(property.name,env))||tainted;else if(ts.isSpreadAssignment(property))tainted=requestOrHandler(evaluate(property.expression,env))||tainted;}return tainted?{kind:'originContainer'}:unknown;}
    if(ts.isArrayLiteralExpression(node))return node.elements.some(element=>requestOrHandler(evaluate(ts.isSpreadElement(element)?element.expression:element as ts.Expression,env)))?{kind:'originContainer'}:unknown;
    if(ts.isNewExpression(node)&&node.arguments?.some(argument=>requestOrHandler(evaluate(argument,env))))return gap(node,'Opaque constructor receives the original request or handler');
    if(ts.isDeleteExpression(node)||ts.isPostfixUnaryExpression(node)||ts.isPrefixUnaryExpression(node)){let target=ts.isDeleteExpression(node)?node.expression:node.operand;while(ts.isPropertyAccessExpression(target)||ts.isElementAccessExpression(target))target=target.expression;if(requestOrHandler(evaluate(target,env)))return gap(node,'Request/handler unary mutation requires qualification');return unknown;}
    if(ts.isBinaryExpression(node)){
      const left=evaluate(node.left,env),token=node.operatorToken.kind;
      if(token===ts.SyntaxKind.EqualsToken){const value=evaluate(node.right,env);if(ts.isIdentifier(node.left)){const binding=findBinding(node.left.text,node.left);if(binding)env.set(binding,value);}else{let root=node.left;while(ts.isPropertyAccessExpression(root)||ts.isElementAccessExpression(root))root=root.expression;if(requestOrHandler(value)||requestOrHandler(evaluate(root,env)))return gap(node,'Request/handler mutation or escape requires qualification');}return value;}
      if([ts.SyntaxKind.BarBarToken,ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.QuestionQuestionToken].includes(token)){
        if(left.kind==='literal'){const useRight=token===ts.SyntaxKind.BarBarToken?!left.value:token===ts.SyntaxKind.AmpersandAmpersandToken?!!left.value:left.value==null;return useRight?evaluate(node.right,env):left;}
        const right=evaluate(node.right,new Map(env));if(right.kind==='literal'&&(token===ts.SyntaxKind.BarBarToken&&!!right.value||token===ts.SyntaxKind.AmpersandAmpersandToken&&!right.value))return right;return unknown;
      }
      const right=evaluate(node.right,env);
      if(left.kind==='literal'&&right.kind==='literal'&&[ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(token))return {kind:'literal',value:token===ts.SyntaxKind.EqualsEqualsEqualsToken?left.value===right.value:left.value!==right.value};return unknown;
    }
    if(ts.isConditionalExpression(node)){const condition=evaluate(node.condition,env);return condition.kind==='literal'?evaluate(condition.value?node.whenTrue:node.whenFalse,env):join(evaluate(node.whenTrue,new Map(env)),evaluate(node.whenFalse,new Map(env)));}
    if(ts.isCallExpression(node)){
      if(ts.isPropertyAccessExpression(node.expression)){
        const member=node.expression,receiver=evaluate(member.expression,env),name=member.name.text;
        if(receiver.kind==='handler'&&name==='handle'&&node.arguments.length===1){if(evaluate(node.arguments[0],env).kind!=='request')return gap(node,'Forwarded request target/body effects are unqualified');forwarded=true;return stream;}
        if(receiver.kind==='request'&&name==='clone'&&node.arguments.length===1&&ts.isObjectLiteralExpression(node.arguments[0])&&node.arguments[0].properties.every(p=>ts.isPropertyAssignment(p)&&(ts.isIdentifier(p.name)||ts.isStringLiteral(p.name))&&['headers','setHeaders'].includes(p.name.text))){evaluate(node.arguments[0],env);return receiver;}
        if(receiver.kind==='literal'&&typeof receiver.value==='string'&&name==='startsWith'&&node.arguments.length===1){const argument=evaluate(node.arguments[0],env);if(argument.kind==='literal'&&typeof argument.value==='string')return {kind:'literal',value:receiver.value.startsWith(argument.value)};}
        if(name==='pipe'){
          if(!['stream','empty','nativeSource'].includes(receiver.kind))return gap(node,'Source-visible native RxJS stream construction required before applying pipe semantics');
          let result=receiver;
          for(const op of node.arguments){if(!ts.isCallExpression(op))return gap(op,'Captured RxJS operator call required');const name=operator(op.expression),callback=op.arguments[0];
            if(name==='finalize'||name==='delay'){continue;}
            if(['switchMap','mergeMap','concatMap','exhaustMap'].includes(name??'')){if(!callback||!(ts.isArrowFunction(callback)||ts.isFunctionExpression(callback)))return gap(op,'Captured flattening callback required');result=invoke(callback,[unknown],env,true);continue;}
            if(name==='catchError'){if(!callback||!(ts.isArrowFunction(callback)||ts.isFunctionExpression(callback)))return gap(op,'Captured error callback required');result=join(result,invoke(callback,[unknown],env,true));continue;}
            return gap(op,'Response-transforming or unpinned RxJS operation requires qualification');
          }return result;
        }
        if(member.expression.kind===ts.SyntaxKind.ThisKeyword){const method=declaration.members.find(m=>ts.isMethodDeclaration(m)&&m.name.getText()===name);if(method&&ts.isMethodDeclaration(method))return invoke(method,node.arguments.map(arg=>evaluate(arg,env)),env);}
        if(nativeProducer(member.expression,name))return {kind:'nativeSource'};
      }
      if(ts.isIdentifier(node.expression)){
        const op=operator(node.expression);if(op==='throwError')return empty;if(op==='of')return node.arguments.length===0?empty:{kind:'nativeSource'};
        let binding=findBinding(node.expression.text,node.expression);if(binding&&ts.isImportSpecifier(binding))binding=resolver.resolveImportedDeclaration(node.expression.text,node.getSourceFile().fileName)?.node;
        if(binding&&ts.isVariableDeclaration(binding))binding=binding.initializer;
        if(binding&&(ts.isFunctionDeclaration(binding)||ts.isArrowFunction(binding)||ts.isFunctionExpression(binding)))return invoke(binding,node.arguments.map(arg=>evaluate(arg,env)),env);
      }
      if(node.arguments.some(arg=>requestOrHandler(evaluate(arg,env))))return gap(node,'Opaque call receives the original request or handler');
      return unknown;
    }
    return unknown;
  };
  const execute=(statements:readonly ts.Statement[],env:Env):Value=>{
    if(--budget<0)return gap(declaration,'Interceptor statement budget exhausted');if(!statements.length)return unknown;
    const [statement,...rest]=statements;
    if(ts.isReturnStatement(statement))return statement.expression?evaluate(statement.expression,env):empty;
    if(ts.isThrowStatement(statement))return empty;
    if(ts.isVariableStatement(statement)){for(const binding of statement.declarationList.declarations)env.set(binding,binding.initializer?evaluate(binding.initializer,env):unknown);return execute(rest,env);}
    if(ts.isIfStatement(statement)){
      const condition=evaluate(statement.expression,env),branch=(node:ts.Statement|undefined)=>node?(ts.isBlock(node)?[...node.statements]:[node]):[];
      if(condition.kind==='literal')return execute([...branch(condition.value?statement.thenStatement:statement.elseStatement),...rest],env);
      const yes=new Map(env),no=new Map(env);if(ts.isIdentifier(statement.expression)){const binding=findBinding(statement.expression.text,statement.expression);if(binding&&env.get(binding)?.kind==='nullableRequest'){yes.set(binding,{kind:'request'});no.set(binding,{kind:'literal',value:null});}}
      return join(execute([...branch(statement.thenStatement),...rest],yes),execute([...branch(statement.elseStatement),...rest],no));
    }
    if(ts.isExpressionStatement(statement)){evaluate(statement.expression,env);return execute(rest,env);}
    if(ts.isBlock(statement))return execute([...statement.statements,...rest],env);
    const referencesOrigin=(node:ts.Node):boolean=>ts.isIdentifier(node)&&!!findBinding(node.text,node)&&requestOrHandler(env.get(findBinding(node.text,node)!)??unknown)||ts.forEachChild(node,referencesOrigin)===true;
    if(referencesOrigin(statement))return gap(statement,'Unsupported control flow can mutate or escape the request/handler');
    // Unknown statements in scalar metadata helpers cannot qualify a stream.
    return unknown;
  };
  mark(declaration);
  if(!pinned('@angular/common/http',declaration.getSourceFile().fileName,'20.3.28'))return {qualified:false,missingEvidence:['Exact Angular HTTP 20.3.28 declaration profile required'],sourceEvidence:[]};
  if(declaration.heritageClauses?.some(clause=>clause.token===ts.SyntaxKind.ExtendsKeyword)||declaration.members.some(member=>ts.isConstructorDeclaration(member)&&!!member.body?.statements.length||ts.isPropertyDeclaration(member)&&member.initializer&&!ts.isStringLiteralLike(member.initializer)&&!ts.isNumericLiteral(member.initializer)&&![ts.SyntaxKind.TrueKeyword,ts.SyntaxKind.FalseKeyword,ts.SyntaxKind.NullKeyword].includes(member.initializer.kind)))return {qualified:false,missingEvidence:['Interceptor initialization/inheritance effects require qualification'],sourceEvidence:[]};
  const method=declaration.members.find(member=>ts.isMethodDeclaration(member)&&member.name.getText()==='intercept');
  if(!method||!ts.isMethodDeclaration(method)||method.parameters.length!==2)return {qualified:false,missingEvidence:['Unique interceptor entry method required'],sourceEvidence:[]};
  const result=invoke(method,[{kind:'request'},{kind:'handler'}],new Map());
  return {qualified:result.kind==='stream'&&forwarded&&!gaps.size,missingEvidence:[...gaps,...(result.kind!=='stream'?['Returned successful event domain is unqualified']:[])],sourceEvidence:[...sources].map(([file,sha256])=>({file,sha256}))};
}
