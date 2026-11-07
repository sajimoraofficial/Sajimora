import * as ts from 'typescript';
import {createHash} from 'node:crypto';
import {findBinding} from './ClientAstBindings';
import {GraphNode,TypeGraph} from './RecursiveWireGraph';
import {sourceHash} from './CallIdentity';

export interface TransportBody {
  readonly version:'SAJIMORA_TRANSPORT_BODY_V1';
  readonly kind:'JSON'|'TEXT'|'BINARY'|'MULTIPART'|'FORM'|'ABSENT'|'UNRESOLVED';
  readonly encoderId:string|null;
  readonly status:'ENCODED_DOMAIN'|'SOURCE_CONTRACT_INVALID'|'EVIDENCE_REQUIRED';
  readonly valueGraph?:TypeGraph;
  readonly missingEvidence:readonly string[];
  readonly assumptions:readonly string[];
  readonly sourceEvidence:readonly {file:string;sha256:string}[];
}
/** Recover actual argument values. Type assertions do not change encoded bytes. */
export function deriveTransportBody(expression:ts.Expression|undefined,profile:{encoderId?:'ECMASCRIPT_JSON_V1';snapshot?:string}={}):TransportBody {
  if(!expression)return {version:'SAJIMORA_TRANSPORT_BODY_V1',kind:'ABSENT',encoderId:null,status:'ENCODED_DOMAIN',missingEvidence:[],assumptions:[],sourceEvidence:[]};
  const missing=new Set<string>(),sources=new Map<string,string>(),active=new Set<ts.Node>();let budget=1024,invalid=false;
  const gap=(reason:string):GraphNode=>{missing.add(reason);return {kind:'UNKNOWN',reason};};
  const evaluate=(node:ts.Expression,depth:number):GraphNode=>{
    sources.set(node.getSourceFile().fileName,sourceHash(node.getSourceFile()));
    if(--budget<0||depth>64)return gap('Request value/depth budget exhausted');
    if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isTypeAssertionExpression(node)||ts.isNonNullExpression(node))return evaluate(node.expression,depth+1);
    if(ts.isStringLiteralLike(node))return {kind:'LITERAL',value:node.text};
    if(ts.isNumericLiteral(node))return {kind:'LITERAL',value:Number(node.text)};
    if(node.kind===ts.SyntaxKind.NullKeyword)return {kind:'NULL'};
    if(node.kind===ts.SyntaxKind.TrueKeyword||node.kind===ts.SyntaxKind.FalseKeyword)return {kind:'LITERAL',value:node.kind===ts.SyntaxKind.TrueKeyword};
    if(ts.isBigIntLiteral(node)){invalid=true;return gap('Standard JSON serialization rejects a BigInt value');}
    if(ts.isPrefixUnaryExpression(node)&&node.operator===ts.SyntaxKind.MinusToken&&ts.isNumericLiteral(node.operand))return {kind:'LITERAL',value:-Number(node.operand.text)};
    if(ts.isArrowFunction(node)||ts.isFunctionExpression(node))return {kind:'ABSENT'};
    if(ts.isIdentifier(node)){
      const binding=findBinding(node.text,node);
      if(!binding&&node.text==='undefined')return {kind:'ABSENT'};
      if(!binding&&['NaN','Infinity'].includes(node.text))return {kind:'NULL'};
      if(binding&&ts.isFunctionDeclaration(binding))return {kind:'ABSENT'};
      if(binding&&ts.isVariableDeclaration(binding)&&binding.initializer){
        if(active.has(binding))return gap('Cyclic request construction requires identity/encoder qualification');
        let mutated=false;
        const scan=(child:ts.Node)=>{
          if(ts.isCallExpression(child)){
            const safeStringify=ts.isPropertyAccessExpression(child.expression)&&ts.isIdentifier(child.expression.expression)&&child.expression.expression.text==='JSON'&&child.expression.name.text==='stringify'&&!findBinding('JSON',child.expression.expression)&&child.arguments.length===1;
            const referencesBinding=(part:ts.Node):boolean=>{if(ts.isIdentifier(part)&&findBinding(part.text,part)===binding)return true;return ts.forEachChild(part,referencesBinding)??false;};
            if(!safeStringify&&(referencesBinding(child.expression)||child.arguments.some(referencesBinding)))mutated=true;
          }
          if(ts.isVariableDeclaration(child)&&child!==binding&&child.initializer&&ts.isIdentifier(child.initializer)&&findBinding(child.initializer.text,child.initializer)===binding)mutated=true;
          if(ts.isBinaryExpression(child)&&child.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&child.operatorToken.kind<=ts.SyntaxKind.LastAssignment){let target:ts.Expression=child.left;while(ts.isPropertyAccessExpression(target)||ts.isElementAccessExpression(target))target=target.expression;if(ts.isIdentifier(target)&&findBinding(target.text,target)===binding)mutated=true;}
          if(ts.isPrefixUnaryExpression(child)||ts.isPostfixUnaryExpression(child)){const target=child.operand;if(ts.isIdentifier(target)&&findBinding(target.text,target)===binding)mutated=true;}
          ts.forEachChild(child,scan);
        };scan(binding.getSourceFile());
        if(mutated)return gap('Request binding '+node.text+' is mutated; reaching definitions required');
        active.add(binding);const value=evaluate(binding.initializer,depth+1);active.delete(binding);return value;
      }
      return gap(`Exact request value/caller domain required for ${node.text}; its annotation does not validate bytes`);
    }
    if(ts.isConditionalExpression(node)){
      if(node.condition.kind===ts.SyntaxKind.TrueKeyword)return evaluate(node.whenTrue,depth+1);
      if(node.condition.kind===ts.SyntaxKind.FalseKeyword)return evaluate(node.whenFalse,depth+1);
      return {kind:'UNION',types:[evaluate(node.whenTrue,depth+1),evaluate(node.whenFalse,depth+1)]};
    }
    if(ts.isArrayLiteralExpression(node))return {kind:'TUPLE',elements:node.elements.map(element=>{
      if(ts.isOmittedExpression(element))return {kind:'NULL'};
      if(ts.isSpreadElement(element))return gap('Request array spread requires a finite sequence summary');
      const arraySlot=(value:GraphNode):GraphNode=>value.kind==='ABSENT'?{kind:'NULL'}:value.kind==='UNION'?{kind:'UNION',types:value.types.map(arraySlot)}:value;
      return arraySlot(evaluate(element,depth+1));
    })};
    if(ts.isObjectLiteralExpression(node)){
      const fields=new Map<string,GraphNode>();
      for(const property of node.properties){
        if(ts.isSpreadAssignment(property)){
          const spread=evaluate(property.expression,depth+1);if(spread.kind==='NULL'||spread.kind==='ABSENT')continue;
          if(spread.kind!=='OBJECT')return gap('Unknown request spread can overwrite supplied values');
          for(const field of spread.properties)fields.set(field.wireName,field.type);continue;
        }
        if(ts.isMethodDeclaration(property)){if(property.name.getText()==='toJSON')return gap('Source-visible toJSON requires a serializer behavior summary');continue;}
        if(ts.isGetAccessorDeclaration(property)||ts.isSetAccessorDeclaration(property))return gap('Request accessor effects require a serializer summary');
        if(ts.isShorthandPropertyAssignment(property)){fields.set(property.name.text,evaluate(property.name,depth+1));continue;}
        if(!ts.isPropertyAssignment(property))return gap('Unsupported request object member');
        let key:string|undefined;
        if(ts.isIdentifier(property.name)||ts.isStringLiteral(property.name)||ts.isNumericLiteral(property.name))key=property.name.text;
        if(ts.isComputedPropertyName(property.name)&&ts.isStringLiteral(property.name.expression))key=property.name.expression.text;
        if(key===undefined||key==='__proto__')return gap('Computed/prototype request key requires construction evidence');
        if(key==='toJSON')return gap('toJSON override requires a qualified serializer summary');
        fields.set(key,evaluate(property.initializer,depth+1));
      }
      const properties=[];
      for(const [wireName,value]of fields){
        const alternatives:GraphNode[]=[];let optional=false;
        const flatten=(node:GraphNode)=>{if(node.kind==='ABSENT')optional=true;else if(node.kind==='UNION')node.types.forEach(flatten);else alternatives.push(node);};flatten(value);
        if(alternatives.length)properties.push({wireName,type:alternatives.length===1?alternatives[0]:{kind:'UNION' as const,types:alternatives},optional,nullable:false,validationConstraints:[]});
      }
      return {kind:'OBJECT',strict:true,properties};
    }
    if(ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='Map'&&!findBinding('Map',node.expression)){
      if(node.arguments?.length)return gap('Map construction iterable requires entry validation and effect qualification');
      return {kind:'OBJECT',strict:true,properties:[]};
    }
    return gap('Request expression '+ts.SyntaxKind[node.kind]+' requires a value/encoder summary');
  };
  let valueExpression=expression,encoder=profile.encoderId??null,kind:TransportBody['kind']='UNRESOLVED';
  if(ts.isCallExpression(expression)&&ts.isPropertyAccessExpression(expression.expression)&&ts.isIdentifier(expression.expression.expression)&&expression.expression.expression.text==='JSON'&&!findBinding('JSON',expression.expression.expression)&&expression.expression.name.text==='stringify'){
    encoder='ECMASCRIPT_JSON_V1';if(expression.arguments.length!==1)missing.add('JSON replacer/spacing arguments require a captured serializer summary');valueExpression=expression.arguments[0]??expression;
  }
  if(encoder==='ECMASCRIPT_JSON_V1')kind='JSON';
  else if(ts.isStringLiteralLike(expression))kind='TEXT';
  else if(ts.isNewExpression(expression)&&ts.isIdentifier(expression.expression)&&!findBinding(expression.expression.text,expression.expression)){
    if(['Blob','File','ArrayBuffer','Uint8Array'].includes(expression.expression.text))kind='BINARY';
    if(expression.expression.text==='FormData')kind='MULTIPART';if(expression.expression.text==='URLSearchParams')kind='FORM';
  }
  const value=evaluate(valueExpression,0);if(kind==='JSON'&&value.kind==='ABSENT')kind='ABSENT';
  if(!encoder&&kind!=='TEXT')missing.add(`Exact ${kind.toLowerCase()} transport encoder/interceptor summary required`);
  const hash=createHash('sha256').update(JSON.stringify([...sources])).digest('hex'),valueGraph:TypeGraph={version:'SAJIMORA_TYPE_GRAPH_V2',roots:{body:'body'},definitions:{body:value},manifest:{snapshot:profile.snapshot??'captured',serializerProfile:'DECLARED_JSON_V1',compilerProfile:'ACTUAL_VALUE_JSON_V1',optionsHash:hash,sourceHashes:Object.fromEntries(sources),missingEvidence:[...missing].sort()}};
  return {version:'SAJIMORA_TRANSPORT_BODY_V1',kind,encoderId:encoder,status:invalid?'SOURCE_CONTRACT_INVALID':missing.size?'EVIDENCE_REQUIRED':'ENCODED_DOMAIN',...(kind==='JSON'?{valueGraph}:{}),missingEvidence:[...missing].sort(),assumptions:encoder?['Standard ECMAScript JSON encoder and intrinsic prototypes as declared; no runtime monkey patching']:[],sourceEvidence:[...sources].map(([file,sha256])=>({file,sha256}))};
}
