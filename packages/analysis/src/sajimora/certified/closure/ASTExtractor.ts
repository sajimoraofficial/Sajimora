import ts from 'typescript';
import { Vertex } from '../../../../../core/src/sajimora/certified/contracts';
import { Anchor } from '../../../../../core/src/sajimora/certified/blockers';
import { ArtifactDomain, SAJIMORA_CERTIFIED_EVIDENCE_V1 } from '../../../../../core/src/sajimora/certified/protocol';
import { hashContract } from '../../../../../core/src/sajimora/certified/canonicalEncoding';

// Opaque syntactic identifiers preserving exact frozen symbolic syntax categories
export type SymbolicSyntaxKind =
  | 'IMPORT_DECLARATION'
  | 'EXPORT_DECLARATION'
  | 'IMPORT_EQUALS_DECLARATION'
  | 'TRIPLE_SLASH_PATH'
  | 'TRIPLE_SLASH_TYPES'
  | 'TRIPLE_SLASH_LIB'
  | 'DYNAMIC_IMPORT'
  | 'REQUIRE_CALL'
  | 'UNSUPPORTED_SYNTAX';

export interface ExtractedAnchor extends Omit<Anchor, 'syntaxKind'> {
  syntaxKind: SymbolicSyntaxKind;
  specifier: string;
}

export class ASTAnchorExtractor {
  /**
   * Generates the canonical protocol identity for an anchor.
   */
  public canonicalAnchorId(anchor: ExtractedAnchor | Anchor): string {
    return `${anchor.fileId}:${anchor.utf16Start}:${anchor.utf16End}:${anchor.syntaxKind}`;
  }

