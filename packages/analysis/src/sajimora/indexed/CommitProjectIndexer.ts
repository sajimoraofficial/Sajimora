import * as path from 'node:path';
import * as ts from 'typescript';
import { randomUUID } from 'node:crypto';
import { binaryCompare, canonicalJson, ProjectIdentity } from '@sajimora/core';
import { GitRepository } from '../snapshots/GitRepository';
import { GitObjectReader } from '../snapshots/GitObjectReader';
import { SnapshotFilesystem } from '../snapshots/SnapshotFilesystem';
import { TypeScriptV1Adapter } from '../languages/typescript/TypeScriptV1Adapter';
import { TypeScriptProgramBuilder, normalizeToTrackedRelative } from '../languages/typescript/programs/TypeScriptProgramBuilder';
import { TypeScriptLanguageAdapter } from '../languages/typescript/TypeScriptLanguageAdapter';
import { TypeScriptTypeIRExtractor } from '../languages/typescript/ir/TypeScriptTypeIRExtractor';
import {
  INDEX_EXTRACTOR_VERSION, INDEX_PROOF_RULES_VERSION, INDEX_SCHEMA_VERSION,
  CommitIndexIdentity, createGenerationIdentity, hashCanonical, sameCommitIdentity
} from './IndexIdentity';
import {
  BoundCompletenessCertificate, CommitManifest, GenerationIndexDatabase, ProjectManifest,
  calculateCertificateHash, calculateCommitManifestHash, calculateGenerationContentHash,
  calculateProjectManifestHash
} from './GenerationIndexDatabase';
import { IndexedConsumerFact, IndexedDeclarationFact, IndexedDiagnosticFact, IndexedFileFact, IndexedModuleEdgeFact } from './IndexedFacts';
import { ProjectFactSpool, ProjectFactTicket } from './ProjectFactSpool';
import { DependencyLookupRecorder } from './DependencyLookupReceipt';

export interface CommitProjectIndexRequest {
  readonly repositoryPath: string;
  readonly commitSha: string;
  readonly database: GenerationIndexDatabase;
  readonly dependencyRoot?: string;
  readonly onProgress?: (event: { readonly phase: 'PROGRAM_START' | 'EXTRACT_START' | 'FILES_DISCOVERED' |
    'DECLARATIONS_DONE' | 'CONSUMERS_DONE' | 'DIAGNOSTICS_DONE' | 'ORDERING_START' | 'EXTRACT_DONE';
    readonly projectId: string; readonly rootFileCount?: number }) => void;
}

export type CommitProjectIndexResult =
  | { readonly status: 'PUBLISHED'; readonly repositoryId: string; readonly commitSha: string; readonly generationId: string; readonly manifestHash: string }
  | { readonly status: 'REUSED'; readonly repositoryId: string; readonly commitSha: string; readonly generationId: string; readonly manifestHash: string }
  | { readonly status: 'PARTIAL' | 'FAILED'; readonly repositoryId: string; readonly commitSha: string; readonly blockers: readonly string[] };

interface ExtractedProjectFacts {
  readonly files: IndexedFileFact[];
  readonly declarations: IndexedDeclarationFact[];
  readonly consumers: IndexedConsumerFact[];
  readonly moduleEdges: IndexedModuleEdgeFact[];
  readonly diagnostics: IndexedDiagnosticFact[];
  readonly blockers: string[];
}

const slash = (value: string) => value.replace(/\\/g, '/');

