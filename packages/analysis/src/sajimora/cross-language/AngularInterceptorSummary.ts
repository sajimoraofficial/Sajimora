import * as ts from 'typescript';
import {findBinding, importedFrom} from './ClientAstBindings';
import {UrlConstantResolver} from './UrlConstantResolver';
import {sourceHash} from './CallIdentity';
import {interceptorSuccessFlow} from './InterceptorSuccessFlow';

export interface InterceptorEvidence {
  readonly responseProjections:readonly ResponseProjection[];
  readonly responseQualified:boolean;
  readonly requestQualified:boolean;
  readonly missingEvidence:readonly string[];
  readonly registrations:readonly {file:string;line:number;implementation:string}[];
  readonly sourceEvidence?:readonly {file:string;sha256:string}[];
  readonly assumptions?:readonly string[];
}
export interface ResponseProjection {readonly fields:readonly {output:string;input:readonly string[]}[];readonly sourceFile:string;readonly sourceLine:number;readonly sourceSha256:string;}
/** Inspect only registration-bearing files and their referenced implementations.
 * A captured registration is not proof of provider reachability or ordering. */
export class AngularInterceptorSummary {
  private cached?:InterceptorEvidence;
  constructor(private readonly files:ReadonlyMap<string,string>,private readonly resolver:UrlConstantResolver){}
  analyzeForRequest(request:{url:string;bodyAbsent:boolean}):InterceptorEvidence {
    const inventory=this.analyze();if(inventory.responseQualified||!inventory.registrations.length)return inventory;
    if(inventory.missingEvidence.some(reason=>/Dynamic interceptor provider|Functional interceptor registration|Multiple response-transforming|multiple provider scopes/.test(reason)))return inventory;
    const sourceEvidence:{file:string;sha256:string}[]=[],missing:string[]=[];
    for(const registration of inventory.registrations){
      const node=this.resolver.resolveImportedDeclaration(registration.implementation,registration.file)?.node;
      if(!node||!ts.isClassDeclaration(node))return inventory;
      const proof=interceptorSuccessFlow(node,this.resolver,this.files,request);sourceEvidence.push(...proof.sourceEvidence);if(!proof.qualified)missing.push(...proof.missingEvidence);
    }
    if(missing.length)return {...inventory,missingEvidence:[...new Set([...inventory.missingEvidence,...missing])]};
    return {...inventory,responseQualified:true,requestQualified:false,responseProjections:[],sourceEvidence:[...new Map(sourceEvidence.map(source=>[source.file,source])).values()],missingEvidence:['Request header/query acceptance, auth, retry, error and timing behavior remain outside the successful-response body proof'],assumptions:['Successful response events preserve the forwarded endpoint body under Angular HTTP 20.3.28 and RxJS 7.8.2','Any ordering/subset of the captured body-preserving interceptor registrations preserves this body scope']};
  }
  analyze():InterceptorEvidence {
    if(this.cached)return this.cached;
    const missing=new Set<string>(),registrations:{file:string;line:number;implementation:string}[]=[];
    const responseProjections:ResponseProjection[]=[];
    let responseQualified=true,requestQualified=true;
    const inspectImplementation=(expression:ts.Expression,file:string)=>{
      const name=expression.getText();registrations.push({file,line:expression.getSourceFile().getLineAndCharacterOfPosition(expression.getStart()).line+1,implementation:name});
      let declaration:ts.Node|undefined=ts.isIdentifier(expression)?findBinding(expression.text,expression):undefined;
      if(declaration&&ts.isImportSpecifier(declaration))declaration=this.resolver.resolveImportedDeclaration(expression.getText(),file)?.node;
      if(declaration&&ts.isClassDeclaration(declaration)){
        if(declaration.heritageClauses?.some(clause=>clause.token===ts.SyntaxKind.ExtendsKeyword)||declaration.members.some(m=>ts.isConstructorDeclaration(m)||ts.isPropertyDeclaration(m)&&!!m.initializer)){
          responseQualified=false;requestQualified=false;missing.add(`Interceptor ${name}: inheritance, constructor or field initialization effects require qualification`);return;
        }
        const method=declaration.members.find(m=>ts.isMethodDeclaration(m)&&m.name.getText()==='intercept');
        if(method&&ts.isMethodDeclaration(method)&&method.body&&method.parameters.length===2&&method.body.statements.length===1){
          const statement=method.body.statements[0];
          const result=ts.isReturnStatement(statement)?statement.expression:undefined;
          if(result&&ts.isCallExpression(result)&&ts.isPropertyAccessExpression(result.expression)&&result.expression.name.text==='handle'&&result.expression.expression.getText()===method.parameters[1].name.getText()&&result.arguments.length===1&&result.arguments[0].getText()===method.parameters[0].name.getText())return;
          if(result&&ts.isCallExpression(result)&&ts.isPropertyAccessExpression(result.expression)&&result.expression.name.text==='pipe'&&result.arguments.length===1){
            const input=result.expression.expression,operator=result.arguments[0];
            if(ts.isCallExpression(input)&&ts.isPropertyAccessExpression(input.expression)&&input.expression.name.text==='handle'&&input.expression.expression.getText()===method.parameters[1].name.getText()&&input.arguments.length===1&&input.arguments[0].getText()===method.parameters[0].name.getText()&&ts.isCallExpression(operator)&&ts.isIdentifier(operator.expression)){
              const binding=findBinding(operator.expression.text,operator),callback=operator.arguments[0];
              const source=binding&&ts.isImportSpecifier(binding)&&(binding.propertyName?.text??binding.name.text)==='map'&&(importedFrom(binding,'rxjs')||importedFrom(binding,'rxjs/operators'));
              const rxModule=binding&&importedFrom(binding,'rxjs/operators')?'rxjs/operators':'rxjs';
              const resolved=source?this.resolver.resolveModule(rxModule,operator.getSourceFile().fileName):undefined;
              const index=resolved?.lastIndexOf('node_modules/rxjs/')??-1;
              const packageText=resolved&&index>=0?this.files.get(resolved.slice(0,index)+'node_modules/rxjs/package.json'):undefined;
              const pinned=(()=>{try{return JSON.parse(packageText??'{}').version==='7.8.2';}catch{return false;}})();
              if(source&&pinned&&callback&&ts.isArrowFunction(callback)&&callback.parameters.length===1&&ts.isIdentifier(callback.parameters[0].name)&&!ts.isBlock(callback.body)){
                let body:ts.Expression=callback.body;
                if(!ts.isConditionalExpression(body))return void (responseQualified=false,requestQualified=false,missing.add(`Interceptor ${name}: HttpResponse event guard required before body projection`));
                const guard=body.condition;
                if(!ts.isBinaryExpression(guard)||guard.operatorToken.kind!==ts.SyntaxKind.InstanceOfKeyword||!ts.isIdentifier(guard.left)||findBinding(guard.left.text,guard.left)!==callback.parameters[0]||!ts.isIdentifier(guard.right)||!ts.isIdentifier(body.whenFalse)||findBinding(body.whenFalse.text,body.whenFalse)!==callback.parameters[0])return void (responseQualified=false,requestQualified=false,missing.add(`Interceptor ${name}: response event alternatives require evidence`));
                const guardBinding=findBinding(guard.right.text,guard.right);
                if(!guardBinding||!ts.isImportSpecifier(guardBinding)||!importedFrom(guardBinding,'@angular/common/http')||(guardBinding.propertyName?.text??guardBinding.name.text)!=='HttpResponse')return void (responseQualified=false,requestQualified=false,missing.add(`Interceptor ${name}: exact Angular HttpResponse guard required`));
                body=body.whenTrue;
                if(ts.isCallExpression(body)&&ts.isPropertyAccessExpression(body.expression)&&body.expression.name.text==='clone'&&ts.isIdentifier(body.expression.expression)&&findBinding(body.expression.expression.text,body.expression.expression)===callback.parameters[0]&&body.arguments.length===1&&ts.isObjectLiteralExpression(body.arguments[0])){
                  const assignments=body.arguments[0].properties;
                  if(assignments.length===1&&ts.isPropertyAssignment(assignments[0])&&assignments[0].name.getText()==='body'&&ts.isObjectLiteralExpression(assignments[0].initializer)){
                    const fields:{output:string;input:string[]}[]=[];let supported=true;
                    for(const property of assignments[0].initializer.properties){
                      if(!ts.isPropertyAssignment(property)||!(ts.isIdentifier(property.name)||ts.isStringLiteral(property.name))){supported=false;break;}
                      let value:ts.Expression=property.initializer;const parts:string[]=[];
                      while(ts.isPropertyAccessExpression(value)){parts.unshift(value.name.text);value=value.expression;}
                      if(!ts.isIdentifier(value)||findBinding(value.text,value)!==callback.parameters[0]||parts.shift()!=='body'||!parts.length){supported=false;break;}
                      fields.push({output:property.name.text,input:parts});
                    }
                    if(supported){responseProjections.push({fields,sourceFile:declaration.getSourceFile().fileName,sourceLine:declaration.getSourceFile().getLineAndCharacterOfPosition(method.getStart()).line+1,sourceSha256:sourceHash(declaration.getSourceFile())});return;}
                  }
                }
              }
            }
          }
        }
      }
      responseQualified=false;requestQualified=false;
      missing.add(`Interceptor ${name} at ${file} requires request/response effect summary, provider scope and order`);
    };
    for(const [file,text]of this.files){
      if(!/\.[jt]sx?$/.test(file)||/\.d\.ts$/.test(file)||!/(?:HTTP_INTERCEPTORS|withInterceptors)/.test(text))continue;
      const sf=this.resolver.getSourceFile(file);if(!sf)continue;
      const visit=(node:ts.Node)=>{
        if(ts.isObjectLiteralExpression(node)){
          const assignments=node.properties.filter(ts.isPropertyAssignment);
          const provide=assignments.find(p=>p.name.getText()==='provide')?.initializer;
          const token=provide&&ts.isIdentifier(provide)?findBinding(provide.text,provide):undefined;
          if(token&&ts.isImportSpecifier(token)&&(token.propertyName?.text??token.name.text)==='HTTP_INTERCEPTORS'&&importedFrom(token,'@angular/common/http')){
            const implementation=assignments.find(p=>p.name.getText()==='useClass')?.initializer;
            if(implementation)inspectImplementation(implementation,file);
            else {responseQualified=false;requestQualified=false;missing.add(`Dynamic interceptor provider at ${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line+1} requires exact implementation`);}
          }
        }
        if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)){
          const binding=findBinding(node.expression.text,node);
          if(binding&&ts.isImportSpecifier(binding)&&importedFrom(binding,'@angular/common/http')&&(binding.propertyName?.text??binding.name.text)==='withInterceptors'){
            responseQualified=false;requestQualified=false;
            missing.add(`Functional interceptor registration at ${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line+1} requires ordered function summaries`);
          }
        }
        ts.forEachChild(node,visit);
      };visit(sf);
    }
    if(responseProjections.length>1){responseQualified=false;missing.add('Multiple response-transforming interceptors require captured provider activation and response order');}
    if(new Set(registrations.map(r=>r.file)).size>1&&responseProjections.length){responseQualified=false;missing.add('Interceptor registrations span multiple provider scopes; exact registration order required');}
    this.cached={responseQualified,requestQualified,responseProjections,missingEvidence:[...missing].sort(),registrations};return this.cached;
  }
}
