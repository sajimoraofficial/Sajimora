import * as path from 'node:path';
import * as fs from 'node:fs';
import * as ts from 'typescript';
import {
  GitRepository,
  GitObjectReader,
  SnapshotFilesystem
} from '@sajimora/analysis';
import { resolveDependencyStore } from './command';

const slash = (v: string) => v.replace(/\\/g, '/');

async function inspectOverlap() {
  const repoPath = path.resolve('scripts/campaign/repos/zod');
  const parentSha = '68a609ac9b9516e6fe84e3558f17ce16b1032bef';
  const repository = new GitRepository(repoPath);
  repository.validate();
  const snapshots = new SnapshotFilesystem(new GitObjectReader(repository));
  const snapshot = snapshots.materialize(parentSha);

  try {
    const root = path.resolve(snapshot.root);
    const rootPrefix = root + path.sep;
    const configs = snapshot.trackedFiles.filter(f => /(^|\/)tsconfig\.json$/.test(slash(f))).sort();
    const dependencyStore = resolveDependencyStore(repoPath, snapshot);
    const depRoot = dependencyStore?.root;

    const inside = (file: string, r: string, prefix: string) => {
      const resolved = path.resolve(file);
      return resolved === r || resolved.startsWith(prefix);
    };

    const parseHost: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      fileExists: f => inside(f, root, rootPrefix) && ts.sys.fileExists(f),
      readFile: f => inside(f, root, rootPrefix) ? ts.sys.readFile(f) : undefined,
      readDirectory: (dir, ext, exclude, include, depth) =>
        inside(dir, root, rootPrefix) ? ts.sys.readDirectory(dir, ext, exclude, include, depth).filter(f => inside(f, root, rootPrefix)) : []
    };

    console.log(`=== TSCONFIG INSPECTION ACROSS ${configs.length} PROJECTS ===\n`);

    const projectData: Array<{
      config: string;
      rawConfig: any;
      fileNames: string[];
      references: readonly ts.ProjectReference[] | undefined;
      sourceFiles: string[];
      repoFiles: string[];
      libFiles: string[];
      depFiles: string[];
    }> = [];

    const allRepoFiles = new Set<string>();
    const allLibFiles = new Set<string>();
    const allDepFiles = new Set<string>();

    for (const configRel of configs) {
      const configPath = path.join(root, ...slash(configRel).split('/'));
      const read = ts.readConfigFile(configPath, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(read.config, parseHost, path.dirname(configPath), undefined, configPath);
      const options = parsed.options;
      const base = ts.createCompilerHost(options);
      const libRoot = path.resolve(path.dirname(ts.getDefaultLibFilePath(options)));
      const libPrefix = libRoot + path.sep;
      const dep = depRoot ? path.resolve(depRoot) : undefined;
      const virtualModules = path.join(root, 'node_modules');
      const mapped = (f: string) => {
        const resolved = path.resolve(f);
        if (dep && (resolved === virtualModules || resolved.startsWith(virtualModules + path.sep))) {
          return path.join(dep, path.relative(virtualModules, resolved));
        }
        return resolved;
      };
      const allowed = (f: string) => {
        const m = mapped(f);
        return inside(m, root, rootPrefix) || inside(m, libRoot, libPrefix) || Boolean(dep && inside(m, dep, dep + path.sep));
      };

      const host: ts.CompilerHost = {
        ...base,
        fileExists: f => allowed(f) && base.fileExists(mapped(f)),
        readFile: f => allowed(f) ? base.readFile(mapped(f)) : undefined,
        directoryExists: d => allowed(d) && Boolean(base.directoryExists?.(mapped(d))),
        getDirectories: d => allowed(d) ? (base.getDirectories?.(mapped(d)) ?? []) : [],
        readDirectory: (d, e, x, i, depth) => allowed(d) ? ts.sys.readDirectory(mapped(d), e, x, i, depth) : [],
        getSourceFile: (f, langVer) => {
          if (!allowed(f)) return undefined;
          const text = base.readFile(mapped(f));
          return text === undefined ? undefined : ts.createSourceFile(f, text, langVer, true);
        },
        writeFile: () => {},
        trace: () => {},
        getCurrentDirectory: () => root,
        realpath: f => f
      };

      const program = ts.createProgram({
        rootNames: parsed.fileNames,
        options: { ...options, noEmit: true },
        projectReferences: parsed.projectReferences,
        host
      });

      const sfs = program.getSourceFiles();
      const repoFiles: string[] = [];
      const libFiles: string[] = [];
      const depFiles: string[] = [];

      for (const sf of sfs) {
        const fn = slash(sf.fileName);
        const resolved = path.resolve(sf.fileName);
        if (inside(resolved, root, rootPrefix)) {
          const rel = slash(path.relative(root, resolved));
          if (rel.startsWith('node_modules/')) {
            depFiles.push(rel);
            allDepFiles.add(rel);
          } else {
            repoFiles.push(rel);
            allRepoFiles.add(rel);
          }
        } else if (inside(mapped(resolved), libRoot, libPrefix)) {
          libFiles.push(fn);
          allLibFiles.add(fn);
        } else {
          depFiles.push(fn);
          allDepFiles.add(fn);
        }
      }

      projectData.push({
        config: configRel,
        rawConfig: read.config,
        fileNames: parsed.fileNames.map(f => slash(path.relative(root, f))),
        references: parsed.projectReferences,
        sourceFiles: sfs.map(sf => sf.fileName),
        repoFiles,
        libFiles,
        depFiles
      });
    }

    console.log('--- Summary per project ---');
    for (const p of projectData) {
      console.log(`\nConfig: ${p.config}`);
      console.log(`  Extends: ${p.rawConfig.extends ?? '<none>'}`);
      console.log(`  Project References: ${p.references ? p.references.map(r => r.path).join(', ') : '<none>'}`);
      console.log(`  Total SourceFiles in Program: ${p.sourceFiles.length}`);
      console.log(`    - Repo files: ${p.repoFiles.length}`);
      console.log(`    - TS Lib files: ${p.libFiles.length}`);
      console.log(`    - Dependency / node_modules files: ${p.depFiles.length}`);
    }

    console.log('\n--- Across all 11 Projects ---');
    console.log(`Total SourceFile materializations across all programs: ${projectData.reduce((acc, p) => acc + p.sourceFiles.length, 0)}`);
    console.log(`Unique Repo Files across all projects: ${allRepoFiles.size}`);
    console.log(`Unique TS Lib Files: ${allLibFiles.size}`);
    console.log(`Unique Dep Files: ${allDepFiles.size}`);
    console.log(`Sum of unique files: ${allRepoFiles.size + allLibFiles.size + allDepFiles.size}`);

    // Check overlap with root tsconfig.json
    const rootP = projectData.find(p => p.config === 'tsconfig.json');
    if (rootP) {
      console.log('\n--- Root tsconfig.json Subsumption Analysis ---');
      console.log(`Root tsconfig has ${rootP.repoFiles.length} repo files.`);
      const rootSet = new Set(rootP.repoFiles);
      for (const p of projectData) {
        if (p === rootP) continue;
        const inRoot = p.repoFiles.filter(f => rootSet.has(f)).length;
        const pct = ((inRoot / p.repoFiles.length) * 100).toFixed(1);
        console.log(`  ${p.config}: ${inRoot}/${p.repoFiles.length} (${pct}%) repo files already present in root tsconfig.json`);
      }
    }

    // Check project reference structure
    console.log('\n--- Project References Structure ---');
    for (const p of projectData) {
      if (p.references && p.references.length > 0) {
        console.log(`  ${p.config} references:`, p.references);
      }
    }

  } finally {
    snapshot.cleanup();
  }
}

inspectOverlap().catch(console.error);
