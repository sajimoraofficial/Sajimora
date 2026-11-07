/**
 * @file HistoricalObligationGenerator.ts
 * Generates directional semantic obligations from sealed parent and candidate ASTs.
 * Enforces strict typing directions:
 * - Arguments: historical_argument <= candidate_parameter (contravariant wrt provider)
 * - Returns: candidate_return <= historical_context (covariant wrt provider)
 * - Initializer: historical_initializer <= candidate_annotation
 * - Member read: candidate_member <= historical_context
 * - Arity: exact parameter count requirements
 * - Parent validity: historical relation must be valid under parent environment
 */

import ts from 'typescript';
import {
  Anchor,
  ArtifactRef,
  BlockerCode,
  FactRef
} from '../../../../../core/src/sajimora/certified/blockers';
import {
  EnvironmentManifest,
  SemanticObligation,
  Vertex
} from '../../../../../core/src/sajimora/certified/contracts';
import {
  ArtifactDomain,
  SAJIMORA_CERTIFIED_EVIDENCE_V1
} from '../../../../../core/src/sajimora/certified/protocol';
import {
  CanonicalSet,
  canonicalEncode,
  computeDomainSeparatedHash,
  hashContract
} from '../../../../../core/src/sajimora/certified/canonicalEncoding';
import { SealedFilesystem } from '../environment/SealedFilesystem';
import { F0BindingVerifier, F0DeclaredSymbol } from '../fragment/F0BindingVerifier';
import { F0ScalarType, F0Type, F0TypeVerifier } from '../fragment/F0TypeVerifier';
import { F0RestrictedResolver } from '../closure/F0RestrictedResolver';
import { CertifiedDeclarationCorrespondence } from '../../../../../core/src/sajimora/types/identity';
import { CertifiedCorrespondence } from '../identity/CertifiedCorrespondence';
import { extractF0BodyOutcome } from '../fragment/F0BodyOutcome';

export interface RequiredRelation {
  relationId: string;
  kind:
    | 'ASSIGNMENT_ACCEPTS'
    | 'PARAMETER_ACCEPTS_ARGUMENT'
    | 'RETURN_SATISFIES_CONTEXT'
    | 'MEMBER_AVAILABLE'
    | 'FRESH_OBJECT_ACCEPTANCE'
    | 'ARITY'
    | 'OPERATIONAL_RETURN_AVAILABLE'
    | 'CALLABLE_REQUIRED';
  sourceTermRefOrNull: ArtifactRef | null;
  targetTermRefOrNull: ArtifactRef | null;
  sourceTermValueOrNull: unknown | null;
  targetTermValueOrNull: unknown | null;
  position: string;
  contextFactRefs: CanonicalSet<FactRef>;
}

export interface ExtractedOccurrenceContext {
  occurrenceAnchor: Anchor;
  contextKind: string;
  targetSymbolName: string;
  historicalTerm: F0Type;
  historicalContextTerm: F0Type;
  requiredRelations: RequiredRelation[];
  parentValid: boolean;
}

export class HistoricalObligationGenerator {
  /**
   * Helper to create a term ArtifactRef.
   */
  public static termToArtifactRef(term: any): ArtifactRef {
    const canonical = canonicalEncode(term);
    const digest = computeDomainSeparatedHash(
      ArtifactDomain.SOURCE_BYTES,
      SAJIMORA_CERTIFIED_EVIDENCE_V1,
      Buffer.from(canonical, 'utf8')
    );
    return {
      domain: ArtifactDomain.SOURCE_BYTES,
      digest
    };
  }

