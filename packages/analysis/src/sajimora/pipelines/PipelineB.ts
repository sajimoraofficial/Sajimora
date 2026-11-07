import * as ts from 'typescript';
import * as crypto from 'node:crypto';
import {
  ProofObligation,
  ProofResult,
  VerdictAuthority,
  SemanticScopeCalculator,
  CompleteProofEvidence,
  UsageSite,
  CompatibilityResult,
  SymbolRef,
  RepositoryAnalysisUniverse,
  CrossVersionIdentityBundle,
  ObligationProofStatus,
  CanonicalSiteProofStatus,
  getSymbolName,
  CandidateDeletionProof
} from '@sajimora/core';
import { isProviderMutationValidlyCharacterized } from '@sajimora/core';
import { ConsumerDiscoveryCoordinator } from '../closures/ConsumerDiscoveryCoordinator';
import { RepositoryAnalysisUniverseBuilder } from '../universe/RepositoryAnalysisUniverse';
import { AnalysisContext } from '../context/AnalysisContext';
import { TypeScriptCompatibility } from '../compatibility/TypeScriptCompatibility';
import { Phase4SemanticProvider } from '../compatibility/Phase4SemanticProvider';
import { LiveProgramSemanticProvider } from '../compatibility/LiveProgramSemanticProvider';
import { AuthorityIntegrationLayer, ReconcileOptions } from '../compatibility/AuthorityIntegrationLayer';
import { TypeScriptPolicy } from '../languages/typescript/compatibility/TypeScriptSemanticRules';
import { TypeScriptTypeIRExtractor } from '../languages/typescript/ir/TypeScriptTypeIRExtractor';
import { programDiscoveryCache } from '../languages/typescript/identity/TypeScriptCrossVersionIdentity';
import { proveCandidateBindingAbsent } from '../identity/CandidateDeletionProof';

export interface PipelineBExecutionOptions {
  universe?: RepositoryAnalysisUniverse;
  context?: AnalysisContext;
  workspaceRoot?: string;
  evaluateCompatibility?: (site: UsageSite) => CompatibilityResult;
  isPhase4Mode?: boolean;
  provider?: Phase4SemanticProvider;
  phase4ReconcileOptions?: ReconcileOptions;
  parentProgram?: ts.Program;
  candidateProgram?: ts.Program;
  parentPrograms?: ts.Program[];
  candidatePrograms?: ts.Program[];
  parentDeclarationNode?: ts.Node;
  candidateDeclarationNode?: ts.Node;
  policy?: TypeScriptPolicy;
  discoveredHistoricalConsumerIds?: ReadonlyArray<string>;
  candidateAddedConsumerIds?: ReadonlyArray<string>;
  ambiguousLifecycleConsumerIds?: ReadonlyArray<string>;
  crossVersionIdentity?: CrossVersionIdentityBundle;
  discovery?: import('../closures/ConsumerDiscoveryCoordinator').ConsumerDiscoveryEvidence;
  canonicalOccurrences?: UsageSite[];
}

/**
 * Pipeline B: CONSUMER_PROOF_V1
 * 
 * Orchestrates full AST traversal and closure rollup across all 7 closures.
 * Enforces strict authority separation: PipelineB does NOT translate uncertainty
 * into verdicts or heuristics; it delegates purely to VerdictAuthority.
 */
