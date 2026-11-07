/**
 * Inventory-only discovery for the first certified repository-wide scope:
 * direct static named ESM imports of an exported top-level function.  It uses
 * TypeScript's checker to bind imports/calls; it never turns an unresolved
 * candidate into a certified consumer.
 */
import * as path from 'node:path';
import ts from 'typescript';

export type InventoryStatus = 'DIRECT_CALL' | 'UNUSED_DIRECT_IMPORT' | 'UNRESOLVED_REFERENCE_FORM' | 'UNRESOLVED_IMPORT' | 'EXCLUDED_FILE';
export interface InventoryFile { path: string; content: string; }
export interface ConsumerSite { file: string; start: number; end: number; localName: string; status: InventoryStatus; reason?: string; }
export interface ConsumerInventory {
  schemaVersion: 'SAJIMORA_TS_DIRECT_CONSUMER_INVENTORY_V1';
  scope: { targetFile: string; targetSymbol: string; selectedProjectFiles: string[] };
  visitedFiles: string[];
  excludedFiles: Array<{ file: string; reason: string }>;
  consumerSites: ConsumerSite[];
  unresolvedImports: Array<{ file: string; specifier: string; reason: string }>;
  completeness: 'COMPLETE_FOR_DIRECT_NAMED_CALLS' | 'INCOMPLETE';
  boundary: string;
}

const slash = (value: string) => value.replace(/\\/g, '/');
const virtual = (file: string) => `/sajimora/${slash(file).replace(/^\/+/, '')}`;

function sameSymbol(checker: ts.TypeChecker, left: ts.Symbol | undefined, right: ts.Symbol | undefined): boolean {
  if (!left || !right) return false;
  const deref = (symbol: ts.Symbol) => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return deref(left) === deref(right);
}