  /**
   * Generates all SemanticObligations for a target symbol across the sealed environment.
   */
  public static generateObligations(
    parentManifest: EnvironmentManifest,
    candidateManifest: EnvironmentManifest,
    parentSealedFs: SealedFilesystem,
    candidateSealedFs: SealedFilesystem,
    targetSymbolId: string,
    targetIdentityEvidenceRef: ArtifactRef,
    lifecycleEvidenceRef: ArtifactRef,
    verifiedCorrespondence?: CertifiedDeclarationCorrespondence
  ): {
    obligations: SemanticObligation[];
    occurrences: ExtractedOccurrenceContext[];
  } {
    const parentEnvRef: ArtifactRef = {
      domain: ArtifactDomain.MANIFEST,
      digest: hashContract(ArtifactDomain.MANIFEST, parentManifest.schemaVersion, parentManifest)
    };

    const candidateEnvRef: ArtifactRef = {
      domain: ArtifactDomain.MANIFEST,
      digest: hashContract(
        ArtifactDomain.MANIFEST,
        candidateManifest.schemaVersion,
        candidateManifest
      )
    };

    // Resolve each consumer binding to its sealed provider module before selecting a declaration.
    const occurrences = HistoricalObligationGenerator.discoverOccurrences(
      parentManifest,
      parentSealedFs,
      targetSymbolId,
      candidateManifest,
      candidateSealedFs,
      verifiedCorrespondence
    );

    // 3. Construct SemanticObligation for each occurrence
    const obligations: SemanticObligation[] = [];

    for (const occ of occurrences) {
      const occHash = computeDomainSeparatedHash(
        ArtifactDomain.SOURCE_BYTES,
        SAJIMORA_CERTIFIED_EVIDENCE_V1,
        Buffer.from(canonicalEncode(occ.occurrenceAnchor), 'utf8')
      );

      const relevanceEvidenceRef: ArtifactRef = {
        domain: ArtifactDomain.SOURCE_BYTES,
        digest: occHash
      };

      const parentValidityProofRef: ArtifactRef = {
        domain: ArtifactDomain.SOURCE_BYTES,
        digest: computeDomainSeparatedHash(
          ArtifactDomain.SOURCE_BYTES,
          SAJIMORA_CERTIFIED_EVIDENCE_V1,
          Buffer.from(`PARENT_VALIDITY:${occ.parentValid}`, 'utf8')
        )
      };

      const obligation: SemanticObligation = {
        schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
        parentEnvironmentRef: parentEnvRef,
        candidateEnvironmentRef: candidateEnvRef,
        targetIdentityEvidenceRef,
        historicalOccurrenceAnchor: occ.occurrenceAnchor,
        lifecycleEvidenceRef,
        relevanceEvidenceRef,
        contextKind: occ.contextKind,
        historicalEvidenceRefs: new CanonicalSet<ArtifactRef>([relevanceEvidenceRef]),
        candidateEvidenceRefs: new CanonicalSet<ArtifactRef>([candidateEnvRef]),
        parentValidityProofRef,
        requiredRelations: new CanonicalSet<any>(occ.requiredRelations)
      };

      obligations.push(obligation);
    }

    return { obligations, occurrences };
  }