  /**
   * Extracts anchors from the raw source bytes by performing real TypeScript AST parsing
   * using the pinned F0 parser configuration (TS 5.9.3 Strict).
   * Exhaustively parses imports, exports, triple-slash references, and captures unsupported syntax.
   */
  public extractAnchors(vertex: Vertex, sourceBytes: Buffer): ExtractedAnchor[] {
    const sourceText = sourceBytes.toString('utf8');
    if (Buffer.compare(Buffer.from(sourceText, 'utf8'), sourceBytes) !== 0) {
      return [{
        projectId: vertex.projectId,
        fileId: vertex.fileId,
        utf16Start: 0,
        utf16End: 0,
        syntaxKind: 'UNSUPPORTED_SYNTAX',
        specifier: 'INVALID_UTF8'
      }];
    }

    let scriptKind = ts.ScriptKind.TS;
    if (vertex.fileId.endsWith('.tsx')) {
      scriptKind = ts.ScriptKind.TSX;
    } else if (vertex.fileId.endsWith('.d.ts') || vertex.fileId.endsWith('.ts')) {
      scriptKind = ts.ScriptKind.TS;
    } else if (vertex.fileId.endsWith('.js') || vertex.fileId.endsWith('.jsx')) {
      scriptKind = ts.ScriptKind.JS;
    }

    const sourceFile = ts.createSourceFile(
      vertex.fileId,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKind
    );

    const parseErrors = (sourceFile as { parseDiagnostics?: unknown }).parseDiagnostics;
    if (Array.isArray(parseErrors) && parseErrors.length > 0) {
      return [{
        projectId: vertex.projectId,
        fileId: vertex.fileId,
        utf16Start: 0,
        utf16End: sourceText.length,
        syntaxKind: 'UNSUPPORTED_SYNTAX',
        specifier: 'SYNTAX_ERROR'
      }];
    }

    const anchors: ExtractedAnchor[] = [];

    // Distinct triple-slash reference extraction
    if (sourceFile.referencedFiles && sourceFile.referencedFiles.length > 0) {
      for (const ref of sourceFile.referencedFiles) {
        anchors.push({
          projectId: vertex.projectId,
          fileId: vertex.fileId,
          utf16Start: ref.pos,
          utf16End: ref.end,
          syntaxKind: 'TRIPLE_SLASH_PATH',
          specifier: ref.fileName
        });
      }
    }

    if (sourceFile.typeReferenceDirectives && sourceFile.typeReferenceDirectives.length > 0) {
      for (const ref of sourceFile.typeReferenceDirectives) {
        anchors.push({
          projectId: vertex.projectId,
          fileId: vertex.fileId,
          utf16Start: ref.pos,
          utf16End: ref.end,
          syntaxKind: 'TRIPLE_SLASH_TYPES',
          specifier: ref.fileName
        });
      }
    }

    if (sourceFile.libReferenceDirectives && sourceFile.libReferenceDirectives.length > 0) {
      for (const ref of sourceFile.libReferenceDirectives) {
        anchors.push({
          projectId: vertex.projectId,
          fileId: vertex.fileId,
          utf16Start: ref.pos,
          utf16End: ref.end,
          syntaxKind: 'TRIPLE_SLASH_LIB',
          specifier: ref.fileName
        });
      }
    }

    // Exhaustive AST traversal
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        if (node.moduleSpecifier) {
          if (ts.isStringLiteral(node.moduleSpecifier)) {
            anchors.push({
              projectId: vertex.projectId,
              fileId: vertex.fileId,
              utf16Start: node.moduleSpecifier.getStart(sourceFile),
              utf16End: node.moduleSpecifier.getEnd(),
              syntaxKind: 'IMPORT_DECLARATION',
              specifier: node.moduleSpecifier.text
            });
          } else {
            anchors.push({
              projectId: vertex.projectId,
              fileId: vertex.fileId,
              utf16Start: node.moduleSpecifier.getStart(sourceFile),
              utf16End: node.moduleSpecifier.getEnd(),
              syntaxKind: 'UNSUPPORTED_SYNTAX',
              specifier: node.moduleSpecifier.getText(sourceFile)
            });
          }
        }
      } else if (ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) {
          if (ts.isStringLiteral(node.moduleSpecifier)) {
            anchors.push({
              projectId: vertex.projectId,
              fileId: vertex.fileId,
              utf16Start: node.moduleSpecifier.getStart(sourceFile),
              utf16End: node.moduleSpecifier.getEnd(),
              syntaxKind: 'EXPORT_DECLARATION',
              specifier: node.moduleSpecifier.text
            });
          } else {
            anchors.push({
              projectId: vertex.projectId,
              fileId: vertex.fileId,
              utf16Start: node.moduleSpecifier.getStart(sourceFile),
              utf16End: node.moduleSpecifier.getEnd(),
              syntaxKind: 'UNSUPPORTED_SYNTAX',
              specifier: node.moduleSpecifier.getText(sourceFile)
            });
          }
        }
      } else if (ts.isImportEqualsDeclaration(node)) {
        if (ts.isExternalModuleReference(node.moduleReference)) {
          const expr = node.moduleReference.expression;
          if (expr && ts.isStringLiteral(expr)) {
            anchors.push({
              projectId: vertex.projectId,
              fileId: vertex.fileId,
              utf16Start: expr.getStart(sourceFile),
              utf16End: expr.getEnd(),
              syntaxKind: 'IMPORT_EQUALS_DECLARATION',
              specifier: expr.text
            });
          } else {
            anchors.push({
              projectId: vertex.projectId,
              fileId: vertex.fileId,
              utf16Start: node.moduleReference.getStart(sourceFile),
              utf16End: node.moduleReference.getEnd(),
              syntaxKind: 'UNSUPPORTED_SYNTAX',
              specifier: node.moduleReference.getText(sourceFile)
            });
          }
        }
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = node.arguments[0];
          if (node.arguments.length === 1 && arg && ts.isStringLiteral(arg)) {
            anchors.push({
              projectId: vertex.projectId,
              fileId: vertex.fileId,
              utf16Start: node.getStart(sourceFile),
              utf16End: node.getEnd(),
              syntaxKind: 'DYNAMIC_IMPORT',
              specifier: arg.text
            });
          } else {
            anchors.push({
              projectId: vertex.projectId,
              fileId: vertex.fileId,
              utf16Start: node.getStart(sourceFile),
              utf16End: node.getEnd(),
              syntaxKind: 'UNSUPPORTED_SYNTAX',
              specifier: node.getText(sourceFile)
            });
          }
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          const arg = node.arguments[0];
          if (node.arguments.length === 1 && arg && ts.isStringLiteral(arg)) {
            anchors.push({
              projectId: vertex.projectId,
              fileId: vertex.fileId,
              utf16Start: node.getStart(sourceFile),
              utf16End: node.getEnd(),
              syntaxKind: 'REQUIRE_CALL',
              specifier: arg.text
            });
          } else {
            anchors.push({
              projectId: vertex.projectId,
              fileId: vertex.fileId,
              utf16Start: node.getStart(sourceFile),
              utf16End: node.getEnd(),
              syntaxKind: 'UNSUPPORTED_SYNTAX',
              specifier: node.getText(sourceFile)
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);

    anchors.sort((a, b) => {
      if (a.utf16Start !== b.utf16Start) return a.utf16Start - b.utf16Start;
      if (a.utf16End !== b.utf16End) return a.utf16End - b.utf16End;
      return a.syntaxKind < b.syntaxKind ? -1 : a.syntaxKind > b.syntaxKind ? 1 : 0;
    });

    return anchors;
  }

  public computeSyntaxDigest(vertex: Vertex, anchors: ExtractedAnchor[]): string {
    return hashContract(ArtifactDomain.COVERAGE, SAJIMORA_CERTIFIED_EVIDENCE_V1, {
      vertex: {
        projectId: vertex.projectId,
        fileId: vertex.fileId
      },
      anchors: anchors.map(a => ({
        projectId: a.projectId,
        fileId: a.fileId,
        utf16Start: a.utf16Start,
        utf16End: a.utf16End,
        syntaxKind: a.syntaxKind,
        specifier: a.specifier
      }))
    });
  }
}
