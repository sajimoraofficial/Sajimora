import {describe,it,expect} from 'vitest';
import * as ts from 'typescript';
import {interceptorSuccessFlow} from '../../../src/sajimora/cross-language/InterceptorSuccessFlow';
import {UrlConstantResolver} from '../../../src/sajimora/cross-language/UrlConstantResolver';
function proof(body:string,bodyAbsent=true,rxjs='7.8.2',producer='',url='/api/items'){
  const source=`import {HttpRequest,HttpHandler} from '@angular/common/http';import {of,throwError,ReplaySubject} from 'rxjs';import {catchError,finalize,switchMap,map} from 'rxjs/operators';${producer} class Forward {constructor(private auth:Session){} intercept(req:HttpRequest<any>,next:HttpHandler){${body}}}`;
  const files=new Map([['forward.ts',source],['node_modules/@angular/common/package.json','{"name":"@angular/common","version":"20.3.28"}'],['node_modules/@angular/common/http/index.d.ts','export declare class HttpRequest<T>{}'],['node_modules/rxjs/package.json',JSON.stringify({name:'rxjs',version:rxjs})],['node_modules/rxjs/index.d.ts','export declare function of(...v:any[]):any;export declare function throwError(callback:any):any;'],['node_modules/rxjs/operators/index.d.ts','export declare function catchError(callback:any):any;']]);
  const sf=ts.createSourceFile('forward.ts',source,ts.ScriptTarget.Latest,true),declaration=sf.statements.find((node):node is ts.ClassDeclaration=>ts.isClassDeclaration(node)&&node.name?.text==='Forward')!;
  return interceptorSuccessFlow(declaration,new UrlConstantResolver(files),files,{url,bodyAbsent});
}
describe('scoped successful interceptor body preservation',()=>{
  it('explores all URL-dependent branches for symbolic URLs rather than inventing a literal',()=>{
    for(const url of ['<dynamic>','/api/items?key=${key}']){
      expect(proof('if(req.url.startsWith("/api")){return next.handle(req.clone({setHeaders:{X:"yes"}}));}return next.handle(req);',true,'7.8.2','',url).qualified).toBe(true);
      expect(proof('if(req.url.startsWith("/api")){return next.handle(req.clone({url:"/other"}));}return next.handle(req);',true,'7.8.2','',url).qualified).toBe(false);
    }
  });
  it('preserves header-only clones, error rethrow and finalize without qualifying errors/timing',()=>{
    expect(proof('return next.handle(req.clone({setHeaders:{Authorization:"token"}})).pipe(catchError(error=>throwError(()=>error)),finalize(()=>notify()));').qualified).toBe(true);
  });
  it('discards upstream auth values only through an exactly pinned flattening operator',()=>{
    const source='return of(null).pipe(switchMap(()=>next.handle(req)));';expect(proof(source).qualified).toBe(true);expect(proof(source,true,'7.7.0').qualified).toBe(false);
    expect(proof('return auth.refresh().pipe(switchMap(()=>next.handle(req)));').qualified).toBe(false);
    expect(proof('return this.auth.refresh().pipe(switchMap(()=>next.handle(req)));',true,'7.8.2','class Session{private tokens:any=null;refresh(){if(!this.tokens){this.tokens=new ReplaySubject();}return this.tokens;}}').qualified).toBe(true);
  });
  it('rejects event transforms, synthetic replacements, target changes and handler escapes',()=>{
    for(const source of ['return next.handle(req).pipe(map(event=>({body:event.body.id})));','return next.handle(req).pipe(catchError(()=>of(null)));','return next.handle(req.clone({url:"/other"}));','req["url"]="/other";return next.handle(req);','escape(next);return next.handle(req);','escape({handler:next});return next.handle(req);','return next.handle(req.clone({setHeaders:{token:mutate(req)}}));','while(flag){req.url="/other";}return next.handle(req);'])expect(proof(source).qualified,source).toBe(false);
  });
  it('uses known body absence to exclude body-dependent error substitution',()=>{
    const source='return next.handle(req).pipe(catchError(error=>{if(!req.body){return throwError(()=>error);}return of(null);}));';expect(proof(source).qualified).toBe(true);expect(proof(source,false).qualified).toBe(false);
  });
  it('models an absent Angular request body as null rather than undefined',()=>{
    expect(proof('return next.handle(req).pipe(catchError(error=>{if(req.body===undefined){return throwError(()=>error);}return of(null);}));').qualified).toBe(false);
  });
});
