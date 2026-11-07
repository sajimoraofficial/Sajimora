import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import * as ts from 'typescript';
import type {CapturedProjectContext} from './CapturedProjectContext';

export interface DependencyEvidenceRequest {package:string;importer:string;importers:string[];lockFile?:string;version?:string;integrity?:string;reason:string;}
interface LockedPackage {version:string;integrity:string;lockFile:string;installation:string;}
/** Offline, demand-only npm content-addressed archive reader. It never installs
 * packages or runs lifecycle scripts. Live node_modules is never a fallback. */
export class DependencyDeclarationContext extends Map<string,string> {
  readonly requests:DependencyEvidenceRequest[]=[];
  readonly packages:{name:string;version:string;integrity:string;lockHash:string;origin:'VERIFIED_ARCHIVE'|'CAPTURED_DECLARATIONS'|'CAPTURED_WORKSPACE';declarations:{file:string;sha256:string}[]}[]=[];
  private attempted=new Set<string>();
  private failures=new Map<string,DependencyEvidenceRequest>();
  private lockCache=new Map<string,LockedPackage|undefined>();
  private declarationBytes=0;
  private readonly workspaceAttempts=new Set<string>();
  private readonly projectContexts=new Map<string,CapturedProjectContext>();
  private readonly libraryContexts=new Map<string,{compilerVersion:string;defaultLibrary:string|null;declarations:{file:string;sha256:string}[];missingEvidence:string[]}>();
  constructor(files:ReadonlyMap<string,string>,private readonly cacheRoot?:string){super(files);}
  workspaceImport(module:string,origin:string):{installation:string;target:string}|undefined {
    if(module.startsWith('.')||module.startsWith('/')||module.startsWith('node:'))return undefined;
    const name=module.startsWith('@')?module.split('/').slice(0,2).join('/'):module.split('/')[0];
    let directory=path.posix.dirname(origin.replace(/\\/g,'/'));
    for(;;){
      const lockFile=path.posix.join(directory,'package-lock.json'),text=this.get(lockFile);
      if(text){
        try{
          const lock=JSON.parse(text);let ancestor=path.posix.dirname(origin.replace(/\\/g,'/'));
          for(;;){
            const installation=path.posix.join(ancestor,'node_modules',name),entry=lock.packages?.[path.posix.relative(directory,installation)];
            if(entry?.link&&typeof entry.resolved==='string'){
              const target=path.posix.normalize(path.posix.join(directory,entry.resolved));
              if(path.posix.isAbsolute(entry.resolved)||target.startsWith('../')||target==='..')return undefined;
              const pkg=JSON.parse(this.get(path.posix.join(target,'package.json'))??'{}'),locked=lock.packages?.[entry.resolved];
              if(pkg.name!==name||!pkg.version||locked?.version!==pkg.version)return undefined;
              if(!this.workspaceAttempts.has(installation)){
                this.workspaceAttempts.add(installation);
                const declarations=[...this].filter(([file])=>file.startsWith(target+'/')&&(/\.(?:[cm]?ts|tsx)$/.test(file)||file===target+'/package.json')).map(([file,bytes])=>({file,sha256:createHash('sha256').update(bytes).digest('hex')}));
                this.packages.push({name,version:pkg.version,integrity:'captured-workspace',lockHash:createHash('sha256').update(text).digest('hex'),origin:'CAPTURED_WORKSPACE',declarations});
              }
              return {installation,target};
            }
            const parent=path.posix.dirname(ancestor);if(parent===ancestor||ancestor===directory)break;ancestor=parent;
          }
        }catch{/* Invalid links remain unresolved. */}
        return undefined;
      }
      const parent=path.posix.dirname(directory);if(parent===directory||directory==='.')return undefined;directory=parent;
    }
  }
  private lock(name:string,importer:string):LockedPackage|undefined {
    const key=path.posix.dirname(importer.replace(/\\/g,'/'))+'\0'+name;
    if(!this.lockCache.has(key))this.lockCache.set(key,this.readLock(name,importer));
    return this.lockCache.get(key);
  }
  private readLock(name:string,importer:string):LockedPackage|undefined {
    let directory=path.posix.dirname(importer.replace(/\\/g,'/'));
    let requestingManifest:string|undefined;
    for(;;){
      const manifest=path.posix.join(directory,'package.json');
      if(requestingManifest===undefined&&this.has(manifest))requestingManifest=this.get(manifest);
      const npm=path.posix.join(directory,'package-lock.json'),yarn=path.posix.join(directory,'yarn.lock');
      if(this.has(npm)){
        try {
          const lock=JSON.parse(this.get(npm)!);
          let installation=path.posix.dirname(importer.replace(/\\/g,'/'));
          for(;;){
            const key=path.posix.relative(directory,path.posix.join(installation,'node_modules',name));
            const item=lock.packages?.[key];
            if(item?.version&&item.integrity&&!item.link)return {version:item.version,integrity:item.integrity,lockFile:npm,installation:path.posix.join(installation,'node_modules',name)};
            const parent=path.posix.dirname(installation);if(parent===installation||installation===directory||path.posix.relative(directory,parent).startsWith('..'))break;installation=parent;
          }
        }catch{/* An invalid lock is evidence required. */}
        return undefined;
      }
      if(this.has(yarn)){
        // Yarn classic selector entries are exact only when the importing
        // workspace's dependency range selects a single matching entry.
        let range:string|undefined;
        try{const pkg=JSON.parse(requestingManifest??'{}');range=pkg.dependencies?.[name]??pkg.devDependencies?.[name]??pkg.peerDependencies?.[name];}catch{}
        if(!range)return undefined;
        const selector=`${name}@${range}`;
        const lines=this.get(yarn)!.split(/\r?\n/);
        for(let index=0;index<lines.length;index++){
          const heading=lines[index];if(!heading||/^\s|^#/.test(heading)||!heading.endsWith(':'))continue;
          const selectors=heading.slice(0,-1).split(/,\s*/).map(s=>s.replace(/^"|"$/g,''));if(!selectors.includes(selector))continue;
          let version='',integrity='';
          for(let next=index+1;next<lines.length&&/^\s/.test(lines[next]);next++){
            const line=lines[next];const v=line.match(/^\s+version "([^"]+)"/),i=line.match(/^\s+integrity (\S+)/);if(v)version=v[1];if(i)integrity=i[1];
          }
          if(version&&integrity)return {version,integrity,lockFile:yarn,installation:path.posix.join(directory,'node_modules',name)};
        }
        return undefined;
      }
      const parent=path.posix.dirname(directory);if(parent===directory||directory==='.')return undefined;directory=parent;
    }
  }
  loadForImport(module:string,importer:string):void {
    if(module.startsWith('.')||module.startsWith('/'))return;
    if(module.startsWith('node:')){this.loadForImport('@types/node',importer);return;}
    if(this.workspaceImport(module,importer))return;
    const name=module.startsWith('@')?module.split('/').slice(0,2).join('/'):module.split('/')[0];
    const locked=this.lock(name,importer);
    const key=`${locked?.installation??path.posix.dirname(importer)}\0${name}`;
    if(this.attempted.has(key)){const failure=this.failures.get(key);if(failure&&!failure.importers.includes(importer))failure.importers.push(importer);return;}this.attempted.add(key);
    const request=(reason:string)=>{const item={package:name,importer,importers:[importer],...(locked?{lockFile:locked.lockFile,version:locked.version,integrity:locked.integrity}:{}),reason};this.requests.push(item);this.failures.set(key,item);};
    if(!locked){request('Exact historical lock resolution and integrity required');return;}
    if(this.has(path.posix.join(locked.installation,'package.json'))){
      try{
        const pkg=JSON.parse(this.get(path.posix.join(locked.installation,'package.json'))!);
        if(pkg.name!==name||pkg.version!==locked.version){request('Captured package identity contradicts the historical lock');return;}
        const declarations=[...this].filter(([file])=>file.startsWith(locked.installation+'/')&&(file.endsWith('/package.json')||/\.d\.[cm]?ts$/.test(file))).map(([file,text])=>({file,sha256:createHash('sha256').update(text).digest('hex')}));
        this.packages.push({name,version:locked.version,integrity:locked.integrity,lockHash:createHash('sha256').update(this.get(locked.lockFile)!).digest('hex'),origin:'CAPTURED_DECLARATIONS',declarations});
      }catch{request('Captured dependency package manifest is invalid');}
      return;
    }
    if(!this.cacheRoot){request('Content-verified package archive required; configure --dependency-cache with an npm cache');return;}
    const match=locked.integrity.match(/^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/);
    if(!match){request('Supported single archive integrity required');return;}
    const digest=Buffer.from(match[2],'base64').toString('hex');
    const archive=path.resolve(this.cacheRoot,'_cacache','content-v2',match[1],digest.slice(0,2),digest.slice(2,4),digest.slice(4));
    try {
      // Reject symlink/reparse ancestors and bound compressed/decompressed bytes.
      for(let current=archive;current!==path.dirname(current);current=path.dirname(current)){if(fs.lstatSync(current).isSymbolicLink())throw new Error('Archive path has a symlink');if(current===path.resolve(this.cacheRoot))break;}
      if(fs.statSync(archive).size>32*1024*1024)throw new Error('Archive exceeds 32 MiB budget');
      const bytes=fs.readFileSync(archive);
      if(createHash(match[1]).update(bytes).digest('base64')!==match[2])throw new Error('Archive integrity mismatch');
      const tar=gunzipSync(bytes,{maxOutputLength:128*1024*1024});
      const admitted=new Map<string,string>();let count=0,total=0;
      for(let offset=0;offset+512<=tar.length;){
        const header=tar.subarray(offset,offset+512);if(header.every(byte=>byte===0))break;
        const read=(start:number,length:number)=>header.subarray(start,start+length).toString('utf8').replace(/\0.*$/s,'');
        const relative=[read(345,155),read(0,100)].filter(Boolean).join('/');
        const size=parseInt(read(124,12).trim(),8),kind=read(156,1);
        const checksum=parseInt(read(148,8).trim(),8),sum=header.reduce((sum,byte,index)=>sum+(index>=148&&index<156?32:byte),0);
        if(sum!==checksum||!Number.isSafeInteger(size)||size<0||offset+512+size>tar.length)throw new Error('Invalid tar header');
        if(relative.startsWith('/')||relative.includes('\\')||relative.split('/').some(part=>part==='..')||!relative.startsWith('package/'))throw new Error('Unsafe archive path');
        if(!['','0','5'].includes(kind))throw new Error('Archive links or extended headers need a qualified extractor');
        const file=relative.slice('package/'.length);
        if(kind!=='5'&&(/\.json$/.test(file)||/\.d\.[cm]?ts$/.test(file))){
          if(++count>2048||(total+=size)>16*1024*1024)throw new Error('Declaration closure archive budget exceeded');
          const source=tar.subarray(offset+512,offset+512+size),text=source.toString('utf8');
          if(!Buffer.from(text,'utf8').equals(source))throw new Error('Declaration/configuration is not valid UTF-8');
          admitted.set(path.posix.join(locked.installation,file),text);
        }
        offset+=512+Math.ceil(size/512)*512;
      }
      const pkg=JSON.parse(admitted.get(path.posix.join(locked.installation,'package.json'))??'{}');
      if(pkg.name!==name||pkg.version!==locked.version)throw new Error('Locked package identity mismatch');
      if(this.declarationBytes+total>64*1024*1024)throw new Error('Aggregate declaration byte budget exceeds 64 MiB');
      this.declarationBytes+=total;
      for(const [file,text]of admitted)this.set(file,text);
      this.packages.push({name,version:locked.version,integrity:locked.integrity,lockHash:createHash('sha256').update(this.get(locked.lockFile)!).digest('hex'),origin:'VERIFIED_ARCHIVE',declarations:[...admitted].map(([file,text])=>({file,sha256:createHash('sha256').update(text).digest('hex')}))});
    }catch(error){const failure=error as NodeJS.ErrnoException;request(failure.code==='ENOENT'?'Exact integrity-addressed archive is absent from the configured npm cache':`Exact declaration archive unavailable: ${failure.message}`);}
  }
  allowsResolution(module:string,importer:string,resolved:string):boolean {
    const name=module.startsWith('@')?module.split('/').slice(0,2).join('/'):module.split('/')[0];
    const locked=this.lock(name,importer);if(!locked)return true;
    try{const pkg=JSON.parse(this.get(path.posix.join(locked.installation,'package.json'))??'{}');if(pkg.name!==name||pkg.version!==locked.version)return false;}catch{return false;}
    return ('/'+resolved.replace(/\\/g,'/').replace(/^\//,'')).startsWith('/'+locked.installation.replace(/^\//,'')+'/');
  }
  recordProjectContext(context:CapturedProjectContext):void {this.projectContexts.set(context.configFile??'<tool-default>',context);}
  compilerLibraries(origin:string,options:ts.CompilerOptions):{defaultLibrary:string|null;missingEvidence:string[]} {
    const key=path.posix.dirname(origin)+'\0'+JSON.stringify([options.target,options.lib,options.noLib]);
    const cached=this.libraryContexts.get(key);if(cached)return cached;
    let defaultLibrary:string|null=null;const missingEvidence:string[]=[];
    if(!options.noLib){
      const locked=this.lock('typescript',origin);
      if(locked&&locked.version!==ts.version)missingEvidence.push(`Historical compiler ${locked.version} is required; active semantic adapter is pinned to ${ts.version}`);
      else{
        this.loadForImport('typescript',origin);
        let directory=path.posix.dirname(origin);
        for(;;){
          const installation=path.posix.join(directory,'node_modules/typescript'),manifest=this.get(path.posix.join(installation,'package.json'));
          if(manifest){
            try{
              const pkg=JSON.parse(manifest),file=path.posix.join(installation,'lib',ts.getDefaultLibFileName(options));
              if(pkg.name==='typescript'&&pkg.version===ts.version&&this.has(file)&&(!locked||locked.installation===installation))defaultLibrary=file;
              else missingEvidence.push(`Exact TypeScript ${ts.version} standard libraries required for ${origin}`);
            }catch{missingEvidence.push('Captured compiler package manifest is invalid');}
            break;
          }
          const parent=path.posix.dirname(directory);if(parent===directory||directory==='.')break;directory=parent;
        }
        if(!defaultLibrary&&!missingEvidence.length)missingEvidence.push(`Exact TypeScript ${ts.version} standard libraries required for ${origin}`);
      }
    }
    const declarations=defaultLibrary?[...this].filter(([file])=>file.startsWith(path.posix.dirname(defaultLibrary!)+'/')&&/lib\..*\.d\.ts$/.test(file)).map(([file,text])=>({file,sha256:createHash('sha256').update(text).digest('hex')})):[];
    const context={compilerVersion:ts.version,defaultLibrary,declarations,missingEvidence};this.libraryContexts.set(key,context);return context;
  }
  manifest(){return {version:'SAJIMORA_DEPENDENCY_CONTEXT_V1',compilerVersion:ts.version,projects:[...this.projectContexts.values()].sort((a,b)=>(a.configFile??'').localeCompare(b.configFile??'')),standardLibraries:[...this.libraryContexts.values()],packages:this.packages,requests:this.requests};}
}
