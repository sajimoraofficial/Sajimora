import * as ts from 'typescript';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJson} from './ContractArtifactEnvelope';

export interface CapturedProjectContext {
  readonly configFile:string|null;
  readonly compilerVersion:string;
  readonly resolverMode:string;
  readonly options:ts.CompilerOptions;
  readonly optionsHash:string;
  readonly configs:readonly {file:string;sha256:string}[];
  readonly references:readonly string[];
  readonly missingEvidence:readonly string[];
}
/** Project parsing reads only the immutable capture. Referenced/extended config
 * bytes participate in the fingerprint, including failed lookups. */
export class CapturedProjectContexts {
  private readonly contexts=new Map<string,CapturedProjectContext>();
  constructor(private readonly files:ReadonlyMap<string,string>){}
  private key(file:string):string{return path.posix.normalize(file.replace(/\\/g,'/')).replace(/^\//,'');}
  forFile(origin:string):CapturedProjectContext {
    let directory=path.posix.dirname(this.key(origin)),config:string|null=null;
    for(;;){const candidate=path.posix.join(directory,'tsconfig.json');if(this.files.has(candidate)){config=candidate;break;}const parent=path.posix.dirname(directory);if(parent===directory||directory==='.')break;directory=parent;}
    const cacheKey=config??'<tool-default>';const cached=this.contexts.get(cacheKey);if(cached)return cached;
    const read=new Map<string,string>(),missing=new Set<string>();
    const defaults:ts.CompilerOptions={moduleResolution:ts.ModuleResolutionKind.Node10,allowJs:true,target:ts.ScriptTarget.ES2022};
    let options=defaults,references:string[]=[];
    if(config){
      const captured=(f:string)=>{const file=this.key(f);if(!this.files.has(file)){const dependency=file.match(/(?:^|\/)node_modules\/(@[^/]+\/[^/]+|[^/]+)\//);if(dependency)(this.files as ReadonlyMap<string,string>&{loadForImport?:(module:string,origin:string)=>void}).loadForImport?.(dependency[1],origin);}return this.files.get(file);};
      const host:ts.ParseConfigHost={useCaseSensitiveFileNames:true,readDirectory:()=>[],fileExists:f=>captured(f)!==undefined,readFile:f=>{const file=this.key(f),text=captured(f);if(text!==undefined)read.set(file,text);else missing.add(`Captured project configuration required: ${file}`);return text;}};
      const source=ts.readJsonConfigFile('/'+config,host.readFile);
      const parsed=ts.parseJsonSourceFileConfigFileContent(source,host,path.posix.dirname('/'+config),undefined,'/'+config);
      options={...defaults,...parsed.options};
      for(const error of parsed.errors)if(error.code!==18003)missing.add(`Project configuration TS${error.code}: ${ts.flattenDiagnosticMessageText(error.messageText,' ')}`);
      references=(parsed.projectReferences??[]).map(ref=>this.key(ref.path.endsWith('.json')?ref.path:path.posix.join(ref.path,'tsconfig.json')));
      const queue=[...references],seen=new Set<string>([config]);
      for(let index=0;index<queue.length;index++){
        const reference=queue[index];if(seen.has(reference))continue;seen.add(reference);
        if(seen.size>128){missing.add('Project configuration closure exceeds 128-file budget');break;}
        const text=this.files.get(reference);if(text===undefined){missing.add(`Captured project-reference configuration required: ${reference}`);continue;}
        const child=ts.parseJsonSourceFileConfigFileContent(ts.readJsonConfigFile('/'+reference,host.readFile),host,path.posix.dirname('/'+reference),undefined,'/'+reference);
        for(const error of child.errors)if(error.code!==18003)missing.add(`Referenced project configuration TS${error.code}: ${ts.flattenDiagnosticMessageText(error.messageText,' ')}`);
        for(const ref of child.projectReferences??[]){const file=this.key(ref.path.endsWith('.json')?ref.path:path.posix.join(ref.path,'tsconfig.json'));if(!queue.includes(file))queue.push(file);}
      }
      references=[...new Set(queue)].sort();
    }
    const configs=[...read].map(([file,text])=>({file,sha256:createHash('sha256').update(text).digest('hex')})).sort((a,b)=>(a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const context={configFile:config,compilerVersion:ts.version,resolverMode:ts.ModuleResolutionKind[options.moduleResolution!],options,configs,references,missingEvidence:[...missing].sort(),optionsHash:createHash('sha256').update(canonicalJson({compilerVersion:ts.version,options,configs,references,missingEvidence:[...missing].sort()})).digest('hex')};
    this.contexts.set(cacheKey,context);return context;
  }
  manifest():readonly CapturedProjectContext[]{return [...this.contexts.values()].sort((a,b)=>{ const af = a.configFile ?? ''; const bf = b.configFile ?? ''; return af < bf ? -1 : af > bf ? 1 : 0; });}
}