export class PipelineB {
  public execute(obligation: ProofObligation, options?: PipelineBExecutionOptions): ProofResult {
    // 1. B1 Applicability Gate
    if (obligation.relation !== 'STRUCTURAL_CO_EVOLUTION' && obligation.relation !== 'INTERFACE_PRESERVATION') {
      return VerdictAuthority.evaluatePreflight('NOT_APPLICABLE', 'APPLICABILITY', 'STRUCTURAL_TRIGGER_NO_CONSUMERS', 'NO_STRUCTURAL_TRIGGER');
    }

    if (!obligation.mutatedSymbol) {
      return VerdictAuthority.evaluatePreflight('NOT_APPLICABLE', 'APPLICABILITY', 'STRUCTURAL_TRIGGER_NO_CONSUMERS', 'NO_STRUCTURAL_TRIGGER');
    }

    if (!obligation.providerMutation || !isProviderMutationValidlyCharacterized(obligation.providerMutation)) {
      return VerdictAuthority.evaluatePreflight('UNKNOWN', 'OBLIGATION_VALIDITY', 'UNKNOWN_FALLTHROUGH');
    }

    const isPhase4 = Boolean(options?.isPhase4Mode || options?.phase4ReconcileOptions?.isPhase4Mode);
    let relevantTargetMapping: any = undefined;
    let obligationProof: ObligationProofStatus = {
      parentDeclarationId: null, parentBindingEvidenceId: null,
      candidateCorrespondence: 'UNPROVEN', completeness: 'INCOMPLETE', blockers: []
    };

    // Finding 11: Require verified historical coverage before authority evaluation in Phase 4
    if (isPhase4) {
      const hasHistoricalCoverage = Boolean(
        options?.discoveredHistoricalConsumerIds !== undefined ||
        options?.phase4ReconcileOptions?.discoveredHistoricalConsumerIds !== undefined ||
        options?.crossVersionIdentity !== undefined
      );
      if (!hasHistoricalCoverage) {
        return VerdictAuthority.evaluatePreflight(
          'UNKNOWN',
          'COVERAGE',
          'DISCOVERY_FAILURE'
        );
      }
    }

    const targetSymbol: SymbolRef = obligation.mutatedSymbol;

    // 2. B2 Universe & Context Hydration
    const hasPrecomputedDiscovery = Boolean(options?.discovery || options?.canonicalOccurrences);
    const workspaceRoot = options?.workspaceRoot ?? process.cwd();
    const universe =
      options?.universe ??
      (hasPrecomputedDiscovery
        ? {
            rootPath: '',
            discoveredFiles: [],
            discoveredFileSet: new Set<string>(),
            excludedFiles: new Map<string, string>(),
            unsupportedFiles: [],
            unreadableFiles: [],
            parseFailures: new Map<string, string>(),
            discoveryStatus: 'DISCOVERY_COMPLETE' as const,
            discoveryEvidence: 'Precomputed indexed discovery'
          }
        : RepositoryAnalysisUniverseBuilder.build({ workspaceRoot }));

    if (universe.discoveryStatus === 'DISCOVERY_FAILED') {
      return VerdictAuthority.evaluatePreflight('UNKNOWN', 'UNIVERSE_DISCOVERY', 'DISCOVERY_FAILURE');
    }

    const isInternalContext = !options?.context && !hasPrecomputedDiscovery;
    const context = options?.context ?? (hasPrecomputedDiscovery ? undefined : new AnalysisContext(universe));

    try {
      // 3. B3 Parse Gate: Checked securely by VerdictAuthority

      // 4. B5 Consumer Enumeration (The 7 Closures) against PARENT program
      const parentProg = options?.parentProgram ?? context?.getProgram();
      let discovery: import('../closures/ConsumerDiscoveryCoordinator').ConsumerDiscoveryEvidence | undefined = options?.discovery;
      if (!discovery) {
        const targetIdentityId = (targetSymbol as any).persistentSymbolId;
        if (parentProg && targetIdentityId) {
          discovery = programDiscoveryCache.get(parentProg)?.get(targetIdentityId);
        }
        if (!discovery && context) {
          discovery = new ConsumerDiscoveryCoordinator().discover(context, targetSymbol, universe);
        }
      }
      if (!discovery) {
        return VerdictAuthority.evaluatePreflight('UNKNOWN', 'COVERAGE', 'DISCOVERY_FAILURE');
      }
      const [valueClosure,typeClosure,inheritanceClosure,interfaceClosure,overrideClosure,reExportClosure,ambientClosure] = discovery.closures;

      // 5. B6 Rollup
      const rollup = discovery.rollup;
      const occurrenceKey = (occ: import('@sajimora/core').CanonicalReferenceOccurrence) =>
        [occ.referencedSymbol, occ.declarationSymbol, occ.semanticRole, occ.usageRole,
          occ.sourceFile, occ.sourceSpan.start, occ.sourceSpan.end].join('|');

      // Candidate Identity & Reconciliation for this specific obligation
      let isTargetAmbiguousOrUncertain = false;
      if (isPhase4 && options?.crossVersionIdentity) {
        const bundle = options.crossVersionIdentity;

        // Finding 10: Parent discovery blocker check (e.g. PARENT_DISCOVERY_FAILED)
        const blockers: any[] = (bundle as any).discoveryBlockers ?? bundle.blockers ?? [];
        const hasParentDiscoveryBlocker = blockers.some((b: any) => {
          const bStr = typeof b === 'string' ? b : (b.blockerId ?? b.message ?? '');
          return bStr === 'PARENT_DISCOVERY_FAILED' || bStr === 'PROGRAM_DISCOVERY_INCOMPLETE';
        });
        if (hasParentDiscoveryBlocker) {
          return VerdictAuthority.evaluatePreflight(
            'UNKNOWN',
            'COVERAGE',
            'DISCOVERY_FAILURE'
          );
        }

        const targetMappings: any[] = (bundle as any).targetMappings ?? ((bundle as any).targetMapping ? [(bundle as any).targetMapping] : []);

        // ── Case-A ID-bridge ─────────────────────────────────────────────────
        // Obligation persistentSymbolId is Namespace-C:  "<absFile>::<KIND>::<name>"
        //   (realDiffObligationAdapter:68 — absolute git-repo path, never temp-snapshot path).
        // Bundle identityId is Namespace-B:  sha256("<projId>|<relFile>|...|<name>|<ord>")
        //   (TypeScriptDeclarationIndexer:74 — 64-char hex).
        // These namespaces are structurally disjoint; === always returns false.
        //
        // The snapshot materializes to a temp directory distinct from the git repo root.
        // normalizeSourceFilePath(declLoc, parentProg) cannot bridge the two roots,
        // because parentProg.getCurrentDirectory() returns the temp root while declLoc
        // is an absolute path under the git repo root.
        //
        // Bridge strategy: for each bundle entry, tm.parent.moduleIdentity is a
        // repo-relative path (e.g. "packages/zod/src/v4/core/schemas.ts").
        // The obligation's absolute path always ends with "/" + moduleIdentity.
        // A slash-anchored endsWith check is exact (full relative-path segment) and
        // does NOT reduce to name-only matching.
        //
        // Injective guard: if two targetMappings produce the same bridgeKey
        // (same moduleIdentity + localName), poison the entry → exactMappings=[] →
        // same UNKNOWN outcome as before; no regression.
        //
        // declarationKind excluded: representations differ across namespaces
        // ("FUNCTION" vs "FunctionDeclaration").
        const _bNorm = (p: string): string => p.replace(/\\/g, '/').replace(/^\/+/, '');

        // Extract localName from Namespace-C: last segment after the final "::"
        const _nsC: string = targetSymbol.persistentSymbolId ?? '';
        const _nsCParts: string[] = _nsC.split('::');
        const _nsCLocal: string | undefined = _nsCParts.length >= 3
          ? _nsCParts[_nsCParts.length - 1]
          : undefined;

        // Slash-normalize the obligation's absolute file path (no leading-slash strip —
        // keep it absolute so the endsWith anchor is unambiguous).
        const _declLoc: string | undefined =
          (targetSymbol as any).declarationLocation?.filePath ??
          (targetSymbol as any).declarationLocation?.file;
        const _slashDeclLoc: string | undefined = _declLoc
          ? _declLoc.replace(/\\/g, '/')
          : undefined;

        let _bridgedId: string | undefined;
        const _mapKind = (k: string | undefined): string => {
          switch (k) {
            case 'FUNCTION': return 'FunctionDeclaration';
            case 'METHOD': return 'MethodDeclaration';
            case 'CLASS': return 'ClassDeclaration';
            case 'INTERFACE': return 'InterfaceDeclaration';
            case 'TYPE_ALIAS': return 'TypeAliasDeclaration';
            case 'ENUM': return 'EnumDeclaration';
            case 'FIELD': return 'VariableDeclaration';
            default: return k ?? '';
          }
        };
        const _nsCKind = _mapKind(targetSymbol.kind);

        if (_slashDeclLoc && _nsCLocal && _nsCKind) {
          const _bMap = new Map<string, string>();
          const _bPoison = new Set<string>();
          for (const _tm of targetMappings) {
            if (!_tm.parent?.identityId || !_tm.parent?.moduleIdentity || !_tm.parent?.localName || !_tm.parent?.declarationKind) continue;
            const _modId: string = _bNorm(_tm.parent.moduleIdentity);
            // Exact path-suffix check: obligation absolute path must end with /moduleIdentity
            if (!_slashDeclLoc.endsWith('/' + _modId)) continue;
            const _bk = _modId + '::' + _tm.parent.declarationKind + '::' + _tm.parent.localName;
            if (_bPoison.has(_bk)) continue;
            if (_bMap.has(_bk)) { _bPoison.add(_bk); _bMap.delete(_bk); }
            else { _bMap.set(_bk, _tm.parent.identityId); }
          }
          // _bMap now contains only entries whose moduleIdentity is a path-suffix of the
          // obligation file.  Find the entry matching localName — the injective guard already
          // ensured at most one mapping survives per (file, kind, localName) tuple.
          const _searchKey = '::' + _nsCKind + '::' + _nsCLocal;
          for (const [_k, _v] of _bMap) {
            if (_k.endsWith(_searchKey)) { _bridgedId = _v; break; }
          }
          if (process.env['SAJIMORA_BRIDGE_DEBUG']) {
            const _matches = targetMappings.filter((_t: any) =>
              _t.parent?.moduleIdentity && _t.parent?.localName && _t.parent?.declarationKind &&
              _slashDeclLoc.endsWith('/' + _bNorm(_t.parent.moduleIdentity)) &&
              _t.parent.declarationKind === _nsCKind &&
              _t.parent.localName === _nsCLocal
            );
            const _matchCount = _matches.length;
            process.stderr.write(
              `[BRIDGE] obligationId=${JSON.stringify(_nsC)}\n` +
              `         slashDeclLoc=${_slashDeclLoc}  nsCKind=${_nsCKind}  localName=${_nsCLocal}\n` +
              `         matchedDeclCount=${_matchCount}  resolvedId=${_bridgedId ?? '(none)'}\n`
            );
            if (_matchCount > 1) {
              const _bk = _bNorm(_matches[0].parent.moduleIdentity) + '::' + _nsCKind + '::' + _nsCLocal;
              process.stderr.write(`[BRIDGE_COLLISION] persistentSymbolId=${_nsC} bridgeKey=${_bk}\n`);
              for (const m of _matches) {
                process.stderr.write(JSON.stringify({
                  parent: m.parent ? {
                    identityId: m.parent.identityId,
                    moduleIdentity: m.parent.moduleIdentity,
                    declarationKind: m.parent.declarationKind,
                    localName: m.parent.localName,
                    declarationOrdinal: m.parent.declarationOrdinal,
                    status: m.parent.status,
                    sourceSpan: m.parent.sourceSpan,
                    side: m.parent.side,
                    version: m.parent.version,
                    commit: m.parent.commit
                  } : undefined,
                  candidate: m.candidate ? {
                    identityId: m.candidate.identityId,
                    moduleIdentity: m.candidate.moduleIdentity,
                    declarationKind: m.candidate.declarationKind,
                    localName: m.candidate.localName,
                    status: m.candidate.status
                  } : undefined,
                  status: m.status,
                  side: m.side,
                  version: m.version,
                  commit: m.commit
                }, null, 2) + '\n');
              }
            }
          }
        }
        // ── end Case-A ID-bridge ──────────────────────────────────────────────

        // Select the authoritative target mapping using the bridged Namespace-B id.
        // No fallback to Namespace-C===Namespace-B: obligation persistentSymbolId
        // is always Namespace-C and can never equal a Namespace-B identityId.
        const exactMappings: any[] = _bridgedId !== undefined
          ? targetMappings.filter((tm: any) => tm.parent?.identityId === _bridgedId)
          : [];
        if (process.env['SAJIMORA_BRIDGE_DEBUG'] && (_slashDeclLoc && _nsCLocal)) {
          process.stderr.write(`         mappingCount=${exactMappings.length}\n`);
        }
        if (exactMappings.length === 1) relevantTargetMapping = exactMappings[0];

        // Scope blockers to this obligation using persistent identity and location (NOT symbol name alone)
        const pId = relevantTargetMapping?.parent?.identityId ?? (targetSymbol as any)?.persistentSymbolId;
        const cId = relevantTargetMapping?.candidate?.identityId;
        const targetBlockers = blockers.filter((b: any) => {
          const bStr = typeof b === 'string' ? b : (b.blockerId ?? b.message ?? JSON.stringify(b));
          if (pId && bStr.includes(pId)) return true;
          if (cId && bStr.includes(cId)) return true;
          return false;
        });

        obligationProof = {
          parentDeclarationId: relevantTargetMapping?.parent?.identityId ?? null,
          parentBindingEvidenceId: null,
          candidateCorrespondence: exactMappings.length > 1 || relevantTargetMapping?.status === 'AMBIGUOUS'
            ? 'AMBIGUOUS' : (relevantTargetMapping?.status === 'SAME_DECLARATION' || (relevantTargetMapping?.candidate && relevantTargetMapping?.status === 'UNRESOLVED')) ? 'PROVEN' : 'UNPROVEN',
          completeness: bundle.status === 'COMPLETE' && targetBlockers.length === 0 ? 'COMPLETE' : 'INCOMPLETE',
          blockers: [...(exactMappings.length === 0 ? ['TARGET_MAPPING_NOT_PROVEN'] : []),
            ...(exactMappings.length > 1 ? ['TARGET_MAPPING_AMBIGUOUS'] : []), ...targetBlockers.map(String)]
        };

        // Evaluate target uncertainty at obligation scope
        if (!relevantTargetMapping) {
          isTargetAmbiguousOrUncertain = true;
        } else if (relevantTargetMapping) {
          if (
            relevantTargetMapping.status === 'AMBIGUOUS' ||
            (relevantTargetMapping.status === 'UNRESOLVED' && !relevantTargetMapping.candidate) ||
            relevantTargetMapping.status === 'UNCERTAIN' ||
            (relevantTargetMapping as any).targetIdentity === 'UNCERTAIN' ||
            (relevantTargetMapping as any).targetIdentity === 'AMBIGUOUS' ||
            targetBlockers.length > 0
          ) {
            isTargetAmbiguousOrUncertain = true;
          }
        }
      }

      // Derive lifecycle classification and historical coverage mappings
      const mappingByOccId = new Map<string, import('@sajimora/core').CrossVersionConsumerMapping>();
      const mappedParentToCandOccId = new Map<string, string>();
      const histIds = new Set<string>(
        options?.discoveredHistoricalConsumerIds ??
        options?.phase4ReconcileOptions?.discoveredHistoricalConsumerIds ??
        []
      );
      const addedIds = new Set<string>(
        options?.candidateAddedConsumerIds ??
        options?.phase4ReconcileOptions?.candidateAddedConsumerIds ??
        []
      );
      const ambiguousIds = new Set<string>(
        options?.ambiguousLifecycleConsumerIds ??
        options?.phase4ReconcileOptions?.ambiguousLifecycleConsumerIds ??
        []
      );

      if (options?.crossVersionIdentity?.consumerMappings) {
        const currentOccIds = new Set(rollup.occurrences.map(o => o.occurrenceId));
        for (const m of options.crossVersionIdentity.consumerMappings) {
          const matchesTarget = (
            ((m as any).targetParentId && relevantTargetMapping?.parent?.identityId && (m as any).targetParentId === relevantTargetMapping.parent.identityId) ||
            ((m as any).targetCandidateId && relevantTargetMapping?.candidate?.identityId && (m as any).targetCandidateId === relevantTargetMapping.candidate.identityId) ||
            (m.candidateOccurrenceId && currentOccIds.has(m.candidateOccurrenceId)) ||
            (m.parentOccurrenceId && currentOccIds.has(m.parentOccurrenceId))
          );

          if (!matchesTarget) {
            continue;
          }

          if (m.candidateOccurrenceId) mappingByOccId.set(m.candidateOccurrenceId, m);
          if (m.parentOccurrenceId) mappingByOccId.set(m.parentOccurrenceId, m);
          if (m.parentOccurrenceId && m.candidateOccurrenceId) {
            mappedParentToCandOccId.set(m.parentOccurrenceId, m.candidateOccurrenceId);
          }

          if (m.lifecycle === 'ADDED_IN_CANDIDATE') {
            if (m.candidateOccurrenceId) addedIds.add(m.candidateOccurrenceId);
          } else if (m.lifecycle === 'REMOVED_IN_CANDIDATE' || m.lifecycle === 'BINDING_REMOVED_IN_CANDIDATE') {
            if (m.parentOccurrenceId) histIds.add(m.parentOccurrenceId);
          } else if (m.lifecycle === 'AMBIGUOUS_ACROSS_VERSIONS') {
            if (m.candidateOccurrenceId) ambiguousIds.add(m.candidateOccurrenceId);
            if (m.parentOccurrenceId) ambiguousIds.add(m.parentOccurrenceId);
          } else {
            // Reconciled consumer: candidate occurrence satisfies parent occurrence obligation
            if (m.parentOccurrenceId) {
              histIds.add(m.parentOccurrenceId);
            }
          }
        }
      }

      // 6. Map to UsageSites with derived lifecycle evidence
      const isDeletionClaim = obligation.providerMutation?.classification === 'SYMBOL_DELETED';

      let canonicalOccurrences: UsageSite[] = options?.canonicalOccurrences ?? rollup.occurrences.map((occ) => {
        let deletionProof: CandidateDeletionProof | undefined;
        if (isDeletionClaim) {
          const isPredictionMode = !options?.crossVersionIdentity && !options?.candidatePrograms && !options?.candidateProgram;
          if (isPredictionMode) {
            const symId = targetSymbol.persistentSymbolId ?? '';
            const closureProv = discovery.closures.filter(c => c.occurrences.some(raw => occurrenceKey(raw) === occurrenceKey(occ))).map(c => c.closureName);
            const proofPayload = JSON.stringify({
              mode: 'prediction', occurrenceId: occ.occurrenceId, persistentSymbolId: symId,
              sourceFile: occ.sourceFile, sourceSpan: occ.sourceSpan,
              closureProvenance: closureProv
            });
            const hash = crypto.createHash('sha256').update(proofPayload).digest('hex');
            
            deletionProof = {
              status: 'PROVEN_ABSENT',
              evidenceId: crypto.createHash('sha256').update(`PREDICTION_EVIDENCE|${hash}`).digest('hex'),
              proofHash: hash,
              occurrenceId: occ.occurrenceId,
              persistentSymbolId: symId,
              declarationId: symId,
              sourceFile: occ.sourceFile,
              sourceSpan: occ.sourceSpan,
              parentBinding: occ.declarationSymbol ?? null,
              candidateBindingTargets: [],
              plausibleCandidateDeclarations: [],
              aliasChain: occ.provenance,
              candidateAliasChain: [],
              closureProvenance: closureProv,
              deduplicationKey: `prediction-key|${symId}|${occ.occurrenceId}`,
              candidateUniverseFingerprint: crypto.createHash('sha256').update('VIRTUAL_PREDICTION_UNIVERSE').digest('hex'),
              candidateUniverseComplete: true,
              blockers: []
            };
          } else {
            deletionProof = proveCandidateBindingAbsent({
              occurrence: occ,
              persistentSymbolId: targetSymbol.persistentSymbolId ?? '',
              bundle: options?.crossVersionIdentity,
              parentPrograms: options?.parentPrograms ?? (options?.parentProgram ? [options.parentProgram] : []),
              candidatePrograms: options?.candidatePrograms ?? (options?.candidateProgram ? [options.candidateProgram] : []),
              closureProvenance: discovery.closures.filter(c => c.occurrences.some(raw => occurrenceKey(raw) === occurrenceKey(occ)))
                .map(c => c.closureName)
            });
          }
        }
        const isTargetDeleted = deletionProof?.status === 'PROVEN_ABSENT';
        const mapping = mappingByOccId.get(occ.occurrenceId);
        const isAdded = addedIds.has(occ.occurrenceId) || mapping?.lifecycle === 'ADDED_IN_CANDIDATE';
        const isRemoved = mapping?.lifecycle === 'REMOVED_IN_CANDIDATE';
        const isBindingRemoved = mapping?.lifecycle === 'BINDING_REMOVED_IN_CANDIDATE';
        const isAmbiguous = ambiguousIds.has(occ.occurrenceId) || mapping?.lifecycle === 'AMBIGUOUS_ACROSS_VERSIONS';
        const isChangedCommit = mapping?.lifecycle === 'STABLE_CHANGED_SAME_COMMIT';

        const existenceAtParent: 'PRESENT' | 'ABSENT' = isAdded ? 'ABSENT' : 'PRESENT';
        const mutationStatus: 'UNCHANGED' | 'CHANGED' | 'REMOVED' = isAdded
          ? 'CHANGED'
          : ((isRemoved && !isDeletionClaim) || isTargetDeleted)
            ? 'REMOVED'
            : isChangedCommit
              ? 'CHANGED'
              : 'UNCHANGED';
        const bindingPresenceAtCandidate: 'PRESENT' | 'ABSENT' = ((isRemoved || isBindingRemoved) && !isDeletionClaim) || isTargetDeleted ? 'ABSENT' : 'PRESENT';
        const bindingState: UsageSite['bindingState'] = ((isBindingRemoved && !isDeletionClaim) || isTargetDeleted)
          ? 'WAS_BOUND_NOW_ABSENT'
          : occ.resolutionStatus === 'RESOLVED'
            ? 'BOUND'
            : 'NEVER_BOUND';

        const isTargetUncertain = isTargetAmbiguousOrUncertain || mapping?.targetIdentity === 'UNCERTAIN' ||
          (isDeletionClaim && !isTargetDeleted);
        const evaluationStatus: UsageSite['evaluationStatus'] =
          occ.resolutionStatus !== 'RESOLVED' || isAmbiguous || (isTargetUncertain && !isTargetDeleted)
            ? 'UNCERTAIN_IDENTITY'
            : occ.usageRole === 'RE_EXPORTER'
              ? 'EXCLUDED_RE_EXPORTER'
              : 'EVALUABLE';

        const identityResult: UsageSite['identityResult'] =
          occ.resolutionStatus !== 'RESOLVED' || isAmbiguous || (isTargetUncertain && !isTargetDeleted)
            ? 'IDENTITY_UNCERTAIN'
            : 'SAME';

        const site: UsageSite = {
          usageSiteId: occ.occurrenceId,
          canonicalOccurrence: occ,
          ...(deletionProof ? { deletionProof } : {}),
          existenceAtParent,
          mutationStatus,
          bindingPresenceAtCandidate,
          bindingState,
          evaluationStatus,
          identityResult,
          enumerationInconsistencyCause: null,
          provenance: occ.usageRole === 'RE_EXPORTER' ? 'RE_EXPORTED' : 'UNCHANGED'
        };
        if ((mapping as any)?.parentOccurrence) {
          (site as any).parentCanonicalOccurrence = (mapping as any).parentOccurrence;
        }
        return site;
      });
      if (isDeletionClaim && options?.canonicalOccurrences) {
        canonicalOccurrences = canonicalOccurrences.map(site => {
          const proof = proveCandidateBindingAbsent({
            occurrence: site.canonicalOccurrence,
            persistentSymbolId: targetSymbol.persistentSymbolId ?? '',
            bundle: options?.crossVersionIdentity,
            parentPrograms: options?.parentPrograms ?? (options?.parentProgram ? [options.parentProgram] : []),
            candidatePrograms: options?.candidatePrograms ?? (options?.candidateProgram ? [options.candidateProgram] : []),
            closureProvenance: discovery.closures.filter(c => c.occurrences.some(raw =>
              occurrenceKey(raw) === occurrenceKey(site.canonicalOccurrence))).map(c => c.closureName)
          });
          return {
            ...site, deletionProof: proof,
            bindingPresenceAtCandidate: proof.status === 'PROVEN_ABSENT' ? 'ABSENT' : 'PRESENT',
            bindingState: proof.status === 'PROVEN_ABSENT' ? 'WAS_BOUND_NOW_ABSENT' : 'BOUND',
            evaluationStatus: proof.status === 'PROVEN_ABSENT' ? site.evaluationStatus : 'UNCERTAIN_IDENTITY',
            identityResult: proof.status === 'PROVEN_ABSENT' ? site.identityResult : 'IDENTITY_UNCERTAIN'
          };
        });
      }

      // 7. Compatibility Results Evaluation
      let candDeclNode = options?.candidateDeclarationNode;
      const candProg = options?.candidateProgram;
      const candProgsToSearch: ts.Program[] = [
        candProg,
        ...(options?.candidatePrograms ?? []).filter(p => p && p !== candProg)
      ].filter(Boolean) as ts.Program[];

      if (!candDeclNode && candProgsToSearch.length > 0 && targetSymbol) {
        const targetName = getSymbolName(targetSymbol);
        const targetLoc = (targetSymbol as any).declarationLocation?.filePath ?? (targetSymbol as any).declarationLocation?.file ?? (targetSymbol as any).moduleIdentity;
        if (targetLoc) {
          const clean = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '');
          const normTargetParent = parentProg ? clean(TypeScriptTypeIRExtractor.normalizeSourceFilePath(targetLoc, parentProg)) : '';
          const targetLocNorm = clean(targetLoc);
          const stripExt = (p: string) => p.replace(/\.[a-zA-Z0-9]+$/, '');

          for (const curCandProg of candProgsToSearch) {
            const normTargetCand = clean(TypeScriptTypeIRExtractor.normalizeSourceFilePath(targetLoc, curCandProg));
            for (const sf of curCandProg.getSourceFiles()) {
              const rel = clean(sf.fileName);
              const normCand = clean(TypeScriptTypeIRExtractor.normalizeSourceFilePath(sf.fileName, curCandProg));
              const matchesFile = (
                normCand === normTargetCand ||
                (normTargetParent.length > 0 && normCand === normTargetParent) ||
                (normTargetCand.length > 0 && stripExt(normTargetCand) === stripExt(normCand)) ||
                (normTargetParent.length > 0 && stripExt(normTargetParent) === stripExt(normCand)) ||
                rel.toLowerCase() === targetLocNorm.toLowerCase() ||
                (targetLocNorm.length > 0 && rel.toLowerCase().endsWith('/' + targetLocNorm.toLowerCase())) ||
                (rel.length > 0 && targetLocNorm.toLowerCase().endsWith('/' + rel.toLowerCase())) ||
                TypeScriptTypeIRExtractor.scorePathMatch(sf.fileName, targetLoc) >= 2
              );
              if (matchesFile) {
                // Match top-level statements only
                for (const stmt of sf.statements) {
                  if ((stmt as any).name && (stmt as any).name.text === targetName) {
                    candDeclNode = stmt;
                    break;
                  }
                  if (ts.isVariableStatement(stmt)) {
                    for (const decl of stmt.declarationList.declarations) {
                      if ((decl.name as any).text === targetName) {
                        candDeclNode = decl;
                        break;
                      }
                    }
                    if (candDeclNode) break;
                  }
                }
                if (candDeclNode) break;
              }
            }
            if (candDeclNode) break;
          }
        }
      }

      if (!candDeclNode && candProgsToSearch.length > 0 && relevantTargetMapping?.candidate) {
        const candTarget = relevantTargetMapping.candidate;
        const clean = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '');
        for (const curCandProg of candProgsToSearch) {
          for (const sf of curCandProg.getSourceFiles()) {
            const normCand = clean(TypeScriptTypeIRExtractor.normalizeSourceFilePath(sf.fileName, curCandProg));
            if (
              normCand === candTarget.moduleIdentity ||
              sf.fileName.replace(/\\/g, '/').endsWith('/' + candTarget.moduleIdentity) ||
              TypeScriptTypeIRExtractor.scorePathMatch(sf.fileName, candTarget.moduleIdentity) >= 2
            ) {
              for (const stmt of sf.statements) {
                if ((stmt as any).name && (stmt as any).name.text === candTarget.localName) {
                  candDeclNode = stmt;
                  break;
                }
                if (ts.isVariableStatement(stmt)) {
                  for (const decl of stmt.declarationList.declarations) {
                    if ((decl.name as any).text === candTarget.localName) {
                      candDeclNode = decl;
                      break;
                    }
                  }
                  if (candDeclNode) break;
                }
              }
              if (candDeclNode) break;
            }
          }
          if (candDeclNode) break;
        }
      }