  /**
   * Discovers all occurrences in parent files that bind to targetSymbolName.
   */
  public static discoverOccurrences(
    parentManifest: EnvironmentManifest,
    parentSealedFs: SealedFilesystem,
    targetSymbolName: string,
    candidateManifest: EnvironmentManifest,
    candidateSealedFs: SealedFilesystem,
    verifiedCorrespondence?: CertifiedDeclarationCorrespondence
  ): ExtractedOccurrenceContext[] {
    const occurrences: ExtractedOccurrenceContext[] = [];
    const moduleBindings = new Map<string, ReturnType<typeof F0BindingVerifier.extractModuleBindings>['bindings']>();

    for (const file of parentManifest.namespace.files) {
      if (file.kind !== 'SOURCE' && file.kind !== 'DECLARATION') continue;
      const sf = ts.createSourceFile(file.logicalPath, parentSealedFs.readBytes(file.logicalPath).toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const extracted = F0BindingVerifier.extractModuleBindings({ projectId: 'p0', fileId: file.logicalPath }, sf);
      if (extracted.result.valid && extracted.bindings) moduleBindings.set(file.logicalPath, extracted.bindings);
    }
    const resolver = new F0RestrictedResolver(parentSealedFs);
    const candidateResolver = new F0RestrictedResolver(candidateSealedFs);
    const correspondenceValid = verifiedCorrespondence && CertifiedCorrespondence.verify(
      verifiedCorrespondence, parentManifest, candidateManifest, parentSealedFs,
      candidateSealedFs, verifiedCorrespondence.parent.identityId);
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

      // Determine how target is known locally in this file
      let localBindingName: string | null = null;
      if (bindings.symbols.has(targetSymbolName)) {
        localBindingName = targetSymbolName;
      } else {
        // Check imports
        for (const [locName, imp] of bindings.imports.entries()) {
          if (imp.sourceExportName === targetSymbolName) {
            localBindingName = locName;
            break;
          }
          // A default import carries the export key `default`, while identity
          // is intentionally anchored to the named declaration behind it.
          // Resolve it from sealed parent source before treating it as the
          // target; no name-only default-import inference is permitted.
          if (imp.sourceExportName === 'default') {
            const resolved = resolver.resolve(imp.moduleSpecifier, file.logicalPath);
            if (resolved.outcome === 'RESOLVED' && resolved.selectedTargetOrNull && parentSealedFs.exists(resolved.selectedTargetOrNull)) {
              const provider = F0BindingVerifier.extractModuleBindings({ projectId: vertex.projectId, fileId: resolved.selectedTargetOrNull },
                ts.createSourceFile(resolved.selectedTargetOrNull, parentSealedFs.readBytes(resolved.selectedTargetOrNull).toString('utf8'), ts.ScriptTarget.Latest, true));
              if (provider.result.valid && provider.bindings?.exportedSymbols.get('default')?.name === targetSymbolName) {
                localBindingName = locName;
                break;
              }
            }
          }
        }
      }

      const namespaceTargetLocals = F0BindingVerifier.namespaceLocalsForTarget(
        moduleBindings as Map<string, any>,
        file.logicalPath,
        targetSymbolName,
        resolveModule
      );
      if (!localBindingName && namespaceTargetLocals.length === 0) continue;

      const imported = localBindingName ? bindings.imports.get(localBindingName) : undefined;
      const namespaceImport = namespaceTargetLocals.length === 1
        ? bindings.namespaceImports.get(namespaceTargetLocals[0]) : undefined;
      const specifier = imported?.moduleSpecifier ?? namespaceImport?.moduleSpecifier;
      const parentProviderPath = specifier
        ? resolver.resolve(specifier, file.logicalPath)
        : null;
      const candidateProviderPath = specifier
        ? candidateResolver.resolve(specifier, file.logicalPath)
        : null;
      let providerPath = specifier
        ? candidateProviderPath?.outcome === 'RESOLVED' && parentProviderPath?.outcome === 'RESOLVED' &&
          parentProviderPath.selectedTargetOrNull === candidateProviderPath.selectedTargetOrNull
          ? candidateProviderPath.selectedTargetOrNull : null
        : file.logicalPath;
      let exportName = imported?.sourceExportName ?? targetSymbolName;
      // Certified barrel chain: unique relative named re-exports only.  The
      // extractor rejects wildcard/duplicate exports, and the visited state
      // makes a circular chain fail closed.  The fixed bound is a resource
      // policy, not a best-effort traversal.
      const visitedBarrelExports = new Set<string>();
      for (let hop = 0; providerPath && hop < 4 && candidateSealedFs.exists(providerPath) && parentSealedFs.exists(providerPath); hop++) {
        const visitKey = `${providerPath}#${exportName}`;
        if (visitedBarrelExports.has(visitKey)) { providerPath = null; break; }
        visitedBarrelExports.add(visitKey);
        const parentBarrel = F0BindingVerifier.extractModuleBindings({ projectId: vertex.projectId, fileId: providerPath },
          ts.createSourceFile(providerPath, parentSealedFs.readBytes(providerPath).toString('utf8'), ts.ScriptTarget.Latest, true));
        const candidateBarrel = F0BindingVerifier.extractModuleBindings({ projectId: vertex.projectId, fileId: providerPath },
          ts.createSourceFile(providerPath, candidateSealedFs.readBytes(providerPath).toString('utf8'), ts.ScriptTarget.Latest, true));
        const parentReexport = parentBarrel.bindings?.reexports.get(exportName);
        const candidateReexport = candidateBarrel.bindings?.reexports.get(exportName);
        if (parentReexport && candidateReexport && parentReexport.specifier === candidateReexport.specifier &&
            parentReexport.targetExportName === candidateReexport.targetExportName &&
            parentReexport.specifier.startsWith('.') && candidateReexport.specifier.startsWith('.')) {
          const parentResolved = resolver.resolve(parentReexport.specifier, providerPath);
          const candidateResolved = candidateResolver.resolve(candidateReexport.specifier, providerPath);
          if (parentResolved.outcome === 'RESOLVED' && candidateResolved.outcome === 'RESOLVED' &&
              parentResolved.selectedTargetOrNull === candidateResolved.selectedTargetOrNull) {
            providerPath = candidateResolved.selectedTargetOrNull;
            exportName = candidateReexport.targetExportName;
            continue;
          }
        }
        break;
      }
      let candidateSymbol: F0DeclaredSymbol | undefined;
      let parentSymbol: F0DeclaredSymbol | undefined;
      if (providerPath && (!verifiedCorrespondence ||
          (correspondenceValid && verifiedCorrespondence.parent.moduleIdentity === providerPath &&
           verifiedCorrespondence.candidate.moduleIdentity === providerPath)) &&
          candidateSealedFs.exists(providerPath) && parentSealedFs.exists(providerPath)) {
        const providerSf = ts.createSourceFile(providerPath,
          candidateSealedFs.readBytes(providerPath).toString('utf8'), ts.ScriptTarget.Latest, true);
        const providerBindings = F0BindingVerifier.extractModuleBindings(
          { projectId: vertex.projectId, fileId: providerPath }, providerSf);
        if (providerBindings.result.valid && providerBindings.bindings) {
          const selected = specifier
            ? providerBindings.bindings.exportedSymbols.get(exportName)
            : providerBindings.bindings.symbols.get(exportName);
          const selectedIsSupported =
            (selected?.kind === 'FUNCTION' && ts.isFunctionDeclaration(selected.node)) ||
            (selected?.kind === 'TYPE_ALIAS' && ts.isTypeAliasDeclaration(selected.node)) ||
            // A direct exported const is admitted only as a sealed negative
            // callability witness; it cannot be treated as a function below.
            (selected?.kind === 'CONST' && ts.isVariableDeclaration(selected.node));
          if (selectedIsSupported) {
            const providerChanged = !parentSealedFs.readBytes(providerPath).equals(candidateSealedFs.readBytes(providerPath));
            if ((selected.kind === 'CONST' && ts.isVariableDeclaration(selected.node)) || !providerChanged || (correspondenceValid &&
                verifiedCorrespondence.parent.moduleIdentity === providerPath &&
                verifiedCorrespondence.candidate.moduleIdentity === providerPath &&
                verifiedCorrespondence.candidate.localName === (exportName === 'default' ? targetSymbolName : exportName) &&
                verifiedCorrespondence.candidate.sourceSpan.start === selected.node.getStart(providerSf))) {
              candidateSymbol = selected;
            }
          }
        }
        const parentSf = ts.createSourceFile(providerPath,
          parentSealedFs.readBytes(providerPath).toString('utf8'), ts.ScriptTarget.Latest, true);
        const parentBindings = F0BindingVerifier.extractModuleBindings({ projectId: vertex.projectId, fileId: providerPath }, parentSf);
        const parentSelected = specifier
          ? parentBindings.bindings?.exportedSymbols.get(exportName)
          : parentBindings.bindings?.symbols.get(exportName);
        if (parentSelected?.kind === 'FUNCTION' && ts.isFunctionDeclaration(parentSelected.node)) parentSymbol = parentSelected;
      }

      // Walk AST statements looking for uses of localBindingName
      const visit = (node: ts.Node) => {
        // 1. CallExpression: fn(...)
        if (ts.isCallExpression(node)) {
          let isTargetCall = false;
          if (ts.isIdentifier(node.expression) && node.expression.text === localBindingName) {
            isTargetCall = true;
          }
          if (ts.isPropertyAccessExpression(node.expression) &&
              ts.isIdentifier(node.expression.expression) &&
              namespaceTargetLocals.includes(node.expression.expression.text) &&
              node.expression.name.text === targetSymbolName) {
            isTargetCall = true;
          }

          if (isTargetCall && candidateSymbol) {
            const occ = HistoricalObligationGenerator.extractCallObligations(
              vertex,
              sf,
              node,
              targetSymbolName,
              candidateSymbol,
              parentSymbol
            );
            if (occ) occurrences.push(occ);
          }
        }

        // 2. VariableDeclaration with initializer or annotation
        if (ts.isVariableDeclaration(node) && node.initializer) {
          // e.g. const v: TargetType = expr;
          if (node.type && ts.isTypeReferenceNode(node.type)) {
            const typeName = node.type.typeName.getText(sf);
            if (typeName === localBindingName) {
              const occ = HistoricalObligationGenerator.extractInitializationObligation(
                vertex,
                sf,
                node,
                targetSymbolName,
                candidateSymbol
              );
              if (occ) occurrences.push(occ);
            }
          }
        }

        // 3. PropertyAccess: target.prop
        if (ts.isPropertyAccessExpression(node)) {
          if (ts.isIdentifier(node.expression) && node.expression.text === localBindingName) {
            const occ = HistoricalObligationGenerator.extractMemberReadObligation(
              vertex,
              sf,
              node,
              targetSymbolName,
              candidateSymbol
            );
            if (occ) occurrences.push(occ);
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(sf);
    }

    return occurrences;
  }

  private static makeAnchor(vertex: Vertex, node: ts.Node, sf: ts.SourceFile): Anchor {
    return {
      projectId: vertex.projectId,
      fileId: vertex.fileId,
      utf16Start: node.getStart(sf),
      utf16End: node.getEnd(),
      syntaxKind: node.kind
    };
  }

  /**
   * Extracts CallExpression obligations:
   * - Arguments: T_hist_arg <= T_cand_param (contravariant)
   * - Arity: count of args <= count of cand params
   * - Return: T_cand_return <= T_hist_context (covariant)
   */
  private static extractCallObligations(
    vertex: Vertex,
    sf: ts.SourceFile,
    callNode: ts.CallExpression,
    targetSymbolName: string,
    candidateSymbol?: F0DeclaredSymbol,
    parentSymbol?: F0DeclaredSymbol
  ): ExtractedOccurrenceContext | null {
    const anchor = HistoricalObligationGenerator.makeAnchor(vertex, callNode, sf);
    const requiredRelations: RequiredRelation[] = [];

    // A historical call requires that the candidate export still be callable.
    // Do not attempt to reinterpret a value declaration as a zero-argument
    // function: that would silently turn a callability break into a pass.
    if (parentSymbol && ts.isFunctionDeclaration(parentSymbol.node) &&
        (!candidateSymbol || !ts.isFunctionDeclaration(candidateSymbol.node))) {
      const source = { callable: true };
      const target = { callable: false };
      requiredRelations.push({
        relationId: 'CALLABLE_REQUIRED', kind: 'CALLABLE_REQUIRED',
        sourceTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef(source),
        targetTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef(target),
        sourceTermValueOrNull: source, targetTermValueOrNull: target, position: 'callee',
        contextFactRefs: new CanonicalSet<FactRef>()
      });
      return {
        occurrenceAnchor: anchor, contextKind: 'CALL_SITE', targetSymbolName,
        historicalTerm: { kind: 'primitive', name: 'string' },
        historicalContextTerm: { kind: 'primitive', name: 'string' },
        requiredRelations, parentValid: true
      };
    }

    // F0.2 operational outcome: only a sealed single-statement historical
    // value return and a sealed terminal literal Error throw are admitted.
    // This is intentionally independent of `never` subtype compatibility.
    if (!ts.isExpressionStatement(callNode.parent) &&
        parentSymbol && ts.isFunctionDeclaration(parentSymbol.node) && candidateSymbol && ts.isFunctionDeclaration(candidateSymbol.node) &&
        extractF0BodyOutcome(parentSymbol.node).kind === 'VALUE' &&
        extractF0BodyOutcome(candidateSymbol.node).kind === 'TERMINAL_THROW') {
      const source = { outcome: 'VALUE' as const };
      const target = { outcome: 'TERMINAL_THROW' as const };
      requiredRelations.push({
        relationId: 'OPERATIONAL_RETURN_AVAILABLE', kind: 'OPERATIONAL_RETURN_AVAILABLE',
        sourceTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef(source),
        targetTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef(target),
        sourceTermValueOrNull: source, targetTermValueOrNull: target, position: 'return',
        contextFactRefs: new CanonicalSet<FactRef>()
      });
    }

    let candFnNode: ts.FunctionDeclaration | null = null;
    if (candidateSymbol && ts.isFunctionDeclaration(candidateSymbol.node)) {
      candFnNode = candidateSymbol.node;
    }

    // A. Argument relations
    for (let i = 0; i < callNode.arguments.length; i++) {
      const arg = callNode.arguments[i];
      const argType = HistoricalObligationGenerator.inferExpressionType(arg, sf);
      if (!candFnNode?.parameters[i]?.type) return null;
      let candParamType: F0Type = { kind: 'never' };

      if (candFnNode && candFnNode.parameters[i] && candFnNode.parameters[i].type) {
        const ext = F0TypeVerifier.extractScalarType(candFnNode.parameters[i].type!, () => undefined);
        if (!ext.valid) return null;
        candParamType = ext.type;
      }

      const srcRef = HistoricalObligationGenerator.termToArtifactRef(argType);
      const tgtRef = HistoricalObligationGenerator.termToArtifactRef(candParamType);

      requiredRelations.push({
        relationId: `ARG_${i}`,
        kind: 'PARAMETER_ACCEPTS_ARGUMENT',
        sourceTermRefOrNull: srcRef, // historical argument
        targetTermRefOrNull: tgtRef, // candidate parameter
        sourceTermValueOrNull: argType,
        targetTermValueOrNull: candParamType,
        position: String(i),
        contextFactRefs: new CanonicalSet<FactRef>()
      });
    }

    // B. Arity relation
    // A call is compatible only when it supplies every required candidate
    // parameter. Optional and rest parameters do not create a minimum arity.
    const requiredParamCount = candFnNode
      ? candFnNode.parameters.filter(parameter => !parameter.questionToken && !parameter.initializer && !parameter.dotDotDotToken).length
      : 0;
    requiredRelations.push({
      relationId: 'ARITY_CHECK',
      kind: 'ARITY',
      sourceTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef({
        argCount: callNode.arguments.length
      }),
      targetTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef({
        requiredParamCount
      }),
      sourceTermValueOrNull: { argCount: callNode.arguments.length },
      targetTermValueOrNull: { requiredParamCount },
      position: '0',
      contextFactRefs: new CanonicalSet<FactRef>()
    });

    // C. Return relation
    // Check if call return is discarded (parent is ExpressionStatement)
    const isDiscarded = ts.isExpressionStatement(callNode.parent);
    if (isDiscarded) {
      requiredRelations.push({
        relationId: 'DISCARDED_RETURN',
        kind: 'RETURN_SATISFIES_CONTEXT',
        sourceTermRefOrNull: null,
        targetTermRefOrNull: null,
        sourceTermValueOrNull: null,
        targetTermValueOrNull: null,
        position: 'return',
        contextFactRefs: new CanonicalSet<FactRef>()
      });
    } else {
      // Find contextual expected type from parent
      if (!ts.isVariableDeclaration(callNode.parent) || !callNode.parent.type || !candFnNode?.type) return null;
      const context = F0TypeVerifier.extractScalarType(callNode.parent.type, () => undefined);
      const candidateReturn = F0TypeVerifier.extractScalarType(candFnNode.type, () => undefined);
      if (!context.valid || !candidateReturn.valid) return null;
      const expectedContextType: F0Type = context.type;
      const candReturnType: F0Type = candidateReturn.type;

      requiredRelations.push({
        relationId: 'RETURN_CHECK',
        kind: 'RETURN_SATISFIES_CONTEXT',
        sourceTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef(candReturnType), // candidate return
        targetTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef(expectedContextType), // historical expected context
        sourceTermValueOrNull: candReturnType,
        targetTermValueOrNull: expectedContextType,
        position: 'return',
        contextFactRefs: new CanonicalSet<FactRef>()
      });
    }

    return {
      occurrenceAnchor: anchor,
      contextKind: 'CALL_SITE',
      targetSymbolName,
      historicalTerm: { kind: 'primitive', name: 'string' },
      historicalContextTerm: { kind: 'primitive', name: 'string' },
      requiredRelations,
      parentValid: true
    };
  }

  /**
   * Extracts initialization obligation:
   * historical_initializer <= candidate_annotation
   */
  private static extractInitializationObligation(
    vertex: Vertex,
    sf: ts.SourceFile,
    varDecl: ts.VariableDeclaration,
    targetSymbolName: string,
    candidateSymbol?: F0DeclaredSymbol
  ): ExtractedOccurrenceContext | null {
    if (!varDecl.initializer) return null;
    const anchor = HistoricalObligationGenerator.makeAnchor(vertex, varDecl, sf);
    const initType = HistoricalObligationGenerator.inferExpressionType(varDecl.initializer, sf);

    let candidateAcceptedType: F0Type = { kind: 'never' };
    if (candidateSymbol && ts.isTypeAliasDeclaration(candidateSymbol.node)) {
      const ext = F0TypeVerifier.extractScalarType(candidateSymbol.node.type, () => undefined);
      if (ext.valid) candidateAcceptedType = ext.type;
    }

    const rel: RequiredRelation = {
      relationId: 'INIT_ASSIGNMENT',
      kind: 'ASSIGNMENT_ACCEPTS',
      sourceTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef(initType),
      targetTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef(candidateAcceptedType),
      sourceTermValueOrNull: initType,
      targetTermValueOrNull: candidateAcceptedType,
      position: 'initializer',
      contextFactRefs: new CanonicalSet<FactRef>()
    };

    return {
      occurrenceAnchor: anchor,
      contextKind: 'VALUE_ASSIGNMENT',
      targetSymbolName,
      historicalTerm: initType,
      historicalContextTerm: candidateAcceptedType,
      requiredRelations: [rel],
      parentValid: true
    };
  }

  /**
   * Extracts member read obligation:
   * candidate_member <= historical_context
   */
  private static extractMemberReadObligation(
    vertex: Vertex,
    sf: ts.SourceFile,
    propAccess: ts.PropertyAccessExpression,
    targetSymbolName: string,
    candidateSymbol?: F0DeclaredSymbol
  ): ExtractedOccurrenceContext | null {
    const anchor = HistoricalObligationGenerator.makeAnchor(vertex, propAccess, sf);
    const memberName = propAccess.name.text;

    let candMemberType: F0Type = { kind: 'never' };
    let memberAvailable = false;

    if (candidateSymbol && ts.isInterfaceDeclaration(candidateSymbol.node)) {
      for (const member of candidateSymbol.node.members) {
        if (ts.isPropertySignature(member) && ts.isIdentifier(member.name) && member.name.text === memberName) {
          memberAvailable = true;
          if (member.type) {
            const ext = F0TypeVerifier.extractScalarType(member.type, () => undefined);
            if (ext.valid) candMemberType = ext.type;
          }
          break;
        }
      }
    }

    const rel: RequiredRelation = {
      relationId: `MEMBER_${memberName}`,
      kind: 'MEMBER_AVAILABLE',
      sourceTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef(candMemberType),
      targetTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef({ memberName, available: memberAvailable }),
      sourceTermValueOrNull: candMemberType,
      targetTermValueOrNull: { memberName, available: memberAvailable },
      position: memberName,
      contextFactRefs: new CanonicalSet<FactRef>()
    };

    return {
      occurrenceAnchor: anchor,
      contextKind: 'MEMBER_READ',
      targetSymbolName,
      historicalTerm: candMemberType,
      historicalContextTerm: candMemberType,
      requiredRelations: [rel],
      parentValid: true
    };
  }

  /**
   * Straight-line leaf expression type inference for F0 expressions.
   */
  public static inferExpressionType(node: ts.Expression, sf: ts.SourceFile): F0ScalarType {
    if (ts.isStringLiteral(node)) {
      return { kind: 'literal', value: node.text };
    }
    if (ts.isNumericLiteral(node)) {
      const val = Number(node.text);
      const isNegZero = node.text === '-0' || Object.is(val, -0);
      return { kind: 'literal', value: isNegZero ? -0 : val };
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) {
      return { kind: 'literal', value: true };
    }
    if (node.kind === ts.SyntaxKind.FalseKeyword) {
      return { kind: 'literal', value: false };
    }
    if (node.kind === ts.SyntaxKind.NullKeyword) {
      return { kind: 'primitive', name: 'null' };
    }
    if (ts.isIdentifier(node)) {
      // Use only a declaration in the nearest lexical scope. Annotated
      // parameters are direct sealed witnesses for their scalar type; an
      // unsupported annotation or a shadowing declaration must not fall
      // through to an outer binding.
      const name = node.text;
      let curr: ts.Node = node;
      while (curr.parent) {
        const parent = curr.parent;
        if (ts.isFunctionLike(parent) && 'body' in parent && parent.body && isDescendantOf(curr, parent.body)) {
          const parameter = parent.parameters.find(p => ts.isIdentifier(p.name) && p.name.text === name);
          if (parameter) {
            if (parameter.type) {
              const ext = F0TypeVerifier.extractScalarType(parameter.type, () => undefined);
              if (ext.valid) return ext.type;
            }
            break;
          }
        }
        if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
          const stmts = ts.isBlock(parent) ? parent.statements : (parent as ts.SourceFile).statements;
          let shadowed = false;
          for (const s of stmts) {
            if (ts.isVariableStatement(s)) {
              for (const d of s.declarationList.declarations) {
                if (ts.isIdentifier(d.name) && d.name.text === name) {
                  if (d.type) {
                    const ext = F0TypeVerifier.extractScalarType(d.type, () => undefined);
                    if (ext.valid) return ext.type;
                    shadowed = true;
                    break;
                  } else if (d.initializer) {
                    return HistoricalObligationGenerator.inferExpressionType(d.initializer, sf);
                  } else {
                    shadowed = true;
                    break;
                  }
                }
              }
            }
            if (shadowed) break;
          }
          if (shadowed) break;
        }
        curr = parent;
      }
    }

    throw new Error(`No sealed F0 type witness for expression at ${sf.fileName}:${node.getStart(sf)}`);
  }
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}
