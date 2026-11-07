/**
 * @file JavaSealedCompilerHost.ts
 * Sealed filesystem Java compiler and symbol resolution host for Sajimora Phase J-3.
 */

import {
  JavaClassDeclIR,
  JavaImportIR,
  JavaCallSiteIR,
  ParsedJavaFile,
  JavaTypeIRExtractor
} from '../ir';

export interface SealedJavaSnapshotInput {
  readonly root?: string;
  readonly trackedFiles: readonly string[];
  readTextFile(relativePath: string): string | undefined;
}

export type JavaSymbolResolution =
  | { readonly status: 'RESOLVED'; readonly fqcn: string; readonly declaration?: JavaClassDeclIR }
  | { readonly status: 'UNRESOLVED'; readonly reason: string; readonly searchedName: string }
  | { readonly status: 'AMBIGUOUS'; readonly candidates: readonly string[]; readonly reason: string; readonly searchedName: string };

const STANDARD_JAVA_LANG_CLASSES: ReadonlySet<string> = new Set([
  'Object', 'String', 'Number', 'Integer', 'Long', 'Double', 'Float',
  'Boolean', 'Byte', 'Character', 'Short', 'CharSequence', 'Comparable',
  'Iterable', 'Cloneable', 'AutoCloseable', 'Runnable', 'Thread',
  'Throwable', 'Exception', 'RuntimeException', 'Error', 'IllegalArgumentException',
  'IllegalStateException', 'NullPointerException', 'IndexOutOfBoundsException',
  'Class', 'ClassLoader', 'System', 'Math', 'StringBuilder', 'StringBuffer',
  'Void', 'Enum', 'Record', 'Override', 'Deprecated', 'SuppressWarnings'
]);

export class JavaSealedCompilerHost {
  private readonly classIndex = new Map<string, JavaClassDeclIR>();
  private readonly binaryIndex = new Map<string, JavaClassDeclIR>();
  private readonly shortClassMap = new Map<string, string[]>();
  private readonly packageMap = new Map<string, string[]>();
  private readonly fileClassesMap = new Map<string, JavaClassDeclIR[]>();
  private readonly fileImportsMap = new Map<string, JavaImportIR[]>();
  private readonly parsedFiles = new Map<string, ParsedJavaFile>();
  private readonly discoveredJavaFiles: readonly string[];
  private readonly sourceContents = new Map<string, string>();

