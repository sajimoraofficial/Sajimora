/**
 * @file CoverageVerifier.ts
 * Independently verifies CoverageCertificate in EXACT mode.
 * Enforces zero-trust:
 * - Rejects non-EXACT mode fail-closed (UNSUPPORTED_COVERAGE_MODE)
 * - Verifies totality: every context in parent AST must have a disposition (MISSING_EVIDENCE)
 * - Verifies uniqueness: no duplicate dispositions for the same anchor (INVALID_SCHEMA)
 * - Verifies truthfulness: target-bound contexts must be COVERED (MISSING_OBLIGATION)
 * - Verifies empty/non-empty domain witness consistency (MISSING_EVIDENCE)
 * - Verifies hashes and environment references (HASH_MISMATCH)
 */

import ts from 'typescript';
import {
  Anchor,
  BlockerCode,
  BlockerDetail
} from '../../../../../core/src/sajimora/certified/blockers';
import {
  CoverageCertificate,
  EnvironmentManifest,
  SemanticObligation,
  Vertex
} from '../../../../../core/src/sajimora/certified/contracts';
import {
  ArtifactDomain,
  SAJIMORA_CERTIFIED_EVIDENCE_V1
} from '../../../../../core/src/sajimora/certified/protocol';
import {
  hashContract
} from '../../../../../core/src/sajimora/certified/canonicalEncoding';
import { SealedFilesystem } from '../environment/SealedFilesystem';
import { F0BindingVerifier } from '../fragment/F0BindingVerifier';
import { VerificationBudget } from '../proof/VerificationBudget';
import { F0RestrictedResolver } from '../closure/F0RestrictedResolver';

export interface CoverageVerificationResult {
  valid: boolean;
  blockerCode?: BlockerCode;
  detail?: BlockerDetail;
  actualOccurrencesCount?: number;
  isEmptyDomain?: boolean;
}

