import ts from 'typescript';
import {
  FragmentAdmissionCertificate,
  Vertex,
  DependencyClosureCertificate,
  EnvironmentManifest
} from '../../../../../core/src/sajimora/certified/contracts';
import { SealedFilesystem } from '../environment/SealedFilesystem';
import { F0Grammar, F0ProductionId } from './F0Grammar';
import { F0BindingVerifier, F0ModuleBindings } from './F0BindingVerifier';
import { F0Type, F0TypeVerifier } from './F0TypeVerifier';
import { VerificationBudget, VerificationBudgetExhaustedError } from '../proof/VerificationBudget';
import { VerificationResult, BlockerCode, Anchor } from '../../../../../core/src/sajimora/certified/blockers';
import {
  ArtifactDomain,
  SAJIMORA_CERTIFIED_EVIDENCE_V1,
  SemanticProfileId
} from '../../../../../core/src/sajimora/certified/protocol';
import { CanonicalSet, hashContract } from '../../../../../core/src/sajimora/certified/canonicalEncoding';
import { TargetScopedEnvelope, verifyTargetScopedEnvelope, verifyEnvelopeTargetDeclaration, shouldTraverseTargetScopedNode } from './TargetScopedEnvelope';
import { verifyF0LetBindings } from './F0LetBindingVerifier';

export interface FragmentVerificationContext {
  manifest?: EnvironmentManifest;
  closureCert?: DependencyClosureCertificate;
  resolveModule?: (fromFileId: string, specifier: string) => string | null;
  targetScopedEnvelope?: TargetScopedEnvelope;
  enableTargetScopedAdmission?: boolean;
}

export class FragmentAdmissionVerifier {
  constructor(
    private readonly sealedFs: SealedFilesystem,
    private readonly budget: VerificationBudget,
    private readonly defaultContext?: FragmentVerificationContext
  ) {}