/** Inventory is deterministic for the supplied sealed bytes and selected file list. */
export function inventoryDirectNamedCalls(input: {
  files: InventoryFile[];
  projectFileIds: string[];
  targetFile: string;
  targetSymbol: string;
  /** Frozen effective options from the selected tsconfig, never ambient defaults. */
  compilerOptions?: ts.CompilerOptions;
  /** F0.3: opt in only after exact named-alias binding proof is available. */
  allowRenamedNamedImports?: boolean;
}): ConsumerInventory {
  const selected = new Set(input.projectFileIds.map(slash));
  const byVirtual = new Map(input.files.map(file => [virtual(file.path), file.content]));
  const rootNames = [...selected].filter(file => /\.tsx?$/.test(file)).map(virtual).sort();
  const options: ts.CompilerOptions = { strict: true, noLib: true, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, ...input.compilerOptions, noEmit: true };
  const host: ts.CompilerHost = {
    fileExists: file => byVirtual.has(slash(file)) || ts.sys.fileExists(file),
    readFile: file => byVirtual.get(slash(file)) ?? ts.sys.readFile(file),
    getSourceFile: (file, languageVersion) => {
      const text = byVirtual.get(slash(file));
      return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => '', writeFile: () => undefined,
    getCurrentDirectory: () => '/sajimora', getDirectories: () => [],
    getCanonicalFileName: file => file, useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n', directoryExists: dir => [...byVirtual.keys()].some(file => file.startsWith(`${slash(dir).replace(/\/$/, '')}/`)),
    realpath: file => file
  };
  const program = ts.createProgram({ rootNames, options, host });
  const checker = program.getTypeChecker();
  const targetSource = program.getSourceFile(virtual(input.targetFile));
  const targetNode = targetSource?.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === input.targetSymbol && !!node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
  const target = targetNode?.name ? checker.getSymbolAtLocation(targetNode.name) : undefined;
  const sites: ConsumerSite[] = [], unresolvedImports: Array<{ file: string; specifier: string; reason: string }> = [];
  const visitedFiles: string[] = [];
  for (const source of program.getSourceFiles().filter(sf => sf.fileName.startsWith('/sajimora/')).sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    const file = source.fileName.slice('/sajimora/'.length); visitedFiles.push(file);
    const imports = new Map<string, { importSymbol: ts.Symbol; importStart: number; localName: string }>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const module = statement.moduleSpecifier.text;
      const resolution = ts.resolveModuleName(module, source.fileName, options, host).resolvedModule;
      if (!resolution) unresolvedImports.push({ file, specifier: module, reason: 'TypeScript module resolution failed under the frozen compiler options' });
      if (statement.importClause?.name) sites.push({ file, start: statement.importClause.name.getStart(source), end: statement.importClause.name.getEnd(), localName: statement.importClause.name.text, status: 'UNRESOLVED_REFERENCE_FORM', reason: 'Default import is outside the direct named-import scope' });
      const named = statement.importClause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        sites.push({ file, start: named.getStart(source), end: named.getEnd(), localName: named.name.text, status: 'UNRESOLVED_REFERENCE_FORM', reason: 'Namespace import is outside the direct named-import scope' });
        continue;
      }
      if (!named || !ts.isNamedImports(named)) continue;
      for (const element of named.elements) {
        const symbol = checker.getSymbolAtLocation(element.name);
        const importedName = element.propertyName?.text ?? element.name.text;
        const resolvesDirectlyToProvider = resolution?.resolvedFileName === virtual(input.targetFile);
        if (sameSymbol(checker, symbol, target) && resolvesDirectlyToProvider && (!element.propertyName || input.allowRenamedNamedImports) && symbol) imports.set(element.name.text, { importSymbol: symbol, importStart: element.getStart(source), localName: element.name.text });
        else if (sameSymbol(checker, symbol, target) && element.propertyName) sites.push({ file, start: element.getStart(source), end: element.getEnd(), localName: element.name.text, status: 'UNRESOLVED_REFERENCE_FORM', reason: 'Renamed named import is compiler-resolved but outside the initial direct-import scope' });
        else if (sameSymbol(checker, symbol, target)) sites.push({ file, start: element.getStart(source), end: element.getEnd(), localName: element.name.text, status: 'UNRESOLVED_REFERENCE_FORM', reason: 'Re-export/barrel resolution reaches the provider but is outside the direct module-import scope' });
        else if (importedName === input.targetSymbol) sites.push({ file, start: element.getStart(source), end: element.getEnd(), localName: element.name.text, status: 'UNRESOLVED_REFERENCE_FORM', reason: 'Import spells the target export but compiler binding does not resolve to the sealed provider symbol' });
      }
    }
    const called = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const local = imports.get(node.expression.text);
        // Name equality is not binding evidence: a parameter/local may shadow the import.
        if (local && checker.getSymbolAtLocation(node.expression) === local.importSymbol) { called.add(local.localName); sites.push({ file, start: node.getStart(source), end: node.getEnd(), localName: local.localName, status: 'DIRECT_CALL' }); }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const local of imports.values()) if (!called.has(local.localName)) sites.push({ file, start: local.importStart, end: local.importStart, localName: local.localName, status: 'UNUSED_DIRECT_IMPORT' });
  }
  const excludedFiles = input.files.map(file => slash(file.path)).filter(file => /\.tsx?$/.test(file) && !selected.has(file)).sort().map(file => ({ file, reason: 'Outside explicitly sealed selected project file list' }));
  const unresolved = sites.some(site => site.status === 'UNRESOLVED_REFERENCE_FORM') || unresolvedImports.length > 0 || !target;
  return { schemaVersion: 'SAJIMORA_TS_DIRECT_CONSUMER_INVENTORY_V1', scope: { targetFile: input.targetFile, targetSymbol: input.targetSymbol, selectedProjectFiles: [...selected].sort() }, visitedFiles, excludedFiles, consumerSites: sites.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start), unresolvedImports: unresolvedImports.sort((a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier)), completeness: unresolved ? 'INCOMPLETE' : 'COMPLETE_FOR_DIRECT_NAMED_CALLS', boundary: input.allowRenamedNamedImports ? 'Direct and renamed static named ESM imports from the provider module, whose TypeScript checker binding resolves exactly to the exported top-level provider function, followed by direct identifier calls with the same binding, are complete. Defaults, namespaces, barrels, packages, callbacks, methods, and behavioral claims are recorded but outside this certified scope.' : 'Only direct static named ESM imports from the provider module, whose TypeScript checker binding resolves exactly to the exported top-level provider function, followed by direct identifier calls with the same binding, are complete. Aliases, defaults, namespaces, barrels, packages, callbacks, methods, and behavioral claims are recorded but outside this certified scope.' };
}