export class CoverageVerifier {
  /**
   * Independently verifies the CoverageCertificate against sealed ASTs.
   */
  public static verify(
    parentManifest: EnvironmentManifest,
    candidateManifest: EnvironmentManifest,
    parentSealedFs: SealedFilesystem,
    targetSymbolId: string,
    obligations: SemanticObligation[],
    certificate: CoverageCertificate,
    budget: VerificationBudget
  ): CoverageVerificationResult {
    budget.checkCancellation();
    budget.allocate('WORK_UNITS', 20);

    // 1. Schema version
    if (certificate.schemaVersion !== SAJIMORA_CERTIFIED_EVIDENCE_V1) {
      return {
        valid: false,
        blockerCode: BlockerCode.INVALID_SCHEMA,
        detail: {
          code: BlockerCode.INVALID_SCHEMA,
          message: `CoverageCertificate has invalid schemaVersion '${certificate.schemaVersion}'`
        }
      };
    }

    // 2. Strict EXACT mode enforcement
    if (certificate.mode !== 'EXACT') {
      return {
        valid: false,
        blockerCode: BlockerCode.UNSUPPORTED_COVERAGE_MODE,
        detail: {
          code: BlockerCode.UNSUPPORTED_COVERAGE_MODE,
          message: `Coverage mode '${'mode' in certificate ? String((certificate as { mode?: unknown }).mode) : 'undefined'}' is unsupported in F0 (only mode: 'EXACT' is admitted)`
        }
      };
    }

    // 3. Environment ref hash checks
    const expectedParentDigest = hashContract(
      ArtifactDomain.MANIFEST,
      parentManifest.schemaVersion,
      parentManifest
    );
    const expectedCandidateDigest = hashContract(
      ArtifactDomain.MANIFEST,
      candidateManifest.schemaVersion,
      candidateManifest
    );

    if (certificate.parentEnvironmentRef.digest !== expectedParentDigest) {
      return {
        valid: false,
        blockerCode: BlockerCode.HASH_MISMATCH,
        detail: {
          code: BlockerCode.HASH_MISMATCH,
          message: 'CoverageCertificate parentEnvironmentRef digest mismatch'
        }
      };
    }

    if (certificate.candidateEnvironmentRef.digest !== expectedCandidateDigest) {
      return {
        valid: false,
        blockerCode: BlockerCode.HASH_MISMATCH,
        detail: {
          code: BlockerCode.HASH_MISMATCH,
          message: 'CoverageCertificate candidateEnvironmentRef digest mismatch'
        }
      };
    }

    // Index proposed ledger by anchor key
    const ledgerMap = new Map<string, any>();
    const seenAnchors = new Set<string>();

    for (const entry of certificate.contextDispositionLedger) {
      const anchor: Anchor = entry.contextAnchor;
      const key = `${anchor.fileId}:${anchor.utf16Start}:${anchor.utf16End}:${anchor.syntaxKind}`;

      if (seenAnchors.has(key)) {
        return {
          valid: false,
          blockerCode: BlockerCode.INVALID_SCHEMA,
          detail: {
            code: BlockerCode.INVALID_SCHEMA,
            message: `Duplicate disposition for context anchor ${key} in coverage ledger`
          }
        };
      }
      seenAnchors.add(key);
      ledgerMap.set(key, entry);
    }

    // Index proposed obligations by digest
    const oblDigestSet = new Set<string>();
    for (const obl of obligations) {
      const digest = hashContract(ArtifactDomain.OBLIGATION, obl.schemaVersion, obl);
      oblDigestSet.add(digest);
    }

    // 4. Independently scan all parent files and identify all semantic contexts
    let actualOccurrencesCount = 0;
    const moduleBindings = new Map<string, any>();
    for (const file of parentManifest.namespace.files) {
      if (file.kind !== 'SOURCE' && file.kind !== 'DECLARATION') continue;
      const sf = ts.createSourceFile(file.logicalPath, parentSealedFs.readBytes(file.logicalPath).toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const extracted = F0BindingVerifier.extractModuleBindings({ projectId: 'p0', fileId: file.logicalPath }, sf);
      if (extracted.result.valid && extracted.bindings) moduleBindings.set(file.logicalPath, extracted.bindings);
    }
    const resolver = new F0RestrictedResolver(parentSealedFs);
    const resolveModule = (fromFileId: string, specifier: string): string | null => {
      const result = resolver.resolve(specifier, fromFileId);
      return result.outcome === 'RESOLVED' ? result.selectedTargetOrNull : null;
    };

    for (const file of parentManifest.namespace.files) {
      if (file.kind !== 'SOURCE' && file.kind !== 'DECLARATION') continue;
      const bytes = parentSealedFs.readBytes(file.logicalPath);
      const sf = ts.createSourceFile(
        file.logicalPath,
        bytes.toString('utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );

      const vertex: Vertex = { projectId: 'p0', fileId: file.logicalPath };
      const { bindings, result } = F0BindingVerifier.extractModuleBindings(vertex, sf);
      if (!result.valid || !bindings) continue;

      let localTargetName: string | null = null;
      if (bindings.symbols.has(targetSymbolId)) {
        localTargetName = targetSymbolId;
      } else {
        for (const [locName, imp] of bindings.imports.entries()) {
          if (imp.sourceExportName === targetSymbolId) {
            localTargetName = locName;
            break;
          }
          if (imp.sourceExportName === 'default') {
            const resolved = resolver.resolve(imp.moduleSpecifier, file.logicalPath);
            if (resolved.outcome === 'RESOLVED' && resolved.selectedTargetOrNull && parentSealedFs.exists(resolved.selectedTargetOrNull)) {
              const provider = F0BindingVerifier.extractModuleBindings({ projectId: vertex.projectId, fileId: resolved.selectedTargetOrNull },
                ts.createSourceFile(resolved.selectedTargetOrNull, parentSealedFs.readBytes(resolved.selectedTargetOrNull).toString('utf8'), ts.ScriptTarget.Latest, true));
              if (provider.result.valid && provider.bindings?.exportedSymbols.get('default')?.name === targetSymbolId) {
                localTargetName = locName;
                break;
              }
            }
          }
        }
      }
      const namespaceTargetLocals = F0BindingVerifier.namespaceLocalsForTarget(
        moduleBindings,
        file.logicalPath,
        targetSymbolId,
        resolveModule
      );

      const visit = (node: ts.Node) => {
        let isContext = false;
        let isTargetBound = false;

        if (ts.isCallExpression(node)) {
          isContext = true;
          if (localTargetName && ts.isIdentifier(node.expression) && node.expression.text === localTargetName) {
            isTargetBound = true;
          }
          if (ts.isPropertyAccessExpression(node.expression) &&
              ts.isIdentifier(node.expression.expression) &&
              namespaceTargetLocals.includes(node.expression.expression.text) &&
              node.expression.name.text === targetSymbolId) {
            isTargetBound = true;
          }
        } else if (ts.isVariableDeclaration(node) && node.initializer) {
          if (node.type && ts.isTypeReferenceNode(node.type)) {
            isContext = true;
            if (localTargetName && node.type.typeName.getText(sf) === localTargetName) {
              isTargetBound = true;
            }
          }
        } else if (ts.isPropertyAccessExpression(node)) {
          isContext = true;
          if (localTargetName && ts.isIdentifier(node.expression) && node.expression.text === localTargetName) {
            isTargetBound = true;
          }
        }

        if (isContext) {
          const anchor: Anchor = {
            projectId: vertex.projectId,
            fileId: vertex.fileId,
            utf16Start: node.getStart(sf),
            utf16End: node.getEnd(),
            syntaxKind: node.kind
          };
          const key = `${anchor.fileId}:${anchor.utf16Start}:${anchor.utf16End}:${anchor.syntaxKind}`;

          // Check presence in proposed ledger
          const ledgerEntry = ledgerMap.get(key);
          if (!ledgerEntry) {
            throw {
              blockerCode: BlockerCode.MISSING_EVIDENCE,
              detail: {
                code: BlockerCode.MISSING_EVIDENCE,
                message: `Context at ${key} was omitted from contextDispositionLedger`
              }
            };
          }

          if (isTargetBound) {
            actualOccurrencesCount++;
            if (ledgerEntry.disposition !== 'COVERED') {
              throw {
                blockerCode: BlockerCode.MISSING_OBLIGATION,
                detail: {
                  code: BlockerCode.MISSING_OBLIGATION,
                  message: `Target-bound occurrence at ${key} was improperly classified as '${ledgerEntry.disposition}' instead of 'COVERED'`
                }
              };
            }
            if (!ledgerEntry.obligationRefOrNull || !oblDigestSet.has(ledgerEntry.obligationRefOrNull.digest)) {
              throw {
                blockerCode: BlockerCode.MISSING_OBLIGATION,
                detail: {
                  code: BlockerCode.MISSING_OBLIGATION,
                  message: `Target-bound occurrence at ${key} references missing or invalid SemanticObligation`
                }
              };
            }
          } else {
            if (ledgerEntry.disposition === 'COVERED') {
              throw {
                blockerCode: BlockerCode.INVALID_RULE_APPLICATION,
                detail: {
                  code: BlockerCode.INVALID_RULE_APPLICATION,
                  message: `Unrelated occurrence at ${key} was improperly classified as 'COVERED'`
                }
              };
            }
          }
        }

        ts.forEachChild(node, visit);
      };

      try {
        visit(sf);
      } catch (err: any) {
        if (err.blockerCode) {
          return {
            valid: false,
            blockerCode: err.blockerCode,
            detail: err.detail
          };
        }
        throw err;
      }
    }

    // 5. Check witness consistency for empty versus non-empty domains
    if (actualOccurrencesCount > 0) {
      if (!certificate.nonemptyActualWitnessRefOrNull) {
        return {
          valid: false,
          blockerCode: BlockerCode.MISSING_EVIDENCE,
          detail: {
            code: BlockerCode.MISSING_EVIDENCE,
            message: `Domain has ${actualOccurrencesCount} actual occurrences but nonemptyActualWitnessRefOrNull is null`
          }
        };
      }
    } else {
      if (certificate.nonemptyActualWitnessRefOrNull !== null) {
        return {
          valid: false,
          blockerCode: BlockerCode.MISSING_EVIDENCE,
          detail: {
            code: BlockerCode.MISSING_EVIDENCE,
            message: 'Domain is empty but nonemptyActualWitnessRefOrNull was provided'
          }
        };
      }
    }

    return {
      valid: true,
      actualOccurrencesCount,
      isEmptyDomain: actualOccurrencesCount === 0
    };
  }
}