export class CommitProjectIndexer {
  public indexCommit(request: CommitProjectIndexRequest): CommitProjectIndexResult {
    const repo = new GitRepository(request.repositoryPath);
    repo.validate();
    const repositoryId = repo.repositoryId();
    let cleanup: (() => void) | undefined;
    try {
      const adapter = new TypeScriptV1Adapter();
      const published = request.database.getPublishedManifest(repositoryId, request.commitSha, INDEX_SCHEMA_VERSION);
      if (published) {
        // A warm lookup reads only the toolchain declaration and lockfiles
        // from immutable Git objects. It neither materializes a checkout nor
        // constructs a Program.
        const reader = new GitObjectReader(repo);
        const allEntries = reader.entries(request.commitSha);
        const entries = allEntries.filter(entry => entry.path === 'package.json' ||
          /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(entry.path));
        const bytes = reader.batchBlobs(entries.map(entry => entry.objectId));
        const relevant = new Map(entries.map(entry => [entry.path, bytes.get(entry.objectId)?.toString('utf8')]));
        if (entries.some(entry => relevant.get(entry.path) === undefined)) {
          throw new Error('INDEX_WARM_INPUT_BLOB_MISSING');
        }
        const toolchainFingerprint = hashCanonical('SAJIMORA_TOOLCHAIN_V1',
          adapter.toolchain({ trackedFiles: entries.map(entry => entry.path), readTextFile: file => relevant.get(file) }));
        let reusableEnvironment = true;
        if (request.dependencyRoot) {
          if (!published.dependencyLookupReceipt) reusableEnvironment = false;
          else {
            try { DependencyLookupRecorder.verify(request.dependencyRoot, published.dependencyLookupReceipt); }
            catch { reusableEnvironment = false; }
          }
        }
        const externalFingerprint = request.dependencyRoot && published.dependencyLookupReceipt
          ? published.dependencyLookupReceipt.fingerprint : 'NONE';
        const dependencyFingerprint = hashCanonical('SAJIMORA_DEPENDENCIES_V2', {
          lockfiles: entries.filter(entry => entry.path !== 'package.json').map(entry => entry.path).sort()
            .map(file => [file, relevant.get(file)]), externalFingerprint
        });
        const currentIdentity: CommitIndexIdentity = {
          ...published.identity, schemaVersion: INDEX_SCHEMA_VERSION,
          extractorVersion: INDEX_EXTRACTOR_VERSION, proofRulesVersion: INDEX_PROOF_RULES_VERSION,
          repositoryId, commitSha: request.commitSha, toolchainFingerprint, dependencyFingerprint,
          externalDependencyFingerprint: externalFingerprint
        };
        if (reusableEnvironment && sameCommitIdentity(published.identity, currentIdentity)) {
          return { status: 'REUSED', repositoryId, commitSha: request.commitSha,
            generationId: published.generationId, manifestHash: published.manifestHash };
        }
      }
      const snapshot = new SnapshotFilesystem(new GitObjectReader(repo)).materialize(request.commitSha);
      cleanup = () => snapshot.cleanup();
      const dependencyLookupRecorder = request.dependencyRoot
        ? new DependencyLookupRecorder(request.dependencyRoot, snapshot.root, snapshot.trackedFiles) : undefined;
      const spool = new ProjectFactSpool<ExtractedProjectFacts>();
      cleanup = () => { spool.close(); snapshot.cleanup(); };
      const toolchain = adapter.toolchain(snapshot);
      const toolchainFingerprint = hashCanonical('SAJIMORA_TOOLCHAIN_V1', toolchain);
      const extractedProjects: Array<{
        identity: ProjectIdentity;
        options: ts.CompilerOptions;
        facts: ProjectFactTicket;
      }> = [];
      const build = new TypeScriptProgramBuilder().build({
        root: snapshot.root,
        trackedFiles: snapshot.trackedFiles,
        revision: { repositoryId, commitSha: request.commitSha },
        toolchain,
        adapterId: adapter.descriptor.id,
        adapterVersion: adapter.descriptor.version,
        dependencyRoot: request.dependencyRoot,
        dependencyLookupRecorder,
        readTextFile: file => snapshot.readTextFile(file),
        retainPrograms: false,
        onProjectStart: (configFile, rootFileCount) => request.onProgress?.({ phase: 'PROGRAM_START',
          projectId: configFile ?? '<implicit>', rootFileCount }),
        onProject: (project, diagnostics) => {
          if (diagnostics.length > 0) {
            const counts = new Map<number, number>();
            for (const diagnostic of diagnostics) counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
            const codes = [...counts].sort((a, b) => a[0] - b[0]).map(([code, count]) => `${code}=${count}`).join(',');
            throw new Error(`INDEX_PROJECT_DIAGNOSTICS_PRESENT:${project.identity.projectId}:${diagnostics.length}:${codes}`);
          }
          request.onProgress?.({ phase: 'EXTRACT_START', projectId: project.identity.projectId });
          extractedProjects.push({ identity: project.identity, options: project.options,
            facts: spool.write(this.extractProject(project.program, project.identity.projectId,
              snapshot.root, snapshot.trackedFiles, phase => request.onProgress?.({
                phase, projectId: project.identity.projectId
              }))) });
          request.onProgress?.({ phase: 'EXTRACT_DONE', projectId: project.identity.projectId });
        }
      });

      const dependencyLookupReceipt = dependencyLookupRecorder?.finish();
      const externalFingerprint = dependencyLookupReceipt?.fingerprint ?? 'NONE';
      const dependencyFingerprint = hashCanonical('SAJIMORA_DEPENDENCIES_V2', {
        lockfiles: snapshot.trackedFiles.filter(file => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file))
          .sort().map(file => [file, snapshot.readTextFile(file)]), externalFingerprint
      });

      const configFingerprint = hashCanonical('SAJIMORA_CONFIG_SET_V1', extractedProjects.map(project => ({
        identity: project.identity,
        options: project.options
      })).sort((a, b) => binaryCompare(a.identity.projectId, b.identity.projectId)));
      const identity: CommitIndexIdentity = {
        schemaVersion: INDEX_SCHEMA_VERSION,
        extractorVersion: INDEX_EXTRACTOR_VERSION,
        proofRulesVersion: INDEX_PROOF_RULES_VERSION,
        repositoryId,
        commitSha: request.commitSha,
        toolchainFingerprint,
        configFingerprint,
        dependencyFingerprint,
        externalDependencyFingerprint: externalFingerprint
      };
      // A failed/partial attempt must not reserve the deterministic generation
      // id forever. Published commits are reused above; retries get a new id.
      const generation = createGenerationIdentity(identity, randomUUID());
      request.database.beginGeneration(generation);

      const blockers: string[] = [];
      if (build.status !== 'BUILT') blockers.push(`PROGRAM_STATUS_${build.status}`);
      if (build.universe.unreadableFiles.length > 0) blockers.push('UNREADABLE_PROJECT_INPUTS');
      if (build.universe.parseFailures.length > 0) blockers.push('PROJECT_DIAGNOSTICS_PRESENT');

      const artifactHashes: string[] = [];
      const projectManifests: ProjectManifest[] = [];
      const certificates: BoundCompletenessCertificate[] = [];

      for (const project of [...extractedProjects].sort((a, b) => binaryCompare(a.identity.projectId, b.identity.projectId))) {
        const extracted = spool.read(project.facts);
        blockers.push(...extracted.blockers.map(blocker => `${project.identity.projectId}:${blocker}`));
        const projectArtifactHashes: string[] = [];
        const counts: Record<string, number> = {};
        const persist = (kind: string, semanticId: string, payload: unknown): void => {
          const hash = request.database.putArtifact(generation.generationId, project.identity.projectId, semanticId, kind, payload);
          projectArtifactHashes.push(hash);
          artifactHashes.push(hash);
          counts[kind] = (counts[kind] ?? 0) + 1;
        };
        for (const fact of extracted.files) persist('FILE', fact.normalizedPath, fact);
        for (const fact of extracted.declarations) persist('DECLARATION', fact.declarationId, fact);
        for (const fact of extracted.consumers) persist('CONSUMER', fact.occurrenceId, fact);
        for (const fact of extracted.moduleEdges) persist('MODULE_EDGE', `${fact.sourceFile}:${fact.edgeKind}:${fact.moduleSpecifier}`, fact);
        for (const fact of extracted.diagnostics) persist('DIAGNOSTIC', hashCanonical('DIAGNOSTIC_ID', fact), fact);

        const roots = {
          rootFilesHash: hashCanonical('ROOT_FILES', project.identity.rootFiles),
          includedFilesHash: hashCanonical('INCLUDED_FILES', extracted.files.map(f => f.normalizedPath).sort()),
          projectReferencesHash: hashCanonical('PROJECT_REFERENCES', project.identity.references),
          moduleGraphHash: hashCanonical('MODULE_GRAPH', extracted.moduleEdges),
          declarationRootHash: hashCanonical('DECLARATIONS', extracted.declarations.map(f => [f.declarationId, f.contractHash]).sort()),
          consumerRootHash: hashCanonical('CONSUMERS', extracted.consumers.map(f => [f.occurrenceId, f.targetDeclarationId, f.historicalUsage.usageHash]).sort()),
          typeIRRootHash: hashCanonical('TYPE_IR', extracted.declarations.map(f => f.contract.contractType.irContentHash).sort()),
          diagnosticRootHash: hashCanonical('DIAGNOSTICS', extracted.diagnostics)
        };
        const projectIdentity = {
          ...identity,
          projectId: project.identity.projectId,
          projectContextFingerprint: hashCanonical('PROJECT_CONTEXT', { identity: project.identity, options: project.options })
        };

        // The certificate is completed after the generation content root is known.
        projectManifests.push({
          identity: projectIdentity,
          generationId: generation.generationId,
          projectManifestHash: '',
          ...roots,
          certificateHash: '',
          artifactHashes: [...new Set(projectArtifactHashes)].sort(),
          artifactCounts: counts
        });
        spool.discard(project.facts);
      }

      if (blockers.length > 0) {
        return { status: 'PARTIAL', repositoryId, commitSha: request.commitSha, blockers: [...new Set(blockers)].sort() };
      }

      const uniqueArtifactHashes = [...new Set(artifactHashes)].sort();
      const generationContentHash = calculateGenerationContentHash(identity, uniqueArtifactHashes);
      for (let index = 0; index < projectManifests.length; index++) {
        const project = projectManifests[index];
        const certBase = {
          generationId: generation.generationId,
          generationContentHash,
          repositoryId,
          commitSha: request.commitSha,
          projectId: project.identity.projectId,
          includedFilesHash: project.includedFilesHash,
          projectReferencesHash: project.projectReferencesHash,
          moduleGraphHash: project.moduleGraphHash,
          declarationRootHash: project.declarationRootHash,
          consumerRootHash: project.consumerRootHash,
          diagnosticRootHash: project.diagnosticRootHash,
          supportedRelationshipClasses: ['VALUE_REFERENCE', 'TYPE_REFERENCE', 'IMPORT', 'EXPORT'],
          unsupportedRelationshipClasses: [],
          blockers: [],
          isComplete: true
        };
        const certificate: BoundCompletenessCertificate = { ...certBase, certificateHash: calculateCertificateHash(certBase as any) };
        request.database.putCertificate(certificate);
        certificates.push(certificate);
        const withCertificate = { ...project, certificateHash: certificate.certificateHash };
        const finalized: ProjectManifest = { ...withCertificate, projectManifestHash: calculateProjectManifestHash(withCertificate) };
        request.database.putProjectManifest(finalized);
        projectManifests[index] = finalized;
      }

      const commitBase = {
        identity,
        generationId: generation.generationId,
        generationContentHash,
        projectManifestHashes: projectManifests.map(project => project.projectManifestHash).sort(),
        artifactHashes: uniqueArtifactHashes,
        certificateHashes: certificates.map(cert => cert.certificateHash).sort(),
        ...(dependencyLookupReceipt ? { dependencyLookupReceipt } : {})
      };
      const manifest: CommitManifest = { ...commitBase, manifestHash: calculateCommitManifestHash(commitBase) };
      request.database.publish(manifest);
      return { status: 'PUBLISHED', repositoryId, commitSha: request.commitSha, generationId: generation.generationId, manifestHash: manifest.manifestHash };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { status: reason.startsWith('INDEX_PROJECT_DIAGNOSTICS_PRESENT:') || reason.startsWith('DEPENDENCY_')
        ? 'PARTIAL' : 'FAILED',
        repositoryId, commitSha: request.commitSha, blockers: [reason] };
    } finally {
      cleanup?.();
    }
  }

  private extractProject(program: ts.Program, projectId: string, root: string, trackedFiles: readonly string[],
    onStage?: (phase: 'FILES_DISCOVERED' | 'DECLARATIONS_DONE' | 'CONSUMERS_DONE' |
      'DIAGNOSTICS_DONE' | 'ORDERING_START') => void) {
    const checker = program.getTypeChecker();
    const language = new TypeScriptLanguageAdapter();
    const files: IndexedFileFact[] = [];
    const declarations: IndexedDeclarationFact[] = [];
    const consumers: IndexedConsumerFact[] = [];
    const moduleEdges: IndexedModuleEdgeFact[] = [];
    const diagnostics: IndexedDiagnosticFact[] = [];
    const blockers: string[] = [];
    const declarationBySymbol = new Map<ts.Symbol, string>();

    const sources = program.getSourceFiles().filter(source => normalizeToTrackedRelative(source.fileName, root, trackedFiles) !== null)
      .sort((a, b) => { const fa = slash(a.fileName); const fb = slash(b.fileName); return fa < fb ? -1 : fa > fb ? 1 : 0; });
    onStage?.('FILES_DISCOVERED');
    for (const source of sources) {
      const filePath = normalizeToTrackedRelative(source.fileName, root, trackedFiles)!;
      files.push({ projectId, normalizedPath: filePath, sourceHash: hashCanonical('SOURCE_TEXT', source.text), isDeclarationFile: source.isDeclarationFile });
      for (const statement of source.statements) {
        if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          moduleEdges.push({ projectId, sourceFile: filePath, moduleSpecifier: statement.moduleSpecifier.text, edgeKind: ts.isImportDeclaration(statement) ? 'IMPORT' : 'EXPORT' });
        }
      }
      const visitDeclaration = (node: ts.Node): void => {
        const named = (node as ts.NamedDeclaration).name;
        if (named && ts.isIdentifier(named) && this.isContractDeclaration(node)) {
          try {
            const contract = language.extractContract(node, { parentProgram: program, candidateProgram: program });
            const declarationId = `${projectId}:${contract.symbolId}`;
            let symbol = checker.getSymbolAtLocation(named);
            if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
            if (symbol) declarationBySymbol.set(symbol, declarationId);
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            // For VariableDeclaration, the `export` modifier lives on the grandparent VariableStatement,
            // not on the VariableDeclaration node itself.
            const modifierOwner = ts.isVariableDeclaration(node) && node.parent && ts.isVariableDeclarationList(node.parent) && node.parent.parent ? node.parent.parent : node;
            const modifiers = ts.canHaveModifiers(modifierOwner) ? ts.getModifiers(modifierOwner) : undefined;
            declarations.push({
              projectId, declarationId, persistentSymbolId: declarationId, localName: named.text,
              qualifiedName: `${filePath}#${named.text}`, kind: contract.declarationKind, filePath,
              start: node.getStart(source), end: node.getEnd(), line,
              exported: Boolean(modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)),
              contract, contractHash: contract.contractHash
            });
          } catch (error) {
            blockers.push(`DECLARATION_EXTRACTION_FAILED:${filePath}:${node.getStart(source)}:${error instanceof Error ? error.message : String(error)}`);
          }
        }
        ts.forEachChild(node, visitDeclaration);
      };
      visitDeclaration(source);
    }
    onStage?.('DECLARATIONS_DONE');

    for (const source of sources) {
      const filePath = normalizeToTrackedRelative(source.fileName, root, trackedFiles)!;
      const visitUsage = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && !this.isDeclarationName(node)) {
          let symbol = checker.getSymbolAtLocation(node);
          if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
          const targetDeclarationId = symbol ? declarationBySymbol.get(symbol) : undefined;
          if (targetDeclarationId) {
            try {
              const usageNode = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : node;
              const usageRole = ts.isCallExpression(usageNode) ? 'CALL_SITE' : this.isTypePosition(node) ? 'TYPE_ANNOTATION' : 'REFERENCE_OCCURRENCE';
              const historicalUsage = language.extractUsageContract(usageNode, { parentProgram: program });
              const location = source.getLineAndCharacterOfPosition(node.getStart(source));
              const occurrenceId = hashCanonical('OCCURRENCE_ID', { projectId, filePath, start: node.getStart(source), end: node.getEnd(), targetDeclarationId, usageRole });
              consumers.push({ projectId, occurrenceId, targetDeclarationId, filePath, start: node.getStart(source), end: node.getEnd(), line: location.line + 1, column: location.character + 1, usageRole, historicalUsage: { ...historicalUsage, usageRole } });
            } catch (error) {
              blockers.push(`USAGE_EXTRACTION_FAILED:${filePath}:${node.getStart(source)}:${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        ts.forEachChild(node, visitUsage);
      };
      visitUsage(source);
    }
    onStage?.('CONSUMERS_DONE');

    const allDiagnostics: readonly ts.Diagnostic[] = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
    for (const diagnostic of allDiagnostics) {
      const location = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
      diagnostics.push({ projectId, code: diagnostic.code, category: ts.DiagnosticCategory[diagnostic.category], file: diagnostic.file ? normalizeToTrackedRelative(diagnostic.file.fileName, root, trackedFiles) : null, line: location ? location.line + 1 : null, character: location ? location.character + 1 : null, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') });
    }
    onStage?.('DIAGNOSTICS_DONE');
    onStage?.('ORDERING_START');
    const order = <T>(values: T[]) => values.sort((a, b) => {
      const ca = canonicalJson(a);
      const cb = canonicalJson(b);
      return ca < cb ? -1 : ca > cb ? 1 : 0;
    });
    return { files: order(files), declarations: order(declarations), consumers: order(consumers), moduleEdges: order(moduleEdges), diagnostics: order(diagnostics), blockers: [...new Set(blockers)].sort() };
  }

  private isContractDeclaration(node: ts.Node): boolean {
    return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) ||
      ts.isVariableDeclaration(node);
  }

  private isDeclarationName(node: ts.Identifier): boolean {
    return Boolean((node.parent as ts.NamedDeclaration).name === node);
  }

  private isTypePosition(node: ts.Node): boolean {
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
      if (ts.isTypeNode(current)) return true;
      if (ts.isStatement(current) || ts.isExpressionStatement(current)) return false;
    }
    return false;
  }
}
