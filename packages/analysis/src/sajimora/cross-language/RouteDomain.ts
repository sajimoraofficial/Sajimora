import * as ts from 'typescript';
import {findBinding} from './ClientAstBindings';
import {sourceHash} from './CallIdentity';

export interface RouteDomain {
  readonly version:'SAJIMORA_ROUTE_DOMAIN_V1';
  readonly alternatives:readonly {url:string;path:string;host:string|null;query:readonly {key:string;value:string;repeated:boolean}[]}[];
  readonly pathComplete:boolean;
  readonly missingEvidence:readonly string[];
  readonly sourceEvidence:readonly {file:string;sha256:string}[];
}
interface Declarations {resolveImportedDeclaration(name:string,file:string):{node:ts.Node;file:string}|undefined;}
type Pieces=readonly (string|{expression:string;encoded:boolean})[];
/** Source-only finite route summaries. Unencoded values are never path parameters. */
export function deriveRouteDomain(expression:ts.Expression,resolver:Declarations):RouteDomain {
  const missing=new Set<string>(),sources=new Map<string,string>(),active=new Set<ts.Node>();let steps=512;
  type Environment=ReadonlyMap<ts.Node,ts.Expression>;
  const resolveTypeAlternatives = (typeNode: ts.TypeNode, d: number): string[] | undefined => {
    if (d > 8) return undefined;
    if (ts.isParenthesizedTypeNode(typeNode)) return resolveTypeAlternatives(typeNode.type, d + 1);
    if (ts.isLiteralTypeNode(typeNode)) {
      if (ts.isStringLiteral(typeNode.literal) || ts.isNoSubstitutionTemplateLiteral(typeNode.literal)) return [typeNode.literal.text];
      if (ts.isNumericLiteral(typeNode.literal)) return [typeNode.literal.text];
      if (typeNode.literal.kind === ts.SyntaxKind.TrueKeyword) return ['true'];
      if (typeNode.literal.kind === ts.SyntaxKind.FalseKeyword) return ['false'];
      return undefined;
    }
    if (ts.isUnionTypeNode(typeNode)) {
      const results: string[] = [];
      for (const member of typeNode.types) {
        const sub = resolveTypeAlternatives(member, d + 1);
        if (!sub) return undefined;
        results.push(...sub);
        if (results.length > 64) return undefined;
      }
      return results;
    }
    if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
      const typeName = typeNode.typeName.text;
      let typeDecl = findBinding(typeName, typeNode.typeName);
      if (typeDecl && ts.isImportSpecifier(typeDecl)) {
        typeDecl = resolver.resolveImportedDeclaration(typeName, typeNode.getSourceFile().fileName)?.node;
      }
      if (typeDecl && ts.isTypeAliasDeclaration(typeDecl)) {
        return resolveTypeAlternatives(typeDecl.type, d + 1);
      }
      if (typeDecl && ts.isEnumDeclaration(typeDecl)) {
        const results: string[] = [];
        for (const m of typeDecl.members) {
          if (m.initializer && (ts.isStringLiteral(m.initializer) || ts.isNoSubstitutionTemplateLiteral(m.initializer) || ts.isNumericLiteral(m.initializer))) {
            results.push(m.initializer.text);
          } else if (!m.initializer && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) {
            results.push(m.name.text);
          } else {
            return undefined;
          }
        }
        return results.length > 0 && results.length <= 64 ? results : undefined;
      }
    }
    return undefined;
  };
  // The evaluator returns alternatives, each containing ordered pieces.
  const evaluate=(node:ts.Expression,env:Environment,depth:number):Pieces[]=>{
    const sf=node.getSourceFile();sources.set(sf.fileName,sourceHash(sf));
    if(--steps<0||depth>32){missing.add('Route summary budget exceeded');return [];}
    if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isNonNullExpression(node)||ts.isTypeAssertionExpression(node))return evaluate(node.expression,env,depth+1);
    if(ts.isStringLiteralLike(node)||ts.isNumericLiteral(node))return [[node.text]];
    if(node.kind===ts.SyntaxKind.TrueKeyword)return [['true']];
    if(node.kind===ts.SyntaxKind.FalseKeyword)return [['false']];
    if(ts.isIdentifier(node)){
      let declaration=findBinding(node.text,node);const argument=declaration&&env.get(declaration);
      if(argument)return evaluate(argument,env,depth+1);
      if(declaration&&ts.isImportSpecifier(declaration))declaration=resolver.resolveImportedDeclaration(node.text,sf.fileName)?.node;
      if(declaration&&ts.isVariableDeclaration(declaration)&&declaration.initializer&&ts.isVariableDeclarationList(declaration.parent)&&(declaration.parent.flags&ts.NodeFlags.Const)){
        if(active.has(declaration)){missing.add('Cyclic route constant');return [];}
        active.add(declaration);const result=evaluate(declaration.initializer,env,depth+1);active.delete(declaration);return result;
      }
      const typeNode = declaration && (ts.isParameter(declaration) || ts.isVariableDeclaration(declaration)) ? declaration.type : undefined;
      if (typeNode) {
        const alts = resolveTypeAlternatives(typeNode, 0);
        if (alts && alts.length > 0 && alts.length <= 64) {
          return alts.map(a => [a]);
        }
      }
    }
    if((ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node))&&ts.isIdentifier(node.expression)){
      const propName = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined;
      if (propName) {
        let declaration=findBinding(node.expression.text,node.expression);
        if(declaration&&ts.isImportSpecifier(declaration))declaration=resolver.resolveImportedDeclaration(node.expression.text,sf.fileName)?.node;
        if(declaration&&ts.isEnumDeclaration(declaration)){
          const member=declaration.members.find(m=>(ts.isIdentifier(m.name)||ts.isStringLiteral(m.name))&&m.name.text===propName);
          if(member){
            if(member.initializer)return evaluate(member.initializer,env,depth+1);
            if(ts.isIdentifier(member.name)||ts.isStringLiteral(member.name))return [[member.name.text]];
          }
        }
        if(declaration&&ts.isVariableDeclaration(declaration)&&ts.isVariableDeclarationList(declaration.parent)&&(declaration.parent.flags&ts.NodeFlags.Const)){
          let initializer=declaration.initializer;if(initializer&&ts.isAsExpression(initializer))initializer=initializer.expression;
          if(initializer&&ts.isObjectLiteralExpression(initializer)){
            let mutated=false;const original=declaration;
            const scan=(child:ts.Node)=>{if(ts.isBinaryExpression(child)&&child.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&child.operatorToken.kind<=ts.SyntaxKind.LastAssignment&&ts.isPropertyAccessExpression(child.left)&&ts.isIdentifier(child.left.expression)&&findBinding(child.left.expression.text,child.left.expression)===original)mutated=true;ts.forEachChild(child,scan);};scan(declaration.getSourceFile());
            if(mutated){missing.add('Route configuration object is mutated; reaching definitions required');return [];}
            if(initializer.properties.some(p=>!ts.isPropertyAssignment(p)))return [[{expression:node.getText(),encoded:false}]];
            const property=initializer.properties.find(p=>ts.isPropertyAssignment(p)&&(ts.isIdentifier(p.name)||ts.isStringLiteral(p.name))&&p.name.text===propName);
            if(property&&ts.isPropertyAssignment(property))return evaluate(property.initializer,env,depth+1);
          }
        }
      }
    }
    const combine=(left:Pieces[],right:Pieces[]):Pieces[]=>{
      if(left.length*right.length>64){missing.add('Route finite-alternative limit 64 exceeded');return [];}
      return left.flatMap(a=>right.map(b=>[...a,...b]));
    };
    if(ts.isTemplateExpression(node)){
      let alternatives:Pieces[]=[[node.head.text]];
      for(const span of node.templateSpans)alternatives=combine(alternatives,evaluate(span.expression,env,depth+1).map(value=>[...value,span.literal.text]));
      return alternatives;
    }
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken)return combine(evaluate(node.left,env,depth+1),evaluate(node.right,env,depth+1));
    if(ts.isConditionalExpression(node)){
      if(node.condition.kind===ts.SyntaxKind.TrueKeyword)return evaluate(node.whenTrue,env,depth+1);
      if(node.condition.kind===ts.SyntaxKind.FalseKeyword)return evaluate(node.whenFalse,env,depth+1);
      const result=[...evaluate(node.whenTrue,env,depth+1),...evaluate(node.whenFalse,env,depth+1)];
      if(result.length>64){missing.add('Route finite-alternative limit 64 exceeded');return [];}return result;
    }
    if(ts.isCallExpression(node)){
      if(ts.isIdentifier(node.expression)){
        if(node.expression.text==='encodeURIComponent'&&!findBinding(node.expression.text,node.expression)&&node.arguments.length===1){
          const values=evaluate(node.arguments[0],env,depth+1);
          return values.map(pieces=>pieces.every(piece=>typeof piece==='string')?[encodeURIComponent(pieces.join(''))]:[{expression:node.arguments[0].getText().replace(/[{}]/g,'?'),encoded:true}]);
        }
        if(node.expression.text==='String'&&!findBinding('String',node.expression)&&node.arguments.length===1){
          return evaluate(node.arguments[0],env,depth+1);
        }
        let declaration=findBinding(node.expression.text,node.expression);
        if(declaration&&ts.isImportSpecifier(declaration))declaration=resolver.resolveImportedDeclaration(node.expression.text,sf.fileName)?.node;
        if(declaration&&ts.isVariableDeclaration(declaration))declaration=declaration.initializer;
        if(declaration&&(ts.isFunctionDeclaration(declaration)||ts.isFunctionExpression(declaration)||ts.isArrowFunction(declaration))&&declaration.body&&!active.has(declaration)&&!declaration.parameters.some(p=>p.dotDotDotToken||!ts.isIdentifier(p.name))){
          const body=ts.isBlock(declaration.body)?declaration.body.statements.length===1&&ts.isReturnStatement(declaration.body.statements[0])?declaration.body.statements[0].expression:undefined:declaration.body;
          if(body){
            const local=new Map(env);for(let index=0;index<declaration.parameters.length;index++){const parameter=declaration.parameters[index],argument=node.arguments[index]??parameter.initializer;if(argument)local.set(parameter,argument);}
            active.add(declaration);const result=evaluate(body,local,depth+1);active.delete(declaration);return result;
          }
        }
      }
      if(ts.isPropertyAccessExpression(node.expression)&&ts.isIdentifier(node.expression.name)){
        const methodName=node.expression.name.text;
        if(['toLowerCase','toUpperCase','trim','trimStart','trimEnd','toString'].includes(methodName)&&node.arguments.length===0){
          const receiverAlternatives=evaluate(node.expression.expression,env,depth+1);
          return receiverAlternatives.map(pieces=>{
            return pieces.map(piece=>{
              if(typeof piece==='string'){
                if(methodName==='toLowerCase')return piece.toLowerCase();
                if(methodName==='toUpperCase')return piece.toUpperCase();
                if(methodName==='trim')return piece.trim();
                if(methodName==='trimStart')return piece.trimStart();
                if(methodName==='trimEnd')return piece.trimEnd();
                return piece;
              }
              return {expression:`${piece.expression}.${methodName}()`,encoded:piece.encoded};
            });
          });
        }
      }
    }
    // A query placeholder is retained separately below. It never stands for a
    // slash-safe path value or a known query acceptance domain.
    return [[{expression:node.getText().replace(/[{}]/g,'?').slice(0,100),encoded:false}]];
  };
  const alternatives:RouteDomain['alternatives'][number][]=[];let pathComplete=true;
  for(const pieces of evaluate(expression,new Map(),0)){
    let url='',unsafePath=false,queryUnknown=false;
    for(const piece of pieces){
      if(typeof piece==='string'){url+=piece;continue;}
      if(url.includes('?')){url+='${queryValue}';queryUnknown=true;}
      else if(piece.encoded&&url.endsWith('/'))url+='${encoded:'+piece.expression+'}';
      else{unsafePath=true;url+='${unencoded:'+piece.expression+'}';missing.add(`Exact route binding/encoding required for ${piece.expression}`);}
    }
    // Encoded substitutions must occupy complete segments; a subsequent suffix
    // cannot silently turn them into a positional backend parameter.
    if(/\$\{encoded:[^}]+\}[^/?#]/.test(url)){unsafePath=true;missing.add('Encoded route parameter with a literal suffix requires segment-language comparison');}
    if(unsafePath){pathComplete=false;continue;}
    const [withoutFragment]=url.split('#'),queryIndex=withoutFragment.indexOf('?'),address=queryIndex<0?withoutFragment:withoutFragment.slice(0,queryIndex),queryText=queryIndex<0?'':withoutFragment.slice(queryIndex+1);
    const absolute=address.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]+)(\/.*)?$/i);
    if(!absolute&&!address.startsWith('/')){pathComplete=false;missing.add('Relative URL requires captured base URL/deployment context');continue;}
    const query: {key:string;value:string;repeated:boolean}[]=[];
    for(const pair of queryText.split('&').filter(Boolean)){const separator=pair.indexOf('='),key=separator<0?pair:pair.slice(0,separator),value=separator<0?'':pair.slice(separator+1);let decodedKey=key;try{decodedKey=decodeURIComponent(key.replace(/\+/g,' '));}catch{missing.add('Malformed percent encoding in query key');}query.push({key:decodedKey,value,repeated:queryText.split('&').filter(p=>p.split('=')[0]===key).length>1});}
    if(queryUnknown)missing.add('Endpoint path is resolved; dynamic query values, keys and constraints require qualification');
    alternatives.push({url:withoutFragment,path:absolute?.[2]??(absolute?'/':address),host:absolute?.[1]??null,query});
  }
  if(!alternatives.length)pathComplete=false;
  return {version:'SAJIMORA_ROUTE_DOMAIN_V1',alternatives:[...new Map(alternatives.map(a=>[a.url,a])).values()],pathComplete,missingEvidence:[...missing].sort(),sourceEvidence:[...sources].sort(([a],[b])=>a.localeCompare(b)).map(([file,sha256])=>({file,sha256}))};
}