      const compatibilityResults = new Map<string, CompatibilityResult>();
      const provider = options?.provider ?? (isPhase4 && parentProg && candProg ? new LiveProgramSemanticProvider({
        parentProgram: parentProg,
        candidateProgram: candProg,
        candidatePrograms: options?.candidatePrograms,
        obligation,
        candidateDeclarationNode: candDeclNode
      }) : undefined);

      const defaultCompatibility = new TypeScriptCompatibility(context, obligation, {
        isPhase4Mode: isPhase4,
        provider,
        parentProgram: parentProg,
        candidateProgram: candProg,
        candidateDeclarationNode: candDeclNode,
        policy: options?.policy
      } as any);

      for (const site of canonicalOccurrences) {
        if (site.evaluationStatus === 'EVALUABLE') {
          const result = options?.evaluateCompatibility
            ? options.evaluateCompatibility(site)
            : defaultCompatibility.evaluateSite(site);
          compatibilityResults.set(
            site.usageSiteId,
            result ?? { status: 'UNDECIDABLE' as const, reason: null }
          );
        }
      }

      const semanticScope = SemanticScopeCalculator.calculate(obligation, 'typescript', targetSymbol.kind);
      // This is an observational projection of the identity state already used
      // to construct UsageSites. It is not consumed by verdict evaluation.
      const identityResults = canonicalOccurrences.map(site => ({
        usageSiteId: site.usageSiteId,
        referencedSymbol: site.canonicalOccurrence.referencedSymbol,
        declarationSymbol: site.canonicalOccurrence.declarationSymbol,
        resolutionStatus: site.canonicalOccurrence.resolutionStatus,
        identityResult: site.identityResult,
        evaluationStatus: site.evaluationStatus
      }));

