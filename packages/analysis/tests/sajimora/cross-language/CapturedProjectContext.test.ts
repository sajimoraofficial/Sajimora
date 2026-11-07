import {describe,it,expect} from 'vitest';
import * as ts from 'typescript';
import {CapturedProjectContexts} from '../../../src/sajimora/cross-language/CapturedProjectContext';
import {SnapshotModuleResolver} from '../../../src/sajimora/cross-language/SnapshotModuleResolver';
import {DependencyDeclarationContext} from '../../../src/sajimora/cross-language/DependencyDeclarationContext';

describe('spec 02 captured project and dependency identity',()=>{
  it('fingerprints extends and project-reference closures and retains strictness',()=>{
    const files=new Map([['tsconfig.json','{"extends":"./base.json","references":[{"path":"./child"}],"compilerOptions":{"exactOptionalPropertyTypes":true,"noUncheckedIndexedAccess":true}}'],['base.json','{"compilerOptions":{"strict":true,"baseUrl":".","paths":{"@x/*":["src/*"]}}}'],['child/tsconfig.json','{"extends":"../child-base.json","references":[{"path":"../leaf"}]}'],['child-base.json','{"compilerOptions":{"strictNullChecks":true}}'],['leaf/tsconfig.json','{}'],['src/model.ts','export interface Model{id:string;}']]);
    const first=new CapturedProjectContexts(files).forFile('src/model.ts');
    expect(first.options).toMatchObject({strict:true,exactOptionalPropertyTypes:true,noUncheckedIndexedAccess:true});
    expect(first.configs.map(c=>c.file)).toEqual(['base.json','child-base.json','child/tsconfig.json','leaf/tsconfig.json','tsconfig.json']);
    expect(first.references).toEqual(['child/tsconfig.json','leaf/tsconfig.json']);
    files.set('child-base.json','{"compilerOptions":{"strictNullChecks":false}}');
    expect(new CapturedProjectContexts(files).forFile('src/model.ts').optionsHash).not.toBe(first.optionsHash);
  });
  it('retains a precise evidence request for an absent reference and invalid config',()=>{
    const context=new CapturedProjectContexts(new Map([['tsconfig.json','{"references":[{"path":"./missing"}],"compilerOptions":{"moduleResolution":"invented"}}']])).forFile('client.ts');
    expect(context.missingEvidence.some(m=>m.includes('missing/tsconfig.json'))).toBe(true);
    expect(context.missingEvidence.some(m=>m.includes('TS'))).toBe(true);
  });
  it('selects import and require export conditions for captured mts and cts callers',()=>{
    const files=new Map([['tsconfig.json','{"compilerOptions":{"module":"nodenext","moduleResolution":"nodenext"}}'],['client.mts',''],['client.cts',''],['node_modules/library/package.json','{"name":"library","version":"1.0.0","exports":{".":{"import":{"types":"./import.d.mts"},"require":{"types":"./require.d.cts"}}}}'],['node_modules/library/import.d.mts','export interface Value{id:string;}'],['node_modules/library/require.d.cts','export interface Value{name:string;}']]);
    const resolver=new SnapshotModuleResolver(files);
    expect(resolver.resolve('library','client.mts')).toBe('node_modules/library/import.d.mts');
    expect(resolver.resolve('library','client.cts')).toBe('node_modules/library/require.d.cts');
  });
  it('honors typesVersions with the pinned compiler instead of the fallback declaration',()=>{
    const files=new Map([['client.ts',''],['node_modules/library/package.json','{"name":"library","version":"1.0.0","types":"index.d.ts","typesVersions":{"<5.0":{"*":["old.d.ts"]},">=5.0":{"*":["current.d.ts"]}}}'],['node_modules/library/index.d.ts','export type Value=boolean;'],['node_modules/library/old.d.ts','export type Value=number;'],['node_modules/library/current.d.ts','export type Value=string;']]);
    expect(new SnapshotModuleResolver(files).resolve('library','client.ts')).toBe('node_modules/library/current.d.ts');
  });
  it('resolves a locked workspace link from captured declarations without installation',()=>{
    const files=new DependencyDeclarationContext(new Map([['package-lock.json',JSON.stringify({lockfileVersion:3,packages:{'node_modules/library':{resolved:'packages/library',link:true},'packages/library':{version:'1.0.0'}}})],['packages/library/package.json','{"name":"library","version":"1.0.0","types":"index.d.ts"}'],['packages/library/index.d.ts','export interface Value{id:string;}'],['app/client.ts','']]));
    expect(new SnapshotModuleResolver(files).resolve('library','app/client.ts')).toBe('packages/library/index.d.ts');
    expect(files.manifest().packages[0].origin).toBe('CAPTURED_WORKSPACE');
    expect(files.requests).toEqual([]);
  });
  it('rejects captured dependency bytes with a version contradicting the lock',()=>{
    const files=new DependencyDeclarationContext(new Map([['client.ts',''],['package-lock.json',JSON.stringify({lockfileVersion:3,packages:{'node_modules/library':{version:'1.0.0',integrity:'sha512-AA=='}}})],['node_modules/library/package.json','{"name":"library","version":"2.0.0","types":"index.d.ts"}'],['node_modules/library/index.d.ts','export interface Value{id:string;}']]));
    expect(new SnapshotModuleResolver(files).resolve('library','client.ts')).toBeUndefined();
    expect(files.requests[0].reason).toContain('contradicts');
  });
  it('admits captured pinned standard libraries and records their byte hashes',()=>{
    const files=new DependencyDeclarationContext(new Map([['package.json','{}'],['node_modules/typescript/package.json',JSON.stringify({name:'typescript',version:ts.version})],['node_modules/typescript/lib/lib.es2022.full.d.ts','interface String{}']]));
    expect(files.compilerLibraries('client.ts',{target:ts.ScriptTarget.ES2022})).toMatchObject({defaultLibrary:'node_modules/typescript/lib/lib.es2022.full.d.ts',missingEvidence:[]});
    expect(files.manifest().standardLibraries[0].declarations[0].sha256).toHaveLength(64);
  });
  it('does not substitute current compiler libraries for a different locked compiler',()=>{
    const files=new DependencyDeclarationContext(new Map([['package-lock.json',JSON.stringify({lockfileVersion:3,packages:{'node_modules/typescript':{version:'4.9.5',integrity:'sha512-AA=='}}})],['node_modules/typescript/package.json',JSON.stringify({name:'typescript',version:ts.version})],['node_modules/typescript/lib/lib.es2022.full.d.ts','interface String{}']]));
    const result=files.compilerLibraries('client.ts',{target:ts.ScriptTarget.ES2022});
    expect(result.defaultLibrary).toBeNull();
    expect(result.missingEvidence[0]).toContain('4.9.5');
  });
});
