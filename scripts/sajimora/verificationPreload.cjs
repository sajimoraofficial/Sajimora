'use strict';
// Local opt-in instrumentation for synchronous CommonJS method operations.
const fs=require('node:fs'),Module=require('node:module'),path=require('node:path');
const v=require('./verificationEvidence.cjs');
const {AsyncLocalStorage}=require('node:async_hooks'),testScope=new AsyncLocalStorage();
const config=JSON.parse(fs.readFileSync(process.env.SAJIMORA_TEST_CAPTURE,'utf8'));
const targets=new Map(config.sites.map(s=>[fs.realpathSync(s.absolute),s]));
const rows=[],diagnostics=[];
const globalKey='__sajimoraOperation_'+v.hash(config).slice(0,16);
global[globalKey]=(id,receiver,method,args)=>{
 let inputHash;try{inputHash=v.hash(receiver);}catch{diagnostics.push({id,reason:'NON_JSON_RECEIVER'});return Reflect.apply(method,receiver,args);}
 const scope=testScope.getStore(),row={id,inputHash,testId:scope?.name||'outside-node-test',operationOutcome:'RETURNED',assertionOutcome:'NOT_RUN',assertionCount:0};
 const entry={row,receiver,scope};rows.push(entry);
 try{const output=Reflect.apply(method,receiver,args);entry.output=output;if(require('node:util').types.isPromise(output)){entry.unsupported=true;diagnostics.push({id,reason:'ASYNC_OPERATION_NOT_SUPPORTED'});}try{entry.receiverAfter=v.hash(receiver);entry.outputAfter=v.hash(output);}catch{diagnostics.push({id,reason:'NON_JSON_OPERATION_RESULT'});}return output;}
 catch(error){row.operationOutcome='THREW';row.errorName=['Error','TypeError','RangeError','ReferenceError','SyntaxError','URIError','EvalError','AggregateError'].includes(error?.name)?error.name:'ThrownValue';throw error;}
};
const originalCompile=Module.prototype._compile;
Module.prototype._compile=function(source,filename){
 const site=targets.get(path.resolve(filename));if(!site)return originalCompile.call(this,source,filename);
 if(v.hashBytes(Buffer.from(source))!==site.sourceSha256)throw Error('Instrumented source identity changed');
 const ts=require('typescript'),tree=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);let match;
 function walk(n){if(ts.isCallExpression(n)&&n.getText(tree)===site.usage&&tree.getLineAndCharacterOfPosition(n.getStart(tree)).line+1===site.line)match=n;ts.forEachChild(n,walk);}walk(tree);
 if(!match||!ts.isPropertyAccessExpression(match.expression)||match.questionDotToken||match.expression.questionDotToken||match.arguments.some(a=>ts.isSpreadElement(a)))throw Error('Unsupported consumer operation for automatic Node capture');
 const receiver=match.expression.expression.getText(tree),method=match.expression.name.getText(tree),args=match.arguments.map(a=>a.getText(tree)).join(',');
 // Receiver and method lookup precede arguments, preserving normal call order.
 const replacement=`((__r)=>{const __m=__r.${method};return global[${JSON.stringify(globalKey)}](${JSON.stringify(site.id)},__r,__m,[${args}]);})(${receiver})`;
 return originalCompile.call(this,source.slice(0,match.getStart(tree))+replacement+source.slice(match.end),filename);
};
const originalLoad=Module._load,proxies=new Map();
let testProxy;
Module._load=function(request,parent,isMain){
 const loaded=originalLoad.call(this,request,parent,isMain);
 if(request==='node:test'){
  if(testProxy)return testProxy;
  const wrap=fn=>new Proxy(fn,{apply(target,self,args){const last=args.length-1;if(typeof args[last]==='function'){const callback=args[last];args=[...args];args[last]=function(context,...rest){return testScope.run({name:context.name},()=>Reflect.apply(callback,this,[context,...rest]));};}return Reflect.apply(target,self,args);}});
  const callable=wrap(loaded);testProxy=new Proxy(callable,{get(target,key){const value=Reflect.get(target,key);return ['test','it'].includes(key)&&typeof value==='function'?wrap(value):value;}});return testProxy;
 }
 if(!['assert','node:assert','assert/strict','node:assert/strict'].includes(request))return loaded;
 if(proxies.has(loaded))return proxies.get(loaded);
 const methods=new Map(),proxy=new Proxy(loaded,{get(target,key){if(key==='strict')return Module._load('node:assert/strict',parent,false);const value=Reflect.get(target,key);if(!['deepEqual','deepStrictEqual','strictEqual'].includes(key)||typeof value!=='function')return value;if(methods.has(key))return methods.get(key);
  const wrapped=function(actual,expected,...rest){
   // Direct object identity only; equal primitive values do not establish provenance.
   let actualHash;try{actualHash=v.hash(actual);}catch{return Reflect.apply(value,target,[actual,expected,...rest]);}
   const relevant=rows.filter(e=>testScope.getStore()&&e.scope===testScope.getStore()&&!e.unsupported&&e.row.operationOutcome==='RETURNED'&&e.row.assertionCount<100&&actual!==null&&typeof actual==='object'&&((actual===e.output&&actualHash===e.outputAfter)||(actual===e.receiver&&actualHash===e.receiverAfter)));
   let oracleHash;try{oracleHash=v.hash({method:key,expected});}catch{return Reflect.apply(value,target,[actual,expected,...rest]);}
   try{const result=Reflect.apply(value,target,[actual,expected,...rest]);for(const e of relevant){if(e.row.assertionOutcome!=='FAILED')e.row.assertionOutcome='PASSED';e.row.assertionCount++;e.row.oracleHash=oracleHash;}return result;}
   catch(error){for(const e of relevant){e.row.assertionOutcome='FAILED';e.row.assertionCount++;e.row.oracleHash=oracleHash;}throw error;}
  };methods.set(key,wrapped);return wrapped;}});proxies.set(loaded,proxy);return proxy;
};
process.on('exit',()=>{fs.writeFileSync(path.join(config.output,`capture-${process.pid}.json`),JSON.stringify({rows:rows.map(e=>e.row),diagnostics,rss:process.resourceUsage().maxRSS*1024,heap:process.memoryUsage().heapUsed}));});