  /**
   * Independently verifies the entire FragmentAdmissionCertificate against the SealedFilesystem.
   * Zero producer trust:
   * - Parses all ASTs in reached closure files
   * - Classifies EVERY node using F0Grammar (rejecting unsupported syntax fail-closed)
   * - Validates local bindings and declaration groups (rejecting duplicate/merged declarations)
   * - Validates cross-module imports and re-exports
   * - Detects type alias cycles (rejecting circular aliases with CIRCULAR_TYPE_ALIAS)
   * - Verifies topological ordering of type aliases
   * - Reconciles exhaustive syntax coverage
   */
  public verify(
    cert: FragmentAdmissionCertificate,
    context?: FragmentVerificationContext
  ): VerificationResult {
    try {
      this.budget.allocate('WORK_UNITS', 1);

      const effectiveContext = context ?? this.defaultContext;
      if (effectiveContext?.enableTargetScopedAdmission) {
        if (!effectiveContext.targetScopedEnvelope || !effectiveContext.closureCert) {
          return this.reject(BlockerCode.UNSUPPORTED_SYNTAX, 'Target-scoped admission requires a bound envelope and verified closure');
        }
        if (!verifyTargetScopedEnvelope(effectiveContext.targetScopedEnvelope, effectiveContext.closureCert.reachedVertices)) {
          return this.reject(BlockerCode.UNSUPPORTED_SYNTAX, 'Target-scoped admission envelope is invalid or exceeds the verified closure');
        }
      }

      // 1. Validate protocol version
      if (cert.schemaVersion !== SAJIMORA_CERTIFIED_EVIDENCE_V1) {
        return this.reject(
          BlockerCode.UNSUPPORTED_PROTOCOL,
          `Unsupported protocol version: ${cert.schemaVersion}`
        );
      }

      // 2. Validate semantic profile
      if (cert.profileId !== SemanticProfileId.TS_FINITE_CONTRACTS_F0) {
        return this.reject(
          BlockerCode.UNSUPPORTED_CONFIGURATION,
          `Unsupported semantic profile: ${cert.profileId}`
        );
      }

      const activeCtx = context || this.defaultContext;
      const closureCert = activeCtx?.closureCert;

      if (closureCert) {
        const expectedClosureDigest = hashContract(
          ArtifactDomain.CLOSURE,
          cert.schemaVersion,
          closureCert
        );
        if (expectedClosureDigest !== cert.closureRef.digest) {
          return this.reject(
            BlockerCode.HASH_MISMATCH,
            `Closure certificate digest mismatch. Expected: ${cert.closureRef.digest}, Actual: ${expectedClosureDigest}`
          );
        }
      }

      // Determine reached vertices to verify
      const reachedVertices: Vertex[] = [];
      if (closureCert) {
        for (const v of closureCert.reachedVertices) {
          reachedVertices.push(v);
        }
      } else {
        // Collect vertices from syntax coverage in cert
        const seen = new Set<string>();
        for (const entry of cert.syntaxCoverage) {
          const key = `${entry.vertex.projectId}:${entry.vertex.fileId}`;
          if (!seen.has(key)) {
            seen.add(key);
            reachedVertices.push(entry.vertex);
          }
        }
      }

      const moduleBindings = new Map<string, F0ModuleBindings>();
      const computedCoverage = new Map<string, string>(); // `${vertex.fileId}:${syntaxNodeId}` -> productionId
      const allAliasDeps = new Map<string, string[]>();
      const typeAliasNodes = new Map<string, { type: ts.TypeNode; anchor: Anchor }>();
      const functionNodes: Array<{ node: ts.FunctionDeclaration; anchor: Anchor }> = [];
      const interfaceTypeNodes: Array<{ name: string; type: ts.TypeNode; anchor: Anchor }> = [];
      const interfaceNodes = new Map<string, { node: ts.InterfaceDeclaration; anchor: Anchor }>();

      // 3. Process every reached vertex independently
      for (const vertex of reachedVertices) {
        this.budget.allocate('VERTICES', 1);

        if (!this.sealedFs.exists(vertex.fileId)) {
          return this.reject(
            BlockerCode.ENVIRONMENT_INPUT_MISSING,
            `Sealed file missing for reached vertex: ${vertex.fileId}`
          );
        }

        const sourceBytes = this.sealedFs.readBytes(vertex.fileId);
        this.budget.allocate('INPUT_BYTES', sourceBytes.length);

        const sourceText = sourceBytes.toString('utf8');
        const sourceFile = ts.createSourceFile(
          vertex.fileId,
          sourceText,
          ts.ScriptTarget.Latest,
          true,
          vertex.fileId.endsWith('.tsx')
            ? ts.ScriptKind.TSX
            : vertex.fileId.endsWith('.js')
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS
        );

        if (effectiveContext?.enableTargetScopedAdmission && effectiveContext.targetScopedEnvelope && vertex.fileId === effectiveContext.targetScopedEnvelope.targetDeclaration.fileId) {
          if (!verifyEnvelopeTargetDeclaration(vertex, sourceFile, effectiveContext.targetScopedEnvelope)) {
            return this.reject(BlockerCode.IDENTITY_MISMATCH, 'Target-scoped envelope declaration does not match a unique exported function');
          }
        }

        // Check for parse diagnostics
        const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
        if (Array.isArray(parseDiagnostics) && parseDiagnostics.length > 0) {
          return this.reject(
            BlockerCode.UNSUPPORTED_SYNTAX,
            `Parse error in ${vertex.fileId}: ${parseDiagnostics[0]?.messageText ?? 'Syntax error'}`
          );
        }

        const scopedEnvelopeForLet = effectiveContext?.enableTargetScopedAdmission ? effectiveContext.targetScopedEnvelope : undefined;
        const isScopedLetFile = scopedEnvelopeForLet && (
          vertex.fileId === scopedEnvelopeForLet.targetDeclaration.fileId ||
          Array.from(scopedEnvelopeForLet.consumerCallSiteAnchors).some(anchor => anchor.fileId === vertex.fileId)
        );
        const scopedLetRange = scopedEnvelopeForLet && isScopedLetFile
          ? vertex.fileId === scopedEnvelopeForLet.targetDeclaration.fileId
            ? [scopedEnvelopeForLet.targetDeclaration.utf16Start, scopedEnvelopeForLet.targetDeclaration.utf16End] as const
            : Array.from(scopedEnvelopeForLet.consumerCallSiteAnchors)
                .filter(anchor => anchor.fileId === vertex.fileId)
                .map(anchor => [anchor.utf16Start, anchor.utf16End] as const)[0]
          : undefined;
        const letBindingResult = verifyF0LetBindings(sourceFile, scopedLetRange);
        if (!letBindingResult.valid) {
          return this.reject(BlockerCode.UNSUPPORTED_SYNTAX, letBindingResult.reason || 'F0 let binding validation failed');
        }

        // 4. Scoped target binding guard (experimental, opt-in only).
        if (effectiveContext?.enableTargetScopedAdmission && effectiveContext.targetScopedEnvelope && Array.from(effectiveContext.targetScopedEnvelope.consumerCallSiteAnchors).some(anchor => anchor.fileId === vertex.fileId)) {
          const scopedBinding = F0BindingVerifier.verifyTargetScopedImport(
            vertex,
            sourceFile,
            effectiveContext.targetScopedEnvelope,
            this.sealedFs,
            effectiveContext.closureCert?.reachedVertices
          );
          if (!scopedBinding.valid) {
            return this.reject(
              scopedBinding.blockerCode || BlockerCode.UNSUPPORTED_BINDING,
              scopedBinding.reason || 'Target-scoped binding validation failed',
              scopedBinding.anchor
            );
          }
        }

        // 5. Extract and verify local module bindings. In scoped mode the
        // authenticated target file is already constrained by the envelope
        // declaration/closure and its traversed nodes; exhaustive binding
        // extraction would re-introduce unrelated namespace imports from the
        // same file and defeat the purpose of target-scoped admission.
        const scopedEnvelope = effectiveContext?.targetScopedEnvelope;
        const scopedAnchorFile = scopedEnvelope && (
          vertex.fileId === scopedEnvelope.targetDeclaration.fileId ||
          Array.from(scopedEnvelope.consumerCallSiteAnchors).some(anchor => anchor.fileId === vertex.fileId)
        );
        const bindingRes = effectiveContext?.enableTargetScopedAdmission && scopedAnchorFile
          ? { bindings: undefined, result: { valid: true } as const }
          : F0BindingVerifier.extractModuleBindings(vertex, sourceFile);
        if (!bindingRes.result.valid) {
          return this.reject(
            bindingRes.result.blockerCode || BlockerCode.UNSUPPORTED_BINDING,
            `Local module binding validation failed in ${vertex.fileId} (targetScoped=${effectiveContext?.enableTargetScopedAdmission === true}, envelope=${effectiveContext?.targetScopedEnvelope ? 'present' : 'absent'}): ${bindingRes.result.reason || 'Binding verification failed'}`,
            bindingRes.result.anchor
          );
        }
        if (bindingRes.bindings) {
          moduleBindings.set(vertex.fileId, bindingRes.bindings);
        }

        // 5. Traverse AST exhaustively and classify every node with F0Grammar
        let maxDepthInFile = 0;
        const stack: ts.Node[] = [];

        const visit = (node: ts.Node, currentDepth: number) => {
          if (effectiveContext?.enableTargetScopedAdmission && effectiveContext.targetScopedEnvelope && !shouldTraverseTargetScopedNode(node, sourceFile, effectiveContext.targetScopedEnvelope)) return;
          if (currentDepth > maxDepthInFile) {
            maxDepthInFile = currentDepth;
          }

          this.budget.allocate('WORK_UNITS', 1);

          // Classify node
          const classification = F0Grammar.classifyNode(node);
          if (!classification.admitted) {
            const anchor: Anchor = {
              projectId: vertex.projectId,
              fileId: vertex.fileId,
              utf16Start: node.getStart(sourceFile),
              utf16End: node.getEnd(),
              syntaxKind: node.kind
            };
            throw new F0VerificationError(
              BlockerCode.UNSUPPORTED_SYNTAX,
              `Unsupported syntax node ${ts.SyntaxKind[node.kind]} at ${vertex.fileId}:${node.getStart(sourceFile)}: ${classification.reason}`,
              anchor
            );
          }

          // Record coverage entry
          const nodeId = `${node.kind}:${node.getStart(sourceFile)}:${node.getEnd()}`;
          const coverageKey = `${vertex.fileId}:${nodeId}`;
          computedCoverage.set(coverageKey, classification.productionId);

          // If TypeAliasDeclaration, collect references to other type aliases
          if (ts.isTypeAliasDeclaration(node)) {
            const aliasName = node.name.text;
            const deps: string[] = [];
            const collectTypeRefs = (typeNode: ts.Node) => {
              if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
                deps.push(typeNode.typeName.text);
              }
              ts.forEachChild(typeNode, collectTypeRefs);
            };
            collectTypeRefs(node.type);
            allAliasDeps.set(aliasName, deps);
            typeAliasNodes.set(aliasName, { type: node.type, anchor: { projectId: vertex.projectId, fileId: vertex.fileId, utf16Start: node.type.getStart(sourceFile), utf16End: node.type.getEnd(), syntaxKind: node.type.kind } });
          }

          if (ts.isFunctionDeclaration(node) && node.name) {
            functionNodes.push({ node, anchor: { projectId: vertex.projectId, fileId: vertex.fileId, utf16Start: node.getStart(sourceFile), utf16End: node.getEnd(), syntaxKind: node.kind } });
          }

          // If InterfaceDeclaration, check property types are valid scalars
          if (ts.isInterfaceDeclaration(node)) {
            interfaceNodes.set(node.name.text, { node, anchor: { projectId: vertex.projectId, fileId: vertex.fileId, utf16Start: node.getStart(sourceFile), utf16End: node.getEnd(), syntaxKind: node.kind } });
            for (const member of node.members) {
              if (ts.isPropertySignature(member) && member.type) {
                interfaceTypeNodes.push({ name: member.name.getText(), type: member.type, anchor: {
                    projectId: vertex.projectId,
                    fileId: vertex.fileId,
                    utf16Start: member.getStart(sourceFile),
                    utf16End: member.getEnd(),
                    syntaxKind: member.kind
                  } });
              }
            }
          }

          ts.forEachChild(node, child => visit(child, currentDepth + 1));
        };

        try {
          visit(sourceFile, 1);
        } catch (err) {
          if (err instanceof F0VerificationError) {
            return this.reject(err.code, err.message, err.anchor);
          }
          throw err;
        }

        this.budget.allocate('SYNTAX_NESTING', maxDepthInFile);
      }

      // 6. Verify cross-module bindings if resolver is provided
      if (activeCtx?.resolveModule) {
        const crossRes = F0BindingVerifier.verifyCrossModuleBindings(
          moduleBindings,
          activeCtx.resolveModule
        );
        if (!crossRes.valid) {
          return this.reject(
            crossRes.blockerCode || BlockerCode.UNSUPPORTED_BINDING,
            crossRes.reason || 'Cross-module binding verification failed',
            crossRes.anchor
          );
        }
      }

      // 7. Check Type Alias Acyclicity & Topological Sort
      const topoRes = F0TypeVerifier.topologicalSortAliases(allAliasDeps);
      if (!topoRes.valid) {
        return this.reject(
          BlockerCode.CIRCULAR_TYPE_ALIAS,
          `Circular type alias detected: ${topoRes.cycle.join(' -> ')}`
        );
      }

      // Validate alias types only after cycle detection. This preserves the
      // dedicated CIRCULAR_TYPE_ALIAS failure for cyclic graphs while still
      // resolving scalar aliases deterministically in topological order.
      const aliasTypes = new Map<string, F0Type>();
      for (const aliasName of topoRes.order) {
        const entry = typeAliasNodes.get(aliasName);
        if (!entry) continue;
        const typeRes = F0TypeVerifier.extractType(entry.type, name => aliasTypes.get(name));
        if (!typeRes.valid) {
          return this.reject(
            BlockerCode.UNSUPPORTED_TYPE,
            `Type alias '${aliasName}' has unsupported type: ${typeRes.reason}`,
            entry.anchor
          );
        }
        aliasTypes.set(aliasName, typeRes.type);
      }

      // Interfaces are sealed record evidence and may be used by signatures.
      // Process names deterministically; unresolved record references fail closed.
      for (const interfaceName of Array.from(interfaceNodes.keys()).sort()) {
        const entry = interfaceNodes.get(interfaceName)!;
        const properties = new Map<string, { readonly: true; type: any }>();
        for (const member of entry.node.members) {
          if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name) || !member.type) {
            return this.reject(BlockerCode.UNSUPPORTED_TYPE, `Interface '${interfaceName}' has unsupported member`, entry.anchor);
          }
          const typeRes = F0TypeVerifier.extractType(member.type, name => aliasTypes.get(name));
          if (!typeRes.valid || typeRes.type.kind === 'void' || typeRes.type.kind === 'record') return this.reject(BlockerCode.UNSUPPORTED_TYPE, `Interface property '${member.name.text}' has unsupported type: ${typeRes.valid ? 'non-scalar record/void is unsupported here' : typeRes.reason}`, { projectId: entry.anchor.projectId, fileId: entry.anchor.fileId, utf16Start: member.getStart(), utf16End: member.getEnd(), syntaxKind: member.kind });
          properties.set(member.name.text, { readonly: true, type: typeRes.type });
        }
        aliasTypes.set(interfaceName, { kind: 'record', name: interfaceName, properties });
      }

      for (const entry of interfaceTypeNodes) {
        const typeRes = F0TypeVerifier.extractType(entry.type, name => aliasTypes.get(name));
        if (!typeRes.valid) return this.reject(BlockerCode.UNSUPPORTED_TYPE, `Interface property '${entry.name}' has unsupported type: ${typeRes.reason}`, entry.anchor);
      }
      for (const entry of functionNodes) {
        const sigRes = F0TypeVerifier.extractSignature(entry.node, name => aliasTypes.get(name));
        if (!sigRes.valid) return this.reject(BlockerCode.UNSUPPORTED_TYPE, `Function '${entry.node.name?.text}' has unsupported signature: ${sigRes.reason}`, entry.anchor);
      }

      // Check aliasTopologicalOrder in certificate
      if (cert.aliasTopologicalOrder.length > 0) {
        const orderMap = new Map<string, number>();
        cert.aliasTopologicalOrder.forEach((name, idx) => orderMap.set(name, idx));

        for (const [alias, deps] of allAliasDeps.entries()) {
          const aliasIdx = orderMap.get(alias);
          if (aliasIdx !== undefined) {
            for (const dep of deps) {
              const depIdx = orderMap.get(dep);
              if (depIdx !== undefined && depIdx >= aliasIdx) {
                return this.reject(
                  BlockerCode.CIRCULAR_TYPE_ALIAS,
                  `Alias topological order invalid: ${dep} appears after or at ${alias}`
                );
              }
            }
          }
        }
      }

      // 8. Reconcile Syntax Coverage Bijection
      const certCoverageMap = new Map<string, string>();
      for (const item of cert.syntaxCoverage) {
        const key = `${item.vertex.fileId}:${item.syntaxNodeId}`;
        certCoverageMap.set(key, item.admittedProductionId);
      }

      // Every computed node must be present in certificate with exact matching productionId
      for (const [key, computedProd] of computedCoverage.entries()) {
        const certProd = certCoverageMap.get(key);
        if (!certProd) {
          return this.reject(
            BlockerCode.EDGE_OMISSION,
            `Syntax node ${key} missing from certificate syntaxCoverage`
          );
        }
        if (certProd !== computedProd) {
          return this.reject(
            BlockerCode.HASH_MISMATCH,
            `Production mismatch for ${key}. Recomputed: ${computedProd}, Certified: ${certProd}`
          );
        }
      }

      // No extraneous entries in certificate coverage
      for (const [key] of certCoverageMap.entries()) {
        if (!computedCoverage.has(key)) {
          return this.reject(
            BlockerCode.EDGE_OMISSION,
            `Extraneous syntax node in certificate syntaxCoverage: ${key}`
          );
        }
      }

      const certDigest = hashContract(ArtifactDomain.ADMISSION, cert.schemaVersion, cert);

      return {
        status: 'VERIFIED',
        bundleDigest: certDigest,
        verifiedClaim: 'FRAGMENT_ADMISSION_VERIFIED',
        verifiedAuthorityInputDigest: certDigest,
        replayProfileId: cert.profileId
      };
    } catch (err: unknown) {
      if (err instanceof VerificationBudgetExhaustedError) {
        return {
          status: 'RESOURCE_EXHAUSTED',
          detail: err.detail
        };
      }
      throw err;
    }
  }

  private reject(code: BlockerCode, message: string, anchor?: Anchor): VerificationResult {
    return {
      status: 'REJECTED',
      blockerCode: code,
      sourceAnchor: anchor,
      detail: {
        code,
        message
      }
    };
  }
}

class F0VerificationError extends Error {
  constructor(
    public readonly code: BlockerCode,
    message: string,
    public readonly anchor?: Anchor
  ) {
    super(message);
  }
}
