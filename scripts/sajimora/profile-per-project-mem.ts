import * as path from 'node:path';
import * as fs from 'node:fs';
import * as ts from 'typescript';
import {
  GitRepository,
  RevisionResolver,
  GitObjectReader,
  SnapshotFilesystem,
  TypeScriptV1Adapter
} from '@sajimora/analysis';
import { resolveDependencyStore } from './command';

const slash = (value: string) => value.replace(/\\/g, '/');

function logMem(label: string) {
  if (global.gc) {
    try { global.gc(); } catch {}
  }
  const m = process.memoryUsage();
  const mb = (b: number) => (b / (1024 * 1024)).toFixed(2) + ' MB';
  console.log(`[${label.padEnd(45)}] heapUsed: ${mb(m.heapUsed).padStart(9)} | heapTotal: ${mb(m.heapTotal).padStart(9)} | rss: ${mb(m.rss).padStart(9)}`);
}

async function run() {
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

    console.log(`Found ${configs.length} configs. Tracking memory per project...`);
    logMem('BEFORE_ANY_PROJECT');

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

    const retainedProjects: any[] = [];

    for (let i = 0; i < configs.length; i++) {
      const configRel = configs[i];
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
        getSourceFile: (f, langVer, onError) => {
          if (!allowed(f)) return undefined;
          const text = base.readFile(mapped(f));
          return text === undefined ? undefined : ts.createSourceFile(f, text, langVer, true);
        },
        writeFile: () => {},
        trace: () => {},
        getCurrentDirectory: () => root,
        realpath: f => f
      };

      const t0 = Date.now();
      const program = ts.createProgram({
        rootNames: parsed.fileNames,
        options: { ...options, noEmit: true },
        projectReferences: parsed.projectReferences,
        host
      });
      const tProg = Date.now() - t0;
      
      const t1 = Date.now();
      const diags = ts.getPreEmitDiagnostics(program);
      const tDiag = Date.now() - t1;

      retainedProjects.push({ program, options });
      logMem(`[${i+1}/${configs.length}] ${configRel} (${program.getSourceFiles().length} files, diags=${diags.length}, prog=${tProg}ms, diag=${tDiag}ms)`);
    }

  } finally {
    snapshot.cleanup();
  }
}

run().catch(console.error);
