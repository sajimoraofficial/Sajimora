import * as ts from 'typescript';
const pools=new WeakMap<ReadonlyMap<string,string>,Map<string,ts.SourceFile>>();
/** One parser mode and one SourceFile per admitted byte sequence. Declaration
 * acquisition only appends immutable support files to the snapshot map. */
export function snapshotSourceFile(files:ReadonlyMap<string,string>,file:string):ts.SourceFile|undefined{
  const text=files.get(file);if(text===undefined)return undefined;
  let pool=pools.get(files);if(!pool){pool=new Map();pools.set(files,pool);}
  let source=pool.get(file);
  if(!source||source.text!==text){source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);pool.set(file,source);}
  return source;
}