  constructor(snapshot: SealedJavaSnapshotInput) {
    const paths = snapshot.trackedFiles.map(path => path.replace(/\\/g, '/'));
    if (new Set(paths).size !== paths.length || paths.some(path =>
      path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..'))) {
      throw new Error('INVALID_SEALED_JAVA_PATH_INVENTORY');
    }
    const originalPaths = new Map(paths.map((path, index) => [path, snapshot.trackedFiles[index]]));
    const javaFiles = paths
      .filter(f => f.endsWith('.java'))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    this.discoveredJavaFiles = javaFiles;

    for (const file of javaFiles) {
      const originalPath = originalPaths.get(file)!;
      const content = snapshot.readTextFile(originalPath);
      if (content === undefined) {
        throw new Error(`Sealed SnapshotFilesystem read failure: missing tracked file ${file}`);
      }
      this.sourceContents.set(file, content);
      const parsed = JavaTypeIRExtractor.parseJavaSource(file, content);
      this.parsedFiles.set(file, parsed);
      this.fileImportsMap.set(file, [...parsed.imports]);
      this.fileClassesMap.set(file, [...parsed.classes]);

      for (const cls of parsed.classes) {
        this.classIndex.set(cls.fqcn, cls);
        this.binaryIndex.set(cls.binaryName, cls);

        const existing = this.shortClassMap.get(cls.name) ?? [];
        if (!existing.includes(cls.fqcn)) {
          existing.push(cls.fqcn);
          existing.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          this.shortClassMap.set(cls.name, existing);
        }

        const pkgClasses = this.packageMap.get(cls.packageName) ?? [];
        if (!pkgClasses.includes(cls.name)) {
          pkgClasses.push(cls.name);
          pkgClasses.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          this.packageMap.set(cls.packageName, pkgClasses);
        }
      }
    }
  }

  public getTrackedJavaFiles(): readonly string[] {
    return [...this.discoveredJavaFiles];
  }

  public getClassByFQCN(fqcn: string): JavaClassDeclIR | undefined {
    return structuredClone(this.classIndex.get(fqcn) ?? this.binaryIndex.get(fqcn));
  }

  public getAllClasses(): readonly JavaClassDeclIR[] {
    return structuredClone([...this.classIndex.values()].sort((a, b) => (a.fqcn < b.fqcn ? -1 : a.fqcn > b.fqcn ? 1 : 0)));
  }

  public getFileImports(filePath: string): readonly JavaImportIR[] {
    return structuredClone(this.fileImportsMap.get(filePath.replace(/\\/g, '/')) ?? []);
  }

  public getFileClasses(filePath: string): readonly JavaClassDeclIR[] {
    return structuredClone(this.fileClassesMap.get(filePath.replace(/\\/g, '/')) ?? []);
  }

  public getFileCallSites(filePath: string): readonly JavaCallSiteIR[] {
    return structuredClone(this.parsedFiles.get(filePath.replace(/\\/g, '/'))?.callSites ?? []);
  }

  public getFileContent(filePath: string): string | undefined {
    return this.sourceContents.get(filePath.replace(/\\/g, '/'));
  }

  public getAllCallSites(): readonly JavaCallSiteIR[] {
    const all: JavaCallSiteIR[] = [];
    for (const p of this.parsedFiles.values()) {
      if (p.callSites) all.push(...p.callSites);
    }
    return structuredClone(all.sort((a, b) => {
      if (a.enclosingClassFqcn !== b.enclosingClassFqcn) {
        return a.enclosingClassFqcn < b.enclosingClassFqcn ? -1 : 1;
      }
      return a.line - b.line;
    }));
  }

  public resolveClass(name: string, fromFile?: string): JavaSymbolResolution {
    return structuredClone(this.resolveClassInternal(name, fromFile));
  }

  private resolveClassInternal(name: string, fromFile?: string): JavaSymbolResolution {
    const trimmed = name.trim();
    if (!trimmed) {
      return { status: 'UNRESOLVED', reason: 'EMPTY_SYMBOL_NAME', searchedName: name };
    }

    const directMatch = this.classIndex.get(trimmed) ?? this.binaryIndex.get(trimmed);
    if (directMatch) {
      return { status: 'RESOLVED', fqcn: directMatch.fqcn, declaration: directMatch };
    }

    if (trimmed.includes('.')) {
      const binaryEquivalent = trimmed.replace(/\.([A-Z][A-Za-z0-9_$]*)$/, '$$$1');
      const innerMatch = this.binaryIndex.get(binaryEquivalent);
      if (innerMatch) {
        return { status: 'RESOLVED', fqcn: innerMatch.fqcn, declaration: innerMatch };
      }
      if (trimmed.startsWith('java.lang.') || trimmed.startsWith('java.util.')) {
        return { status: 'RESOLVED', fqcn: trimmed };
      }
      return { status: 'UNRESOLVED', reason: `QUALIFIED_CLASS_NOT_FOUND: ${trimmed}`, searchedName: trimmed };
    }

    const normFile = fromFile ? fromFile.replace(/\\/g, '/') : undefined;
    const fileImports = normFile ? (this.fileImportsMap.get(normFile) ?? []) : [];
    const fileParsed = normFile ? this.parsedFiles.get(normFile) : undefined;
    const filePackage = fileParsed?.packageName ?? '';

    for (const imp of fileImports) {
      if (!imp.isWildcard && imp.importedName === trimmed) {
        const decl = this.classIndex.get(imp.moduleSpecifier);
        return { status: 'RESOLVED', fqcn: imp.moduleSpecifier, declaration: decl };
      }
    }

    if (filePackage) {
      const samePkgFQCN = `${filePackage}.${trimmed}`;
      const samePkgMatch = this.classIndex.get(samePkgFQCN);
      if (samePkgMatch) {
        return { status: 'RESOLVED', fqcn: samePkgFQCN, declaration: samePkgMatch };
      }
    }

    if (STANDARD_JAVA_LANG_CLASSES.has(trimmed)) {
      return { status: 'RESOLVED', fqcn: `java.lang.${trimmed}` };
    }

    const wildcardCandidates: string[] = [];
    for (const imp of fileImports) {
      if (imp.isWildcard) {
        const pkg = imp.moduleSpecifier.replace(/\.\*$/, '');
        const candidateFQCN = `${pkg}.${trimmed}`;
        if (this.classIndex.has(candidateFQCN)) {
          wildcardCandidates.push(candidateFQCN);
        }
      }
    }

    if (wildcardCandidates.length === 1) {
      const decl = this.classIndex.get(wildcardCandidates[0]);
      return { status: 'RESOLVED', fqcn: wildcardCandidates[0], declaration: decl };
    }
    if (wildcardCandidates.length > 1) {
      wildcardCandidates.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return {
        status: 'AMBIGUOUS',
        candidates: wildcardCandidates,
        reason: `WILDCARD_COLLISION: ${trimmed} found in multiple wildcard imports: ${wildcardCandidates.join(', ')}`,
        searchedName: trimmed
      };
    }

    const allMatching = this.shortClassMap.get(trimmed) ?? [];
    if (allMatching.length > 1) {
      return {
        status: 'AMBIGUOUS',
        candidates: allMatching,
        reason: `AMBIGUOUS_UNQUALIFIED_REFERENCE: ${trimmed} matches multiple classes in repository`,
        searchedName: trimmed
      };
    }

    if (allMatching.length === 1 && !fromFile) {
      const decl = this.classIndex.get(allMatching[0]);
      return { status: 'RESOLVED', fqcn: allMatching[0], declaration: decl };
    }

    return {
      status: 'UNRESOLVED',
      reason: `SYMBOL_UNRESOLVED: ${trimmed} not found in imports, package, or standard library`,
      searchedName: trimmed
    };
  }
}
