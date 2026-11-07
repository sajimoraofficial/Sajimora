import * as ts from 'typescript';
import {findBinding, importedFrom} from './ClientAstBindings';
import {UrlConstantResolver} from './UrlConstantResolver';
import {sourceHash} from './CallIdentity';

export type HttpOptionValue = (
  | {kind:'literal';value:string|number|boolean|null|undefined}
  | {kind:'object';fields:Map<string,HttpOptionValue>;unknownWrites:boolean}
  | {kind:'sequence';values:readonly HttpOptionValue[]}
  | {kind:'framework';name:string;arguments:readonly HttpOptionValue[];qualified:false;queryEmpty?:boolean}
  | {kind:'unknown';reason:string})&{sourceEvidence?:readonly {file:string;sha256:string}[]};
const unknown=(reason:string):HttpOptionValue=>({kind:'unknown',reason});
type Env=Map<ts.Node,HttpOptionValue>;
function join(a:HttpOptionValue,b:HttpOptionValue,context={remaining:512,pairs:new Map<HttpOptionValue,Map<HttpOptionValue,HttpOptionValue>>() }):HttpOptionValue {
  if(--context.remaining<0)return unknown('HTTP option branch-join budget exhausted');
  if(a.kind==='literal'&&b.kind==='literal'&&a.value===b.value)return a;
  if(a.kind==='unknown'&&b.kind==='unknown')return unknown(a.reason===b.reason?a.reason:[...new Set([a.reason,b.reason])].join('; ').slice(0,512));
  if(a.kind==='object'&&b.kind==='object'){
    const previous=context.pairs.get(a)?.get(b);if(previous)return previous;
    const fields=new Map<string,HttpOptionValue>();
    const result:HttpOptionValue={kind:'object',fields,unknownWrites:a.unknownWrites||b.unknownWrites};
    const pairs=context.pairs.get(a)??new Map();pairs.set(b,result);context.pairs.set(a,pairs);
    for(const key of new Set([...a.fields.keys(),...b.fields.keys()]))fields.set(key,join(a.fields.get(key)??unknown('Field absent on a branch'),b.fields.get(key)??unknown('Field absent on a branch'),context));
    return result;
  }
  return unknown('HTTP option alternatives require evidence');
}
function cloneEnv(env:Env):Env {
  const copied=new Map<HttpOptionValue,HttpOptionValue>();
  const copy=(value:HttpOptionValue):HttpOptionValue=>{
    if(value.kind!=='object')return value;
    const previous=copied.get(value);if(previous)return previous;
    const result:HttpOptionValue={...value,fields:new Map()};copied.set(value,result);
    for(const [key,field]of value.fields)result.fields.set(key,copy(field));return result;
  };
  return new Map([...env].map(([k,v])=>[k,copy(v)]));
}
/** Bounded source-only interpretation. Unknown effects never become compatible. */
export function summarizeHttpOptions(expression:ts.Expression,resolver:UrlConstantResolver):HttpOptionValue {
  let remaining=512;
  const active=new Set<ts.Node>();
  const sources=new Map<string,string>();
  let effect:string|undefined;
  const fail=(reason:string):HttpOptionValue=>{effect=reason;return unknown(reason);};
  const invalidate=(env:Env)=>{for(const value of env.values())if(value.kind==='object'){value.fields.clear();value.unknownWrites=true;}};
  const evaluate=(node:ts.Expression,env:Env,depth:number):HttpOptionValue=>{
    const source=node.getSourceFile();sources.set(source.fileName,sourceHash(source));
    if(--remaining<0||depth>32)return fail('HTTP option evaluation budget exhausted');
    if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isTypeAssertionExpression(node)||ts.isNonNullExpression(node))return evaluate(node.expression,env,depth+1);
    if(ts.isStringLiteralLike(node))return {kind:'literal',value:node.text};
    if(ts.isNumericLiteral(node))return {kind:'literal',value:Number(node.text)};
    if(node.kind===ts.SyntaxKind.TrueKeyword||node.kind===ts.SyntaxKind.FalseKeyword)return {kind:'literal',value:node.kind===ts.SyntaxKind.TrueKeyword};
    if(node.kind===ts.SyntaxKind.NullKeyword)return {kind:'literal',value:null};
    if(ts.isIdentifier(node)){
      let binding=findBinding(node.text,node);
      if(!binding&&node.text==='undefined')return {kind:'literal',value:undefined};
      if(binding&&env.has(binding))return env.get(binding)!;
      if(binding&&ts.isImportSpecifier(binding))binding=resolver.resolveImportedDeclaration(node.text,node.getSourceFile().fileName)?.node;
      if(binding&&ts.isVariableDeclaration(binding)&&binding.initializer&&ts.isVariableDeclarationList(binding.parent)&&(binding.parent.flags&ts.NodeFlags.Const)){
        if(active.has(binding))return unknown('Cyclic HTTP option constant');
        if(ts.isObjectLiteralExpression(binding.initializer)||ts.isArrayLiteralExpression(binding.initializer)){
          const targetBinding=binding;let mutated=false;
          const scan=(child:ts.Node)=>{
            if(ts.isBinaryExpression(child)&&child.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&child.operatorToken.kind<=ts.SyntaxKind.LastAssignment){let target=child.left;while(ts.isPropertyAccessExpression(target)||ts.isElementAccessExpression(target))target=target.expression;if(ts.isIdentifier(target)&&findBinding(target.text,target)===targetBinding)mutated=true;}
            if(ts.isVariableDeclaration(child)&&child!==targetBinding&&child.initializer&&ts.isIdentifier(child.initializer)&&findBinding(child.initializer.text,child.initializer)===targetBinding)mutated=true;
            if(ts.isCallExpression(child)){let target=child.expression;while(ts.isPropertyAccessExpression(target)||ts.isElementAccessExpression(target))target=target.expression;if(ts.isIdentifier(target)&&findBinding(target.text,target)===targetBinding)mutated=true;}
            ts.forEachChild(child,scan);
          };scan(binding.getSourceFile());
          if(mutated)return unknown('Captured HTTP option constant '+node.text+' has writes or aliases; reaching definitions required');
        }
        active.add(binding);const result=evaluate(binding.initializer,env,depth+1);active.delete(binding);return result;
      }
      return unknown(`Unresolved HTTP option binding ${node.text}`);
    }
    if(ts.isArrayLiteralExpression(node))return {kind:'sequence',values:node.elements.map(element=>ts.isSpreadElement(element)?unknown('HTTP option sequence spread requires a bounded summary'):evaluate(element,env,depth+1))};
    if(ts.isArrowFunction(node)||ts.isFunctionExpression(node))return unknown('Captured callback behavior requires an invoked operation summary');
    if(ts.isPropertyAccessExpression(node)){
      const receiver=evaluate(node.expression,env,depth+1);
      return receiver.kind==='object'?receiver.fields.get(node.name.text)??(receiver.unknownWrites?unknown(`Unknown option field ${node.name.text}`):{kind:'literal',value:undefined}):unknown(`Unresolved HTTP option field ${node.name.text}`);
    }
    if(ts.isPrefixUnaryExpression(node)&&node.operator===ts.SyntaxKind.ExclamationToken){const value=evaluate(node.operand,env,depth+1);return value.kind==='literal'?{kind:'literal',value:!value.value}:unknown('Unknown HTTP helper guard');}
    if(ts.isConditionalExpression(node)){
      const condition=evaluate(node.condition,env,depth+1);
      if(condition.kind==='literal')return evaluate(condition.value?node.whenTrue:node.whenFalse,env,depth+1);
      return join(evaluate(node.whenTrue,cloneEnv(env),depth+1),evaluate(node.whenFalse,cloneEnv(env),depth+1));
    }
    if(ts.isBinaryExpression(node)&&[ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)){
      const left=evaluate(node.left,env,depth+1);
      if(left.kind==='literal'){
        const right=node.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken?!!left.value:node.operatorToken.kind===ts.SyntaxKind.QuestionQuestionToken?left.value==null:!left.value;
        return right?evaluate(node.right,env,depth+1):left;
      }
      return join(left,evaluate(node.right,cloneEnv(env),depth+1));
    }
    if(ts.isBinaryExpression(node)&&[ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)){
      const left=evaluate(node.left,env,depth+1),right=evaluate(node.right,env,depth+1);
      if(left.kind==='literal'&&right.kind==='literal')return {kind:'literal',value:node.operatorToken.kind===ts.SyntaxKind.EqualsEqualsEqualsToken?left.value===right.value:left.value!==right.value};
      return unknown('HTTP helper comparison requires exact alternatives');
    }
    if(ts.isObjectLiteralExpression(node)){
      const fields=new Map<string,HttpOptionValue>();let unknownWrites=false;
      for(const property of node.properties){
        if(ts.isSpreadAssignment(property)){
          const spread=evaluate(property.expression,env,depth+1);
          if(spread.kind==='literal'&&(spread.value==null||spread.value===false))continue;
          if(spread.kind!=='object'||spread.unknownWrites){fields.clear();unknownWrites=true;}
          if(spread.kind==='object')for(const [key,value]of spread.fields)fields.set(key,value);
        }else if(ts.isPropertyAssignment(property)&&(ts.isIdentifier(property.name)||ts.isStringLiteral(property.name)))fields.set(property.name.text,evaluate(property.initializer,env,depth+1));
        else if(ts.isShorthandPropertyAssignment(property))fields.set(property.name.text,evaluate(property.name,env,depth+1));
        else {fields.clear();unknownWrites=true;fail('Computed/accessor HTTP options require effect evidence');}
      }
      return {kind:'object',fields,unknownWrites};
    }
    if(ts.isNewExpression(node)){
      const args=(node.arguments??[]).map(arg=>evaluate(arg,env,depth+1));invalidate(env);
      const binding=ts.isIdentifier(node.expression)?findBinding(node.expression.text,node):undefined;
      const empty=(value:HttpOptionValue|undefined)=>!value||value.kind==='literal'&&value.value===undefined||value.kind==='object'&&!value.unknownWrites&&[...value.fields].every(([key,entry])=>key==='fromObject'&&entry.kind==='literal'&&entry.value===undefined);
      const pinnedParams=(at:ts.Node)=>{
        const module=resolver.resolveModule('@angular/common/http',at.getSourceFile().fileName),index=module?.lastIndexOf('node_modules/@angular/common/')??-1;
        if(!module||index<0)return false;
        const packageFile=module.slice(0,index)+'node_modules/@angular/common/package.json',text=resolver.capturedText(packageFile);
        try{if(JSON.parse(text??'{}').version!=='20.3.28')return false;}catch{return false;}
        sources.set(packageFile,sourceHash(ts.createSourceFile(packageFile,text!,ts.ScriptTarget.Latest,true,ts.ScriptKind.JSON)));
        const declaration=resolver.resolveImportedDeclaration('HttpParams',at.getSourceFile().fileName)?.node;
        if(!declaration)return false;
        sources.set(declaration.getSourceFile().fileName,sourceHash(declaration.getSourceFile()));
        return true;
      };
      if(binding&&ts.isImportSpecifier(binding)&&importedFrom(binding,'@angular/common/http')&&['HttpHeaders','HttpParams'].includes(binding.propertyName?.text??binding.name.text))return {kind:'framework',name:binding.propertyName?.text??binding.name.text,arguments:args,qualified:false,queryEmpty:(binding.propertyName?.text??binding.name.text)==='HttpParams'&&empty(args[0])&&pinnedParams(node)};
      const declaration=binding&&ts.isImportSpecifier(binding)?resolver.resolveImportedDeclaration(binding.name.text,node.getSourceFile().fileName)?.node:binding;
      if(declaration&&ts.isClassDeclaration(declaration)){
        const bases=declaration.heritageClauses?.filter(clause=>clause.token===ts.SyntaxKind.ExtendsKeyword).flatMap(clause=>clause.types)??[],base=bases[0]?.expression;
        const baseBinding=base&&ts.isIdentifier(base)?findBinding(base.text,base):undefined;
        const ctor=declaration.members.find(ts.isConstructorDeclaration);
        const safeFields=!declaration.modifiers?.some(modifier=>ts.isDecorator(modifier))&&declaration.members.every(member=>(!ts.canHaveDecorators(member)||!ts.getDecorators(member)?.length)&&(ts.isConstructorDeclaration(member)||ts.isPropertyDeclaration(member)&&!member.initializer&&ts.isIdentifier(member.name)&&!['__proto__','constructor','toString','map','clone','updates','encoder','lazyInit','lazyUpdate'].includes(member.name.text)));
        if(bases.length===1&&baseBinding&&ts.isImportSpecifier(baseBinding)&&importedFrom(baseBinding,'@angular/common/http')&&(baseBinding.propertyName?.text??baseBinding.name.text)==='HttpParams'&&ctor?.body?.statements.length===1&&safeFields&&pinnedParams(base!)){
          const statement=ctor.body.statements[0],call=ts.isExpressionStatement(statement)?statement.expression:undefined;
          if(call&&ts.isCallExpression(call)&&call.expression.kind===ts.SyntaxKind.SuperKeyword&&call.arguments.length===1&&ctor.parameters.every(parameter=>ts.isIdentifier(parameter.name)&&!parameter.modifiers?.some(modifier=>ts.isDecorator(modifier))&&!parameter.dotDotDotToken&&!parameter.initializer&&!['__proto__','constructor','toString','map','clone','updates','encoder','lazyInit','lazyUpdate'].includes(parameter.name.text))){
            const local=new Map(env);ctor.parameters.forEach((parameter,index)=>local.set(parameter,args[index]??{kind:'literal',value:undefined}));
            const options=evaluate(call.arguments[0],local,depth+1);
            sources.set(declaration.getSourceFile().fileName,sourceHash(declaration.getSourceFile()));
            return {kind:'framework',name:'HttpParams',arguments:[options],qualified:false,queryEmpty:empty(options)};
          }
        }
      }
      return unknown(`Constructor ${node.expression.getText()} requires declaration, constructor and interceptor effect evidence`);
    }
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)){
      const args=node.arguments.map(arg=>evaluate(arg,env,depth+1));
      let declaration=findBinding(node.expression.text,node);
      if(declaration&&ts.isImportSpecifier(declaration))declaration=resolver.resolveImportedDeclaration(node.expression.text,node.getSourceFile().fileName)?.node;
      if(declaration&&ts.isVariableDeclaration(declaration)){
        if(!ts.isVariableDeclarationList(declaration.parent)||!(declaration.parent.flags&ts.NodeFlags.Const))return fail('Mutable HTTP helper binding');
        declaration=declaration.initializer;
      }
      if(declaration&&(ts.isFunctionDeclaration(declaration)||ts.isFunctionExpression(declaration)||ts.isArrowFunction(declaration))&&declaration.body){
        if(active.has(declaration))return fail('Recursive HTTP helper requires a bounded summary');
        if(('asteriskToken'in declaration&&declaration.asteriskToken)||declaration.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword))return fail('Async/generator HTTP helper');
        if(ts.isFunctionDeclaration(declaration)){
          const target=declaration;let reassigned=false;
          const scan=(n:ts.Node)=>{if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment&&ts.isIdentifier(n.left)&&findBinding(n.left.text,n.left)===target)reassigned=true;ts.forEachChild(n,scan);};scan(declaration.getSourceFile());
          if(reassigned)return fail('Reassigned HTTP helper requires invoked implementation evidence');
        }
        const local=new Map(env);
        for(let i=0;i<declaration.parameters.length;i++){
          const parameter=declaration.parameters[i];if(!ts.isIdentifier(parameter.name)||parameter.dotDotDotToken)return fail('Unsupported HTTP helper parameter');
          let value=args[i]??{kind:'literal',value:undefined}as HttpOptionValue;
          if(value.kind==='literal'&&value.value===undefined&&parameter.initializer)value=evaluate(parameter.initializer,local,depth+1);
          local.set(parameter,value);
        }
        active.add(declaration);
        const result=ts.isBlock(declaration.body)?execute([...declaration.body.statements],local,depth+1):evaluate(declaration.body,local,depth+1);
        active.delete(declaration);return result;
      }
      invalidate(env);return unknown(`Unsummarized HTTP option call ${node.expression.text}`);
    }
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)){
      if(ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==='Object'&&!findBinding('Object',node.expression.expression)&&node.expression.name.text==='assign'){
        const values=node.arguments.map(arg=>evaluate(arg,env,depth+1)),target=values[0];
        if(!target||target.kind!=='object')return fail('Object.assign target requires a captured plain object');
        for(const value of values.slice(1)){
          if(value.kind==='literal'&&value.value==null)continue;
          if(value.kind!=='object'||value.unknownWrites){target.fields.clear();target.unknownWrites=true;}
          if(value.kind==='object')for(const [key,field]of value.fields)target.fields.set(key,field);
        }
        return target;
      }
      invalidate(env);
      return unknown(`HTTP option operation ${node.expression.getText()} needs a behavior summary`);
    }
    return fail(`Unsupported HTTP option operation: ${ts.SyntaxKind[node.kind]}`);
  };
  const execute=(statements:readonly ts.Statement[],env:Env,depth:number):HttpOptionValue=>{
    if(--remaining<0||depth>32)return fail('HTTP helper statement budget exhausted');
    if(!statements.length)return {kind:'literal',value:undefined};
    const [statement,...rest]=statements;
    if(ts.isReturnStatement(statement))return statement.expression?evaluate(statement.expression,env,depth+1):{kind:'literal',value:undefined};
    if(ts.isVariableStatement(statement)){
      for(const binding of statement.declarationList.declarations){if(!ts.isIdentifier(binding.name))return fail('Unsupported HTTP helper destructuring');env.set(binding,binding.initializer?evaluate(binding.initializer,env,depth+1):{kind:'literal',value:undefined});}
      return execute(rest,env,depth+1);
    }
    if(ts.isIfStatement(statement)){
      const condition=evaluate(statement.expression,env,depth+1);
      const branch=(node:ts.Statement|undefined)=>node?(ts.isBlock(node)?[...node.statements]:[node]):[];
      if(condition.kind==='literal')return execute([...branch(condition.value?statement.thenStatement:statement.elseStatement),...rest],env,depth+1);
      return join(execute([...branch(statement.thenStatement),...rest],cloneEnv(env),depth+1),execute([...branch(statement.elseStatement),...rest],cloneEnv(env),depth+1));
    }
    if(ts.isSwitchStatement(statement)){
      const selector=evaluate(statement.expression,env,depth+1),clauses=statement.caseBlock.clauses;
      const cases=clauses.map(clause=>ts.isCaseClause(clause)?evaluate(clause.expression,env,depth+1):undefined);
      if(cases.some(value=>value&&value.kind!=='literal'))return fail('Switch case values require finite literal evidence');
      const branch=(index:number)=>{
        const selected:ts.Statement[]=[];
        for(const clause of clauses.slice(index)){for(const child of clause.statements){if(ts.isBreakStatement(child)){if(child.label)return fail('Labelled switch break requires control-flow evidence');return execute([...selected,...rest],cloneEnv(env),depth+1);}selected.push(child);}}
        return execute([...selected,...rest],cloneEnv(env),depth+1);
      };
      if(selector.kind==='literal'){
        let index=cases.findIndex(value=>value?.kind==='literal'&&value.value===selector.value);if(index<0)index=clauses.findIndex(ts.isDefaultClause);
        return index<0?execute(rest,env,depth+1):branch(index);
      }
      const alternatives=clauses.map((_,index)=>branch(index));if(!clauses.some(ts.isDefaultClause))alternatives.push(execute(rest,cloneEnv(env),depth+1));
      return alternatives.length?alternatives.reduce((left,right)=>join(left,right)):execute(rest,env,depth+1);
    }
    if(ts.isExpressionStatement(statement)&&ts.isBinaryExpression(statement.expression)&&statement.expression.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isIdentifier(statement.expression.left)){
      const binding=findBinding(statement.expression.left.text,statement.expression.left);
      if(!binding||!env.has(binding))return fail('HTTP helper writes outside its local environment');
      env.set(binding,evaluate(statement.expression.right,env,depth+1));return execute(rest,env,depth+1);
    }
    if(ts.isExpressionStatement(statement)&&ts.isBinaryExpression(statement.expression)&&statement.expression.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(statement.expression.left)){
      const left=statement.expression.left;
      if(!ts.isIdentifier(left.expression))return fail('HTTP helper property destination requires alias evidence');
      const binding=findBinding(left.expression.text,left.expression),receiver=binding&&env.get(binding);
      if(!receiver||receiver.kind!=='object'||left.name.text==='__proto__')return fail('HTTP helper writes outside a captured plain object');
      receiver.fields.set(left.name.text,evaluate(statement.expression.right,env,depth+1));return execute(rest,env,depth+1);
    }
    if(ts.isExpressionStatement(statement)&&ts.isCallExpression(statement.expression)){evaluate(statement.expression,env,depth+1);return execute(rest,env,depth+1);}
    return fail(`HTTP helper statement ${ts.SyntaxKind[statement.kind]} requires effect evidence`);
  };
  const result=evaluate(expression,new Map(),0);
  return {...(effect?unknown(effect):result),sourceEvidence:[...sources].sort(([a],[b])=>a.localeCompare(b)).map(([file,sha256])=>({file,sha256}))};
}