      const completeEvidence: CompleteProofEvidence<any> = {
        triggerData: null,
        obligation,
        analysisUniverse: universe,
        closures: {
          valueReference: valueClosure,
          typeReference: typeClosure,
          inheritance: inheritanceClosure,
          interfaceImpl: interfaceClosure,
          override: overrideClosure,
          reExport: reExportClosure,
          ambientReference: ambientClosure
        },
        canonicalOccurrences,
        identityResults,
        compatibilityResults,
        semanticScope
      };

      // Reconcile coverage & validate proof trees before delegating to VerdictAuthority
      // Finding 10: Unconditionally propagate isPhase4Mode so auxiliary options cannot disable validation
      const reconcileOpts: ReconcileOptions = {
        ...options?.phase4ReconcileOptions,
        isPhase4Mode: isPhase4,
        discoveredHistoricalConsumerIds: Array.from(histIds),
        candidateAddedConsumerIds: Array.from(addedIds),
        ambiguousLifecycleConsumerIds: Array.from(ambiguousIds),
        mappedHistoricalConsumerIds: mappedParentToCandOccId
      };
      const reconciledEvidence = AuthorityIntegrationLayer.reconcileAndIntegrate(
        completeEvidence,
        reconcileOpts
      );

      const scopeCertificate = (reconciledEvidence as any).scopeCertificate as
        { status: 'PROVEN' | 'UNPROVEN'; blockers: string[] } | undefined;
      const siteProofs: CanonicalSiteProofStatus[] = reconciledEvidence.canonicalOccurrences.map(site => {
        const result = reconciledEvidence.compatibilityResults.get(site.usageSiteId);
        const blockers = [
          ...(site.canonicalOccurrence.enumerationStatus === 'COMPLETE' ? [] : ['OCCURRENCE_ENUMERATION_INCOMPLETE']),
          ...(site.evaluationStatus === 'UNCERTAIN_IDENTITY' || site.identityResult === 'IDENTITY_UNCERTAIN' ? ['IDENTITY_UNPROVEN'] : []),
          ...(result?.status === 'UNDECIDABLE' ? [`COMPATIBILITY_${result.reason ?? 'UNDECIDABLE'}`] : []),
          ...(scopeCertificate?.blockers ?? [])
        ];
        return {
          occurrenceId: site.usageSiteId,
          coverage: site.canonicalOccurrence.enumerationStatus === 'COMPLETE' ? 'PROVEN' : 'BLOCKED',
          identity: site.evaluationStatus === 'UNCERTAIN_IDENTITY' || site.identityResult === 'IDENTITY_UNCERTAIN' ? 'UNPROVEN' : 'PROVEN',
          semanticScope: scopeCertificate?.status === 'PROVEN' ? 'PROVEN' : 'BLOCKED',
          compatibility: !result ? 'NOT_EVALUATED' : result.status === 'UNDECIDABLE' ? 'BLOCKED' : 'PROVEN',
          blockers: [...new Set(blockers)]
        };
      });
      if (!obligationProof.parentBindingEvidenceId) {
        obligationProof.parentBindingEvidenceId = reconciledEvidence.canonicalOccurrences.find(site =>
          site.deletionProof?.parentBinding)?.usageSiteId ?? null;
      }

      // 8. B9 Verdict Authority Gate
      const result = VerdictAuthority.evaluateProof(reconciledEvidence);
      if (result.auditTrace) {
        result.auditTrace.proofDiagnostics = { obligation: obligationProof, scopeCertificate, sites: siteProofs };
        result.auditTrace.rawOccurrences = discovery.closures.flatMap(closure =>
          closure.occurrences.map(occurrence => ({
            ...occurrence,
            closureName: closure.closureName,
            deduplicationKey: occurrenceKey(occurrence)
          })));
      }
      return result;
    } catch (error: unknown) {
      // Compiler/checker failures are not evidence of absence. The public
      // pipeline is fail-closed and never lets an infrastructure exception
      // escape as an accidental success path.
      const err = error instanceof Error ? error : new Error(String(error));
      return VerdictAuthority.evaluatePreflight('UNKNOWN', 'PIPELINE_RUNTIME', 'ENGINE_RUNTIME_FAILURE', undefined, { name: err.name, message: err.message });
    } finally {
      if (isInternalContext && context) {
        context.dispose();
      }
    }
  }
}
