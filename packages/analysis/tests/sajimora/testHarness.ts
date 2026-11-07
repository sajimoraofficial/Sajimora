import * as ts from 'typescript';
import * as path from 'path';
import {
  RepositoryAnalysisUniverse,
  SymbolRef,
  ProofObligation,
  SymbolKind
} from '@sajimora/core';
import { AnalysisContext } from '../../src/sajimora/context/AnalysisContext';

export function createVirtualEnvironment(
  files: Record<string, string>,
  rootDir = 'E:/virtual-workspace',
  compilerOptions?: ts.CompilerOptions
): {
  universe: RepositoryAnalysisUniverse;
  context: AnalysisContext;
  host: ts.CompilerHost;
  rootDir: string;
} {
  const normRoot = rootDir.replace(/\\/g, '/');
  const virtualFiles = new Map<string, string>();
  const discoveredFiles: string[] = [];

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = relPath.startsWith('/') || relPath.includes(':')
      ? relPath.replace(/\\/g, '/')
      : `${normRoot}/${relPath}`.replace(/\\/g, '/');
    virtualFiles.set(fullPath, content);
    discoveredFiles.push(fullPath);
  }

  const defaultOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    rootDir: normRoot,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: false,
    declaration: true,
    esModuleInterop: true,
    skipLibCheck: true,
    ...(compilerOptions ?? {})
  };

  const defaultHost = ts.createCompilerHost(defaultOptions);

  function normalize(fn: string): string {
    return fn.replace(/\\/g, '/');
  }

  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (fileName, languageVersion, onError) => {
      const norm = normalize(fileName);
      if (virtualFiles.has(norm)) {
        return ts.createSourceFile(norm, virtualFiles.get(norm)!, languageVersion, true);
      }
      return defaultHost.getSourceFile(fileName, languageVersion, onError);
    },
    fileExists: (fileName) => {
      const norm = normalize(fileName);
      return virtualFiles.has(norm) || defaultHost.fileExists(fileName);
    },
    directoryExists: (dirName) => {
      const norm = normalize(dirName);
      if (norm === normRoot || norm.startsWith(normRoot + '/')) return true;
      return defaultHost.directoryExists ? defaultHost.directoryExists(dirName) : true;
    },
    readFile: (fileName) => {
      const norm = normalize(fileName);
      return virtualFiles.get(norm) ?? defaultHost.readFile(fileName);
    },
    resolveModuleNameLiterals: (moduleLiterals, containingFile, redirectedReference, options) => {
      return moduleLiterals.map(literal => {
        return ts.resolveModuleName(literal.text, containingFile, options, host);
      });
    },
    getCurrentDirectory: () => normRoot,
    getCanonicalFileName: (f) => normalize(f),
    useCaseSensitiveFileNames: () => true
  };

  const universe: RepositoryAnalysisUniverse = {
    rootPath: normRoot,
    discoveredFiles,
    discoveredFileSet: new Set(discoveredFiles),
    excludedFiles: new Map(),
    unsupportedFiles: [],
    unreadableFiles: [],
    parseFailures: new Map(),
    discoveryStatus: 'DISCOVERY_COMPLETE',
    discoveryEvidence: 'Virtual test universe'
  };

  const context = new AnalysisContext(universe, {
    compilerHost: host,
    compilerOptions: defaultOptions
  });

  return { universe, context, host, rootDir: normRoot };
}

export function createMockSymbolRef(
  name: string,
  kind: SymbolKind = 'FUNCTION',
  file = 'E:/virtual-workspace/provider.ts',
  line = 1
): SymbolRef {
  return {
    persistentSymbolId: `${file}::${name}`,
    symbolId: name,
    fingerprint: {
      value: `fp:${name}`,
      components: {
        globallyQualifiedOwner: file,
        symbolLocalName: name,
        kind,
        parameterTypeFingerprint: 'any'
      }
    },
    qualifiedName: name,
    kind,
    ownerId: null,
    declarationLocation: {
      filePath: file,
      line
    }
  };
}

export function createMockObligation(
  symbol: SymbolRef,
  relation: 'STRUCTURAL_CO_EVOLUTION' | 'INTERFACE_PRESERVATION' = 'STRUCTURAL_CO_EVOLUTION',
  contracts?: { before: any; after: any }
): ProofObligation {
  return {
    invariantId: `INV-${symbol.symbolId || symbol.qualifiedName}`,
    relation,
    mutatedSymbol: symbol,
    providerMutation: {
      targetSymbolId: symbol.persistentSymbolId,
      beforeExists: true,
      afterExists: true,
      classification: 'EXPORTED_SIGNATURE_MUTATED',
      isAstDiffDerived: true,
      beforeParsed: true,
      afterParsed: true
    },
    providerContracts: contracts
  };
}
