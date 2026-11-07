import {describe,it,expect} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {DependencyDeclarationContext} from '../../../src/sajimora/cross-language/DependencyDeclarationContext';
import {SnapshotModuleResolver} from '../../../src/sajimora/cross-language/SnapshotModuleResolver';
import {TypeScriptContractParser} from '../../../src/sajimora/cross-language/TypeScriptContractParser';
import {CapturedProjectContexts} from '../../../src/sajimora/cross-language/CapturedProjectContext';

function archive(files:Record<string,string>,kind='0'):Buffer {
  const chunks:Buffer[]=[];
  for(const [name,text]of Object.entries(files)){
    const bytes=Buffer.from(text),header=Buffer.alloc(512);
    header.write('package/'+name,0);header.write('0000644\0',100);header.write('0000000\0',108);header.write('0000000\0',116);header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);header.fill(32,148,156);header.write(kind,156);header.write('ustar\0',257);
    const checksum=header.reduce((sum,byte)=>sum+byte,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);
    chunks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));
}
function put(cache:string,bytes:Buffer){const digest=createHash('sha512').update(bytes).digest(),hex=digest.toString('hex'),file=path.join(cache,'_cacache','content-v2','sha512',hex.slice(0,2),hex.slice(2,4),hex.slice(4));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return {integrity:'sha512-'+digest.toString('base64'),file};}
function fixture(cache:string,version='1.0.0',field='id'){
  const entry=put(cache,archive({'package.json':JSON.stringify({name:'library',version,types:'index.d.ts'}),'index.d.ts':`export interface Value {${field}:string;}`}));
  const files=new Map([['project/package.json','{"dependencies":{"library":"1.0.0"}}'],['project/package-lock.json',JSON.stringify({lockfileVersion:3,packages:{'node_modules/library':{version,integrity:entry.integrity}}})],['project/client.ts',"import {Value} from 'library';"]]);
  return {entry,files};
}
describe('on-demand exact declaration archives',()=>{
  it('loads an integrity-verified historical package only when an import needs it',()=>{
    const cache=fs.mkdtempSync(path.join(os.tmpdir(),'sajimora-dependency-'));
    try{
      const {files}=fixture(cache),context=new DependencyDeclarationContext(files,cache);
      const parser=new TypeScriptContractParser(context);
      expect(context.packages).toEqual([]);
      expect(parser.parseTypeByName('Value','project/client.ts').wireType).toMatchObject({kind:'OBJECT',properties:[{wireName:'id'}]});
      expect(context.packages).toHaveLength(1);
      expect(context.packages[0].declarations.every(d=>d.sha256.length===64)).toBe(true);
      expect(context.requests).toEqual([]);
      expect([...context.keys()].filter(k=>k.includes('node_modules')).every(k=>k.endsWith('.d.ts')||k.endsWith('package.json'))).toBe(true);
    }finally{fs.rmSync(cache,{recursive:true,force:true});}
  });
  it('keeps different locked versions isolated in nested projects',()=>{
    const cache=fs.mkdtempSync(path.join(os.tmpdir(),'sajimora-dependency-'));
    try{
      const first=fixture(cache),second=fixture(cache,'2.0.0','name'),files=new Map(first.files);
      for(const [file,text]of second.files)files.set(file.replace('project/','project/nested/'),text);
      const context=new DependencyDeclarationContext(files,cache),parser=new TypeScriptContractParser(context);
      expect(parser.parseTypeByName('Value','project/client.ts').wireType).toMatchObject({properties:[{wireName:'id'}]});
      expect(parser.parseTypeByName('Value','project/nested/client.ts').wireType).toMatchObject({properties:[{wireName:'name'}]});
      expect(context.packages.map(p=>p.version).sort()).toEqual(['1.0.0','2.0.0']);
    }finally{fs.rmSync(cache,{recursive:true,force:true});}
  });
  it('rejects corrupted archives and leaves no partial declarations',()=>{
    const cache=fs.mkdtempSync(path.join(os.tmpdir(),'sajimora-dependency-'));
    try{
      const {entry,files}=fixture(cache);fs.writeFileSync(entry.file,'corrupt');
      const context=new DependencyDeclarationContext(files,cache);
      expect(new SnapshotModuleResolver(context).resolve('library','project/client.ts')).toBeUndefined();
      expect(context.packages).toEqual([]);
      expect(context.requests[0].reason).toContain('integrity mismatch');
      expect(context.has('project/node_modules/library/index.d.ts')).toBe(false);
    }finally{fs.rmSync(cache,{recursive:true,force:true});}
  });
  it('does not consult a live installation or treat a range as exact evidence',()=>{
    const context=new DependencyDeclarationContext(new Map([['client.ts',"import {Value} from 'library';"],['package.json','{"dependencies":{"library":"^1.0.0"}}']]));
    const resolver=new SnapshotModuleResolver(context);
    expect(resolver.resolve('library','client.ts')).toBeUndefined();
    expect(context.requests[0].reason).toContain('Exact historical lock');
    expect(context.packages).toEqual([]);
  });
  it('does not fall back to an ancestor version when the nested archive is missing',()=>{
    const cache=fs.mkdtempSync(path.join(os.tmpdir(),'sajimora-dependency-'));
    try{
      const first=fixture(cache),second=fixture(cache,'2.0.0','name'),files=new Map(first.files);
      fs.unlinkSync(second.entry.file);
      for(const [file,text]of second.files)files.set(file.replace('project/','project/nested/'),text);
      const context=new DependencyDeclarationContext(files,cache),parser=new TypeScriptContractParser(context);
      expect(parser.parseTypeByName('Value','project/client.ts').wireType.kind).toBe('OBJECT');
      expect(parser.parseTypeByName('Value','project/nested/client.ts').wireType.kind).toBe('UNKNOWN');
    }finally{fs.rmSync(cache,{recursive:true,force:true});}
  });
  it('does not request packages for captured path aliases',()=>{
    const context=new DependencyDeclarationContext(new Map([['tsconfig.json','{"compilerOptions":{"baseUrl":".","paths":{"@models/*":["models/*"]}}}'],['models/value.ts','export interface Value{id:string;}'],['client.ts',"import {Value} from '@models/value';"]]));
    expect(new SnapshotModuleResolver(context).resolve('@models/value','client.ts')).toBe('models/value.ts');
    expect(context.requests).toEqual([]);
  });
  it('selects a nested installation from the same npm lock before the ancestor version',()=>{
    const cache=fs.mkdtempSync(path.join(os.tmpdir(),'sajimora-dependency-'));
    try{
      const first=fixture(cache),second=fixture(cache,'2.0.0','name'),files=new Map(first.files);
      files.set('project/package-lock.json',JSON.stringify({lockfileVersion:3,packages:{'node_modules/library':{version:'1.0.0',integrity:first.entry.integrity},'node_modules/owner/node_modules/library':{version:'2.0.0',integrity:second.entry.integrity}}}));
      files.set('project/node_modules/owner/index.d.ts',"import {Value} from 'library';");
      const context=new DependencyDeclarationContext(files,cache),resolver=new SnapshotModuleResolver(context);
      expect(resolver.resolve('library','project/client.ts')).toBe('project/node_modules/library/index.d.ts');
      expect(resolver.resolve('library','project/node_modules/owner/index.d.ts')).toBe('project/node_modules/owner/node_modules/library/index.d.ts');
      expect(context.packages.map(p=>p.version)).toEqual(['1.0.0','2.0.0']);
    }finally{fs.rmSync(cache,{recursive:true,force:true});}
  });
  it('loads a locked external tsconfig package as data without executing package code',()=>{
    const cache=fs.mkdtempSync(path.join(os.tmpdir(),'sajimora-dependency-'));
    try{
      const entry=put(cache,archive({'package.json':'{"name":"@configs/base","version":"1.0.0"}','tsconfig.json':'{"compilerOptions":{"strict":true,"exactOptionalPropertyTypes":true}}','postinstall.js':'throw new Error("must never execute");'}));
      const context=new DependencyDeclarationContext(new Map([['package-lock.json',JSON.stringify({lockfileVersion:3,packages:{'node_modules/@configs/base':{version:'1.0.0',integrity:entry.integrity}}})],['tsconfig.json','{"extends":"@configs/base/tsconfig.json"}']]),cache);
      const project=new CapturedProjectContexts(context).forFile('client.ts');
      expect(project.options.strict).toBe(true);
      expect(project.missingEvidence).toEqual([]);
      expect(context.has('node_modules/@configs/base/postinstall.js')).toBe(false);
      expect(project.configs.map(c=>c.file)).toContain('node_modules/@configs/base/tsconfig.json');
    }finally{fs.rmSync(cache,{recursive:true,force:true});}
  });
});
