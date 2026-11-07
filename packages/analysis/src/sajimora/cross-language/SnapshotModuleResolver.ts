import * as ts from 'typescript';
import * as path from 'node:path';
import {CapturedProjectContexts,CapturedProjectContext} from './CapturedProjectContext';

/** Module resolution against captured bytes only: never consult the live filesystem. */
export class SnapshotModuleResolver {
  private readonly files = new Map<string, string>();
  private readonly originals = new Map<string, string>();
  private readonly cache = new Map<string, string | undefined>();
  private readonly projects:CapturedProjectContexts;
  constructor(private readonly inputFiles: ReadonlyMap<string, string>) {
    this.projects=new CapturedProjectContexts(inputFiles);
    const files=inputFiles;
    for (const [file, text] of files) {
      const key = this.normalize(file);
      this.files.set(key, text);
      this.originals.set(key, file);
    }
  }
  private normalize(file: string): string {
    return path.posix.resolve('/', file.replace(/\\/g, '/'));
  }
  resolve(module: string, origin: string): string | undefined {
    const key = `${origin}\0${module}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const project=this.context(origin),options=project.options;
    if(project.missingEvidence.length&&!module.startsWith('.'))return undefined;
    const workspace=(this.inputFiles as ReadonlyMap<string,string>&{workspaceImport?:(module:string,origin:string)=>{installation:string;target:string}|undefined}).workspaceImport?.(module,origin);
    const redirect=(file:string)=>{const key=this.normalize(file);return workspace&&key.startsWith(this.normalize(workspace.installation)+'/')?this.normalize(workspace.target)+key.slice(this.normalize(workspace.installation).length):key;};
    const host: ts.ModuleResolutionHost = {
      fileExists: file => this.files.has(redirect(file)),
      readFile: file => this.files.get(redirect(file)),
      realpath:file=>redirect(file),
      getCurrentDirectory: () => '/',
    };
    const mode=options.moduleResolution===ts.ModuleResolutionKind.Node16||options.moduleResolution===ts.ModuleResolutionKind.NodeNext?ts.getImpliedNodeFormatForFile(this.normalize(origin),undefined,host,options):undefined;
    let resolved = ts.resolveModuleName(module, this.normalize(origin), options, host,undefined,undefined,mode).resolvedModule;
    if(!resolved||resolved.resolvedFileName.replace(/\\/g,'/').includes('/node_modules/')){
      const demand=this.inputFiles as ReadonlyMap<string,string>&{loadForImport?:(module:string,origin:string)=>void};
      const previousSize=this.inputFiles.size;
      demand.loadForImport?.(module,origin);
      if(this.inputFiles.size!==previousSize||this.inputFiles.size!==this.files.size){
        for(const [file,text]of this.inputFiles){const normalized=this.normalize(file);if(!this.files.has(normalized)){this.files.set(normalized,text);this.originals.set(normalized,file);}}
        resolved=ts.resolveModuleName(module,this.normalize(origin),options,host,undefined,undefined,mode).resolvedModule;
      }
    }
    const admission=this.inputFiles as ReadonlyMap<string,string>&{allowsResolution?:(module:string,origin:string,resolved:string)=>boolean};
    if(resolved&&resolved.resolvedFileName.replace(/\\/g,'/').includes('/node_modules/')&&admission.allowsResolution?.(module,origin,resolved.resolvedFileName)===false)resolved=undefined;
    const result = resolved && this.originals.get(redirect(resolved.resolvedFileName));
    this.cache.set(key, result);
    return result;
  }
  context(origin:string):CapturedProjectContext {
    const context=this.projects.forFile(origin);
    (this.inputFiles as ReadonlyMap<string,string>&{recordProjectContext?:(context:CapturedProjectContext)=>void}).recordProjectContext?.(context);
    return context;
  }
}
