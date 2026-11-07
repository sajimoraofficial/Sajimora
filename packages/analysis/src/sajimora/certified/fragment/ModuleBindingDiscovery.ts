import ts from 'typescript';
import type { Vertex } from '../../../../../core/src/sajimora/certified/contracts';
import type { Anchor } from '../../../../../core/src/sajimora/certified/blockers';

export interface DiscoveredImport {
  moduleSpecifier: string;
  declaration: ts.ImportDeclaration;
  namedBindings?: ts.NamedImports | ts.NamespaceImport;
  defaultBinding?: string;
}

export interface DiscoveredDeclaration {
  vertex: Vertex;
  name: string;
  kind: 'FUNCTION' | 'CONST' | 'TYPE_ALIAS' | 'INTERFACE';
  exported: boolean;
  anchor: Anchor;
  node: ts.Node;
}

export function discoverStaticImports(sourceFile: ts.SourceFile): DiscoveredImport[] {
  const imports: DiscoveredImport[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    imports.push({
      moduleSpecifier: statement.moduleSpecifier.text,
      declaration: statement,
      namedBindings: statement.importClause?.namedBindings,
      defaultBinding: statement.importClause?.name?.text
    });
  }
  return imports;
}

export function discoverTopLevelDeclarations(vertex: Vertex, sourceFile: ts.SourceFile): DiscoveredDeclaration[] {
  const result: DiscoveredDeclaration[] = [];
  const anchor = (node: ts.Node): Anchor => ({ projectId: vertex.projectId, fileId: vertex.fileId, utf16Start: node.getStart(sourceFile), utf16End: node.getEnd(), syntaxKind: node.kind });
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (ts.isFunctionDeclaration(statement) && statement.name) result.push({ vertex, name: statement.name.text, kind: 'FUNCTION', exported, anchor: anchor(statement), node: statement });
    else if (ts.isInterfaceDeclaration(statement)) result.push({ vertex, name: statement.name.text, kind: 'INTERFACE', exported, anchor: anchor(statement), node: statement });
    else if (ts.isTypeAliasDeclaration(statement)) result.push({ vertex, name: statement.name.text, kind: 'TYPE_ALIAS', exported, anchor: anchor(statement), node: statement });
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) {
          result.push({ vertex, name: declaration.name.text, kind: 'CONST', exported, anchor: anchor(declaration), node: declaration });
        }
      }
    }
  }
  return result;
}

export function discoverUniqueExportedFunction(vertex: Vertex, sourceFile: ts.SourceFile, targetName: string): DiscoveredDeclaration | undefined {
  const matches = discoverTopLevelDeclarations(vertex, sourceFile)
    .filter(declaration => declaration.kind === 'FUNCTION' && declaration.exported && declaration.name === targetName);
  return matches.length === 1 ? matches[0] : undefined;
}
