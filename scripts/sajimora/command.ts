import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { binaryCompare, LanguageAdapterRegistry } from '@sajimora/core';
import {
  GitRepository,
  RevisionResolver,
  GitObjectReader,
  SnapshotFilesystem,
  TypeScriptV1Adapter,
  DualTypeScriptProgramBuilder,
  GitDiffReader,
  TypeScriptCrossVersionIdentityAnalyzer,
  Phase4EvidenceAssembler,
  AdvisoryTypeScriptImpactAnalyzer,
  AdvisoryJavaImpactAnalyzer,
  JavaSnapshotProvider,
  JavaSealedCompilerHost,
  JavaWireModelEngine,
  ArtifactComparisonEngine,
  sealEnvelope,
  parseEnvelope,
  verifyEnvelopeIntegrity,
  ARTIFACT_ENVELOPE_VERSION,
  SCHEMA_VERSION,
  ContractArtifactEnvelope,
  BackendContractPayload,
  FrontendContractPayload,
  FrontendClientContract,
  EndpointContract,
  WireType,
  AnalysisBlocker,
  extractSnapshotJacksonConfig,
  admitArtifact,
  ArtifactTrustPolicy
} from '@sajimora/analysis';
import { deriveRealDiffObligations } from '../campaign/realDiffObligationAdapter';
import { AnalyzeArguments } from './arguments';
import { loadSajimoraConfig } from './config';
import { Phase1Artifact, Phase4ConsumerArtifact, SerializedWitness, SerializedBlocker, serializePhase1Artifact, writeArtifactAtomically } from './artifact';
import { SajimoraExecutionError } from './errors';
import { CompatibilityResult } from '@sajimora/core';
import { runProductionAnalyzeCommand } from './productionCommand';

export interface CommandIO { stdout(text: string): void; stderr(text: string): void }

function normalizeWireType(wt: any): WireType {
  if (!wt || typeof wt !== 'object') return { kind: 'UNKNOWN', reason: 'Invalid wire type' };
  if (wt.kind === 'OBJECT' && Array.isArray(wt.properties)) {
    return {
      ...wt,
      properties: wt.properties.map((p: any) => ({
        wireName: p.wireName ?? '',
        type: normalizeWireType(p.type),
        optional: Boolean(p.optional),
        nullable: Boolean(p.nullable),
        validationConstraints: Array.isArray(p.validationConstraints) ? p.validationConstraints : []
      }))
    };
  }
  if (wt.kind === 'ARRAY' && wt.elementType) {
    return {
      ...wt,
      elementType: normalizeWireType(wt.elementType)
    };
  }
  return wt as WireType;
}

export function loadFrontendEnvelope(filePath: string, trustPolicy?: ArtifactTrustPolicy): ContractArtifactEnvelope {
  const content = fs.readFileSync(path.resolve(filePath), 'utf8');
  let envelope: ContractArtifactEnvelope;
  try {
    envelope = parseEnvelope(content);
  } catch (e) {
    throw new SajimoraExecutionError(`Failed to parse frontend contract at ${filePath}: ${e instanceof Error ? e.message : String(e)}`, 2, 'ANALYSIS_INPUT_FAILURE');
  }

  if (envelope.kind !== 'FRONTEND_CONTRACT') {
    throw new SajimoraExecutionError(`Expected contract kind FRONTEND_CONTRACT, but found ${envelope.kind} at ${filePath}`, 2, 'ANALYSIS_INPUT_FAILURE');
  }

  if (!verifyEnvelopeIntegrity(envelope)) {
    throw new SajimoraExecutionError(`Frontend contract at ${filePath} failed integrity verification (SHA-256 digest mismatch).`, 2, 'ANALYSIS_INPUT_FAILURE');
  }

  if (trustPolicy) {
    try {
      admitArtifact(envelope, trustPolicy);
    } catch (e) {
      throw new SajimoraExecutionError(`Artifact admission failed for ${filePath}: ${e instanceof Error ? e.message : String(e)}`, 2, 'ANALYSIS_INPUT_FAILURE');
    }
  }

  return envelope;
}

function formatAdvisoryReportText(
  lang: string,
  verdict: string,
  providers: readonly any[],
  consumers: readonly any[],
  impacts: readonly any[],
  frontend?: {
    path: string;
    contractsCount: number;
    findings: readonly any[];
  },
  inRepoResult?: any
): string {
  const lines: string[] = [];
  lines.push('================================================================');
  lines.push(`          SAJIMORA ${lang.toUpperCase()} ADVISORY IMPACT REPORT           `);
  lines.push('================================================================');
  lines.push('');
  lines.push(` Advisory Verdict:      ${verdict}`);
  if (frontend) {
    lines.push(` Frontend Contract:     ${frontend.path}`);
    lines.push(` Downstream Consumers:  ${frontend.contractsCount} client contract(s) checked`);
    if (frontend.findings.length > 0) {
      lines.push(` Frontend Impacts:      ${frontend.findings.length} breaking downstream consumer site(s)`);
    } else {
      lines.push(` Frontend Impacts:      0 breaking downstream consumer sites (all preserved)`);
    }
  }
  lines.push(` Changed Provider APIs: ${providers.length}`);
  lines.push(` In-Repo Consumers:     ${consumers.length}`);
  lines.push(` In-Repo Impacted Sites:${impacts.length}`);
  const breaking = impacts.filter((i: any) => i.classification === 'NEWLY_FAILING' || i.classification === 'LIKELY_BROKEN');
  if (breaking.length > 0) {
    lines.push(` Breaking Changes:      ${breaking.length} breaking downstream consumer site(s)`);
  }
  if (verdict === 'INCONCLUSIVE') {
    const abstentionCodes: readonly string[] = inRepoResult?.abstentionCodes ?? [];
    if (abstentionCodes.length > 0) {
      lines.push(` Attributed Codes:      ${abstentionCodes.join(', ')}`);
    }
    const unres = impacts.filter((i: any) => i.classification === 'UNRESOLVED' || i.classification === 'ADVISORY_ONLY_LIMIT');
    if (unres.length > 0) {
      lines.push(` Attributed Reasons:    ${unres.length} site(s) with actionable diagnostic`);
    }
  }
  lines.push('');

  if (frontend && frontend.findings.length > 0) {
    lines.push('----------------------------------------------------------------');
    lines.push(' Downstream Frontend Impacts (from frontend contract):');
    for (const f of frontend.findings.slice(0, 10)) {
      const loc = f.typescriptClient ? `${f.typescriptClient.file}:${f.typescriptClient.line}` : (f.consumerFile ?? 'frontend');
      const ep = f.endpoint ? `[${f.endpoint.method} ${f.endpoint.path}]` : '';
      const change = f.change ? `${f.change.before ?? 'base'} -> ${f.change.after ?? 'candidate'}` : '';
      const hint = f.repairHint ? ` (${f.repairHint})` : '';
      lines.push(`   • ${loc} ${ep}: ${change}${hint}`);
    }
    if (frontend.findings.length > 10) lines.push(`   • ... and ${frontend.findings.length - 10} more`);
    lines.push('');
  }

  if (providers.length > 0) {
    lines.push('----------------------------------------------------------------');
    lines.push(' Changed Provider APIs:');
    for (const p of providers.slice(0, 10)) {
      lines.push(`   • [${p.change ?? 'CHANGED'}] ${p.id ?? p.name ?? p.fqcn}`);
    }
    if (providers.length > 10) lines.push(`   • ... and ${providers.length - 10} more`);
  }

  if (breaking.length > 0) {
    lines.push('');
    lines.push('----------------------------------------------------------------');
    lines.push(' Breaking Downstream Impacts:');
    for (const b of breaking.slice(0, 10)) {
      const loc = b.line ? `${b.consumerFile}:${b.line}` : (b.consumer ? `${b.consumer.file}:${b.consumer.line}` : (b.consumerFile ?? 'unknown'));
      const diagMsg = b.diagnostics?.[0]?.message ?? b.rationale ?? 'Incompatible API change';
      lines.push(`   • ${loc} -> ${diagMsg}`);
    }
    if (breaking.length > 10) lines.push(`   • ... and ${breaking.length - 10} more`);
  }

  if (verdict === 'INCONCLUSIVE') {
    const unres = impacts.filter((i: any) => i.classification === 'UNRESOLVED' || i.classification === 'ADVISORY_ONLY_LIMIT');
    if (unres.length > 0) {
      lines.push('');
      lines.push('----------------------------------------------------------------');
      lines.push(` Attributed Reasons (${unres.length} sites):`);
      for (const u of unres.slice(0, 10)) {
        const loc = u.line ? `${u.consumerFile}:${u.line}` : (u.consumer ? `${u.consumer.file}:${u.consumer.line}` : (u.consumerFile ?? 'unknown'));
        lines.push(`   • ${loc} -> ${u.rationale ?? 'Unresolved receiver or boundary'}`);
      }
      if (unres.length > 10) lines.push(`   • ... and ${unres.length - 10} more`);
    }
  }

  lines.push('');
  lines.push('================================================================');
  return lines.join('\n');
}

export async function runAdvisoryAnalyzeCommand(
  args: AnalyzeArguments,
  io: CommandIO = { stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) }
): Promise<void> {
  const started = Date.now();
  let parentSnapshot: ReturnType<SnapshotFilesystem['materialize']> | undefined;
  let candidateSnapshot: ReturnType<SnapshotFilesystem['materialize']> | undefined;
  try {
    let repository: GitRepository;
    let revisions: ReturnType<RevisionResolver['resolve']>;
    let before: string;
    try {
      repository = new GitRepository(args.repo);
      repository.validate();
      before = repository.statusFingerprint();

      let candidateSha = args.candidate;
      try {
        candidateSha = repository.text(['rev-parse', '--verify', `${args.candidate}^{commit}`]).trim();
      } catch (err) {
        throw new SajimoraExecutionError(`Could not resolve candidate revision: ${args.candidate}`, 3, 'GIT_SNAPSHOT_FAILURE', { cause: err });
      }

      let parentShaOrRef = args.parent;
      if (args.parent === 'HEAD~1') {
        try {
          const parentLine = repository.text(['rev-list', '--parents', '-n', '1', candidateSha]).trim();
          const parents = parentLine.split(/\s+/).slice(1);
          if (parents.length > 0) {
            parentShaOrRef = parents[0];
          }
        } catch {}
      }

      revisions = new RevisionResolver(repository).resolve(parentShaOrRef, candidateSha);
    } catch (error) {
      if (error instanceof SajimoraExecutionError) throw error;
      throw new SajimoraExecutionError(error instanceof Error ? error.message : String(error), 3, 'GIT_SNAPSHOT_FAILURE', { cause: error });
    }

    try {
      const snapshots = new SnapshotFilesystem(new GitObjectReader(repository));
      parentSnapshot = snapshots.materialize(revisions.parentSha);
      candidateSnapshot = snapshots.materialize(revisions.candidateSha);
    } catch (error) {
      throw new SajimoraExecutionError(error instanceof Error ? error.message : String(error), 4, 'PROGRAM_CONSTRUCTION_FAILURE', { cause: error });
    }

    const allTracked = new Set([...parentSnapshot.trackedFiles, ...candidateSnapshot.trackedFiles]);
    const hasTs = [...allTracked].some(f => /\.[cm]?[jt]sx?$/i.test(f));
    const hasJava = [...allTracked].some(f => f.endsWith('.java'));

    const effectiveLanguage = args.language === 'auto'
      ? (hasJava && !hasTs ? 'java' : 'typescript')
      : args.language;

    let outputJson: unknown;
    let outputText = '';
    let frontendFindings: any[] = [];
    let frontendContractsCount = 0;
    let crossLanguageVerdict: string | undefined;
    let finalVerdict: string = 'INCONCLUSIVE';

    const config = loadSajimoraConfig(args.repo, args.config);
    let policy: ArtifactTrustPolicy | undefined = config?.admission;
    if (args.trustPolicy) {
      const resolvedPolicy = path.resolve(args.trustPolicy);
      if (!fs.existsSync(resolvedPolicy) || !fs.statSync(resolvedPolicy).isFile()) {
        throw new SajimoraExecutionError(`Trust policy file not found: ${args.trustPolicy}`, 2, 'ANALYSIS_INPUT_FAILURE');
      }
      try {
        policy = JSON.parse(fs.readFileSync(resolvedPolicy, 'utf8'));
      } catch (err) {
        throw new SajimoraExecutionError(`Failed to parse trust policy JSON at ${args.trustPolicy}: ${err instanceof Error ? err.message : String(err)}`, 2, 'ANALYSIS_INPUT_FAILURE');
      }
    }

    let frontendEnvelope: ContractArtifactEnvelope | undefined;
    if (args.frontend) {
      frontendEnvelope = loadFrontendEnvelope(args.frontend, policy);
      frontendContractsCount = (frontendEnvelope.payload as FrontendContractPayload).clientContracts?.length ?? 0;
    }

    if (effectiveLanguage === 'java') {
      if (!parentSnapshot || !candidateSnapshot) {
        throw new SajimoraExecutionError('Snapshots not materialized', 4, 'PROGRAM_CONSTRUCTION_FAILURE');
      }
      const parentSnap = parentSnapshot;
      const candidateSnap = candidateSnapshot;
      const isRelevant = (f: string) =>
        f.endsWith('.java') ||
        f.endsWith('pom.xml') ||
        f.endsWith('.gradle') ||
        f.endsWith('.gradle.kts') ||
        f.endsWith('.properties') ||
        f.endsWith('.yml') ||
        f.endsWith('.yaml') ||
        f.includes('META-INF/services/') ||
        f.endsWith('.xml');

      const parentProvider: JavaSnapshotProvider = {
        trackedFiles: parentSnap.trackedFiles.filter(isRelevant),
        readTextFile: (file: string) => parentSnap.readTextFile(file)
      };
      const candidateProvider: JavaSnapshotProvider = {
        trackedFiles: candidateSnap.trackedFiles.filter(isRelevant),
        readTextFile: (file: string) => candidateSnap.readTextFile(file)
      };
      const analyzer = new AdvisoryJavaImpactAnalyzer();
      const inRepoResult = analyzer.analyze({
        parent: { commitSha: revisions.parentSha, files: parentProvider },
        candidate: { commitSha: revisions.candidateSha, files: candidateProvider }
      });

      if (frontendEnvelope) {
        const parentHost = new JavaSealedCompilerHost(parentSnap);
        const candidateHost = new JavaSealedCompilerHost(candidateSnap);
        const buildJacksonFileMap = (snapshot: { trackedFiles: readonly string[]; readTextFile(f: string): string | undefined }) => {
          const map = new Map<string, string>();
          for (const file of snapshot.trackedFiles) {
            if (file.endsWith('lombok.config') || file.endsWith('.java') || /application[^/]*\.(?:properties|ya?ml)$/.test(file)) {
              const text = snapshot.readTextFile(file);
              if (text !== undefined) map.set(file, text);
            }
          }
          return map;
        };
        const parentConfig = extractSnapshotJacksonConfig(buildJacksonFileMap(parentSnap));
        const candidateConfig = extractSnapshotJacksonConfig(buildJacksonFileMap(candidateSnap));
        const parentEngine = new JavaWireModelEngine(parentHost, parentConfig.naming);
        const candidateEngine = new JavaWireModelEngine(candidateHost, candidateConfig.naming);

        const jaxAnnotations = ['Path', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'Produces', 'Consumes'];
        const parentBlockers: any[] = [...parentConfig.blockers];
        const parentEndpoints: EndpointContract[] = [];
        for (const clazz of parentHost.getAllClasses()) {
          const isSpring = clazz.annotations.some(a => ['RestController', 'Controller', 'RequestMapping'].includes(a));
          const isJax = clazz.annotations.some(a => jaxAnnotations.includes(a)) ||
            clazz.methods.some(m => m.annotations.some(a => jaxAnnotations.includes(a)));
          if (isJax && !isSpring) {
            parentBlockers.push({
              code: 'UNSUPPORTED_FRAMEWORK',
              message: `JAX-RS / Jersey resource ${clazz.fqcn} detected. Sajimora supports Spring MVC controllers (@RestController, @Controller).`,
              file: clazz.filePath
            });
            continue;
          }
          if (isSpring) {
            const res = parentEngine.extractControllerEndpoints(clazz);
            parentEndpoints.push(...res.endpoints);
            parentBlockers.push(...res.blockers);
          }
        }
        const candidateBlockers: any[] = [...candidateConfig.blockers];
        const candidateEndpoints: EndpointContract[] = [];
        for (const clazz of candidateHost.getAllClasses()) {
          const isSpring = clazz.annotations.some(a => ['RestController', 'Controller', 'RequestMapping'].includes(a));
          const isJax = clazz.annotations.some(a => jaxAnnotations.includes(a)) ||
            clazz.methods.some(m => m.annotations.some(a => jaxAnnotations.includes(a)));
          if (isJax && !isSpring) {
            candidateBlockers.push({
              code: 'UNSUPPORTED_FRAMEWORK',
              message: `JAX-RS / Jersey resource ${clazz.fqcn} detected. Sajimora supports Spring MVC controllers (@RestController, @Controller).`,
              file: clazz.filePath
            });
            continue;
          }
          if (isSpring) {
            const res = candidateEngine.extractControllerEndpoints(clazz);
            candidateEndpoints.push(...res.endpoints);
            candidateBlockers.push(...res.blockers);
          }
        }

        const detectedCodec = parentConfig.naming === 'SNAKE_CASE' ? 'JACKSON_NAMING_V2' : 'JACKSON_DEFAULT_V1';

        const baseEnv = sealEnvelope({
          envelopeVersion: ARTIFACT_ENVELOPE_VERSION,
          reportSchemaVersion: SCHEMA_VERSION,
          kind: 'BACKEND_CONTRACT',
          snapshot: {
            repositoryId: path.basename(args.repo),
            serviceId: 'api',
            apiVersion: 'v1',
            parentCommit: revisions.parentSha,
            candidateSnapshot: revisions.candidateSha
          },
          profile: {
            toolVersion: '0.1.0',
            frameworkProfile: 'SPRING_MVC',
            codecProfile: detectedCodec,
            configFingerprint: null
          },
          completeness: {
            complete: parentBlockers.length === 0,
            unresolvedEndpoints: [],
            blockers: parentBlockers.map(b => ({ code: b.code ?? 'EXTRACTION_BLOCKER', message: b.message, file: b.file }))
          },
          payload: { baseUrls: [], proxyPrefixes: [], endpoints: parentEndpoints } as BackendContractPayload
        });

        const candEnv = sealEnvelope({
          envelopeVersion: ARTIFACT_ENVELOPE_VERSION,
          reportSchemaVersion: SCHEMA_VERSION,
          kind: 'BACKEND_CONTRACT',
          snapshot: {
            repositoryId: path.basename(args.repo),
            serviceId: 'api',
            apiVersion: 'v1',
            parentCommit: revisions.parentSha,
            candidateSnapshot: revisions.candidateSha
          },
          profile: {
            toolVersion: '0.1.0',
            frameworkProfile: 'SPRING_MVC',
            codecProfile: detectedCodec,
            configFingerprint: null
          },
          completeness: {
            complete: candidateBlockers.length === 0,
            unresolvedEndpoints: [],
            blockers: candidateBlockers.map(b => ({ code: b.code ?? 'EXTRACTION_BLOCKER', message: b.message, file: b.file }))
          },
          payload: { baseUrls: [], proxyPrefixes: [], endpoints: candidateEndpoints } as BackendContractPayload
        });

        const comparisonEngine = new ArtifactComparisonEngine();
        const comparisonReport = comparisonEngine.compare(baseEnv, candEnv, [frontendEnvelope]);
        frontendFindings = [...comparisonReport.findings];
        crossLanguageVerdict = comparisonReport.verdict;
      }

      if (inRepoResult.verdict === 'ANALYSIS_ERROR' || crossLanguageVerdict === 'ANALYSIS_ERROR') {
        finalVerdict = 'ANALYSIS_ERROR';
      } else if (crossLanguageVerdict === 'LIKELY_VIOLATED' || inRepoResult.verdict === 'LIKELY_VIOLATED') {
        finalVerdict = 'LIKELY_VIOLATED';
      } else if (crossLanguageVerdict === 'INCONCLUSIVE' || inRepoResult.verdict === 'INCONCLUSIVE') {
        finalVerdict = 'INCONCLUSIVE';
      } else if (inRepoResult.verdict === 'LIKELY_PRESERVED') {
        if (!args.frontend) {
          finalVerdict = 'LIKELY_PRESERVED';
        } else if (crossLanguageVerdict === 'LIKELY_PRESERVED') {
          finalVerdict = 'LIKELY_PRESERVED';
        } else {
          finalVerdict = 'INCONCLUSIVE';
        }
      } else {
        finalVerdict = 'INCONCLUSIVE';
      }

      if (finalVerdict === 'ANALYSIS_ERROR') {
        throw new SajimoraExecutionError('Impact analysis terminated with ANALYSIS_ERROR', 6, 'ENGINE_RUNTIME_FAILURE');
      }

      if (args.frontend) {
        outputJson = {
          schemaVersion: 'SAJIMORA_ADVISORY_IMPACT_V1',
          verdict: finalVerdict,
          language: 'java',
          engine: 'advisory',
          frontendContract: args.frontend,
          frontendFindings,
          providers: inRepoResult.providers,
          consumers: inRepoResult.consumers,
          impacts: inRepoResult.impacts
        };
      } else {
        outputJson = inRepoResult;
      }
      outputText = formatAdvisoryReportText(
        'Java',
        finalVerdict,
        inRepoResult.providers,
        inRepoResult.consumers,
        inRepoResult.impacts,
        args.frontend ? { path: args.frontend, contractsCount: frontendContractsCount, findings: frontendFindings } : undefined,
        inRepoResult
      );
    } else {
      // TypeScript
      const parentFiles: Record<string, string> = {};
      for (const file of parentSnapshot.trackedFiles) {
        if (/\.[cm]?[jt]sx?$/i.test(file) || file.endsWith('.json')) {
          const text = parentSnapshot.readTextFile(file);
          if (text !== undefined) parentFiles[file] = text;
        }
      }
      const candidateFiles: Record<string, string> = {};
      for (const file of candidateSnapshot.trackedFiles) {
        if (/\.[cm]?[jt]sx?$/i.test(file) || file.endsWith('.json')) {
          const text = candidateSnapshot.readTextFile(file);
          if (text !== undefined) candidateFiles[file] = text;
        }
      }
      const analyzer = new AdvisoryTypeScriptImpactAnalyzer();
      const inRepoResult = analyzer.analyze({
        parent: { commitSha: revisions.parentSha, files: parentFiles },
        candidate: { commitSha: revisions.candidateSha, files: candidateFiles }
      });

      if (frontendEnvelope) {
        const clientContracts = (frontendEnvelope.payload as FrontendContractPayload).clientContracts ?? [];
        for (const req of clientContracts) {
          const matchingProvider = inRepoResult.providers.find(p => p.name === req.normalizedRoute || p.file === req.sourceFile);
          if (matchingProvider && inRepoResult.impacts.some(i => i.providerId === matchingProvider.id && i.classification === 'NEWLY_FAILING')) {
            frontendFindings.push({
              endpoint: { method: req.httpMethod, path: req.normalizedRoute },
              typescriptClient: { file: req.sourceFile, line: req.sourceLine },
              change: { before: matchingProvider.before ?? '', after: matchingProvider.after ?? '' },
              repairHint: `TypeScript provider ${matchingProvider.name} broke client expectation`
            });
            crossLanguageVerdict = 'LIKELY_VIOLATED';
          }
        }
        if (!crossLanguageVerdict) {
          crossLanguageVerdict = inRepoResult.verdict;
        }
      }

      if (inRepoResult.verdict === 'ANALYSIS_ERROR' || crossLanguageVerdict === 'ANALYSIS_ERROR') {
        finalVerdict = 'ANALYSIS_ERROR';
      } else if (crossLanguageVerdict === 'LIKELY_VIOLATED' || inRepoResult.verdict === 'LIKELY_VIOLATED') {
        finalVerdict = 'LIKELY_VIOLATED';
      } else if (crossLanguageVerdict === 'INCONCLUSIVE' || inRepoResult.verdict === 'INCONCLUSIVE') {
        finalVerdict = 'INCONCLUSIVE';
      } else if (inRepoResult.verdict === 'LIKELY_PRESERVED') {
        if (!args.frontend) {
          finalVerdict = 'LIKELY_PRESERVED';
        } else if (crossLanguageVerdict === 'LIKELY_PRESERVED') {
          finalVerdict = 'LIKELY_PRESERVED';
        } else {
          finalVerdict = 'INCONCLUSIVE';
        }
      } else {
        finalVerdict = 'INCONCLUSIVE';
      }

      if (finalVerdict === 'ANALYSIS_ERROR') {
        throw new SajimoraExecutionError('Impact analysis terminated with ANALYSIS_ERROR', 6, 'ENGINE_RUNTIME_FAILURE');
      }

      if (args.frontend) {
        outputJson = {
          schemaVersion: 'SAJIMORA_ADVISORY_IMPACT_V1',
          verdict: finalVerdict,
          language: 'typescript',
          engine: 'advisory',
          frontendContract: args.frontend,
          frontendFindings,
          providers: inRepoResult.providers,
          consumers: inRepoResult.consumers,
          impacts: inRepoResult.impacts
        };
      } else {
        outputJson = inRepoResult;
      }
      outputText = formatAdvisoryReportText(
        'TypeScript',
        finalVerdict,
        inRepoResult.providers,
        inRepoResult.consumers,
        inRepoResult.impacts,
        args.frontend ? { path: args.frontend, contractsCount: frontendContractsCount, findings: frontendFindings } : undefined,
        inRepoResult
      );
    }

    const format = args.format ?? 'json';
    const outputString = (format === 'text' || format === 'markdown')
      ? outputText
      : JSON.stringify(outputJson, null, 2);

    if (args.output) {
      writeArtifactAtomically(args.output, outputString);
    } else {
      io.stdout(outputString + '\n');
    }

    if (before !== repository.statusFingerprint()) {
      throw new SajimoraExecutionError('Target repository changed during analysis.', 6, 'ENGINE_RUNTIME_FAILURE');
    }
    io.stderr(`Sajimora advisory impact analysis completed in ${Date.now() - started} ms.\n`);

    if (args.failOnViolation || args.strict) {
      if (finalVerdict === 'VIOLATED' || finalVerdict === 'LIKELY_VIOLATED') {
        throw new SajimoraExecutionError('Contract compatibility check failed with violations.', 1, 'CONTRACT_VIOLATION');
      }
      if (args.strict && finalVerdict === 'INCONCLUSIVE') {
        throw new SajimoraExecutionError('Contract compatibility check inconclusive in strict mode.', 3, 'VERDICT_INCONCLUSIVE');
      }
    }
  } catch (error) {
    if (error instanceof SajimoraExecutionError) throw error;
    throw new SajimoraExecutionError(error instanceof Error ? error.message : String(error), 6, 'ENGINE_RUNTIME_FAILURE', { cause: error });
  } finally {
    candidateSnapshot?.cleanup();
    parentSnapshot?.cleanup();
  }
}


export function resolveDependencyStore(root: string | undefined, snapshot: Pick<ReturnType<SnapshotFilesystem['materialize']>, 'readTextFile'>) {
  if (!root) return undefined; const lockfiles=['pnpm-lock.yaml','yarn.lock','package-lock.json']; const lockfile=lockfiles.find(file=>fs.existsSync(path.join(root,file))&&snapshot.readTextFile(file)!==undefined);
  if(!lockfile) throw new SajimoraExecutionError('Dependency root has no lockfile shared with the analyzed revision.',3,'REPOSITORY_CONFIGURATION_LIMITATION'); const installed=fs.readFileSync(path.join(root,lockfile)); const committed=Buffer.from(snapshot.readTextFile(lockfile)!); const hash=(b:Buffer)=>crypto.createHash('sha256').update(b.toString('utf8').replace(/\r\n/g,'\n')).digest('hex');
  if(hash(installed)!==hash(committed)) throw new SajimoraExecutionError('Dependency store lockfile does not match the analyzed snapshot.',3,'REPOSITORY_CONFIGURATION_LIMITATION');
  return { root:path.join(root,'node_modules'), evidence:{lockfile,lockfileHash:hash(committed),status:'LOCKFILE_MATCHED_READ_ONLY' as const} };
}
export async function runAnalyzeCommand(args: AnalyzeArguments, io: CommandIO = { stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) }): Promise<void> {
  if (args.engine === 'production' || args.engine === 'certification' || args.engine === 'f0') {
    await runProductionAnalyzeCommand(args as any, io);
    return;
  }
  if (args.engine === 'advisory') {
    await runAdvisoryAnalyzeCommand(args, io);
    return;
  }
  const started = Date.now(); let parentSnapshot: ReturnType<SnapshotFilesystem['materialize']> | undefined; let snapshot: ReturnType<SnapshotFilesystem['materialize']> | undefined;
  try {
    let repository: GitRepository; let revisions: ReturnType<RevisionResolver['resolve']>; let before: string;
    try { repository = new GitRepository(args.repo); repository.validate(); before = repository.statusFingerprint(); revisions = new RevisionResolver(repository).resolve(args.parent, args.candidate); }
    catch (error) { throw new SajimoraExecutionError(error instanceof Error ? error.message : String(error), 3, 'GIT_SNAPSHOT_FAILURE', { cause: error }); }
    try { const snapshots = new SnapshotFilesystem(new GitObjectReader(repository)); parentSnapshot = snapshots.materialize(revisions.parentSha); snapshot = snapshots.materialize(revisions.candidateSha); }
    catch (error) { throw new SajimoraExecutionError(error instanceof Error ? error.message : String(error), 4, 'PROGRAM_CONSTRUCTION_FAILURE', { cause: error }); }
    const detection = { trackedFiles: snapshot.trackedFiles, readTextFile: (file: string) => snapshot!.readTextFile(file) };
    const registry = new LanguageAdapterRegistry(); registry.register(new TypeScriptV1Adapter());
    let selection; try { selection = registry.select(args.language, detection); } catch (error) { throw new SajimoraExecutionError(error instanceof Error ? error.message : String(error), 3, 'REPOSITORY_CONFIGURATION_LIMITATION', { cause: error }); }
    const derivation = deriveRealDiffObligations(repository.root, revisions.parentSha, revisions.candidateSha, snapshot.root);
    if (derivation.status !== 'DERIVED') throw new SajimoraExecutionError(derivation.reason, 4, 'PROGRAM_CONSTRUCTION_FAILURE');
    const activeSnapshot = snapshot;
    const repositoryId = repository.repositoryId(); const snapshotRoot = path.resolve(activeSnapshot.root).replace(/\\/g, '/'); const toolchain = selection.adapter.toolchain(detection); const parentDetection = { trackedFiles: parentSnapshot!.trackedFiles, readTextFile: (file: string) => parentSnapshot!.readTextFile(file) }; const parentToolchain = selection.adapter.toolchain(parentDetection);
    const parentDependencies=resolveDependencyStore(args.dependencyRoot,parentSnapshot!); const candidateDependencies=resolveDependencyStore(args.dependencyRoot,activeSnapshot);
    const dual = new DualTypeScriptProgramBuilder().build(
      { root: parentSnapshot!.root, trackedFiles: parentSnapshot!.trackedFiles, revision: { repositoryId, commitSha: revisions.parentSha }, toolchain: parentToolchain, adapterId: selection.adapter.descriptor.id, adapterVersion: selection.adapter.descriptor.version, dependencyRoot: parentDependencies?.root, dependencyStoreEvidence: parentDependencies?.evidence, readTextFile: (file: string) => parentSnapshot!.readTextFile(file) },
      { root: activeSnapshot.root, trackedFiles: activeSnapshot.trackedFiles, revision: { repositoryId, commitSha: revisions.candidateSha, parentSelection: revisions.parentSelection }, toolchain, adapterId: selection.adapter.descriptor.id, adapterVersion: selection.adapter.descriptor.version, dependencyRoot: candidateDependencies?.root, dependencyStoreEvidence: candidateDependencies?.evidence, readTextFile: (file: string) => activeSnapshot.readTextFile(file) },
      { changedFiles: derivation.changedFiles, obligations: derivation.obligations }
    );
    const crossVersionIdentity = new TypeScriptCrossVersionIdentityAnalyzer().analyze(dual.parent, dual.candidate, parentSnapshot!.root, activeSnapshot.root, new GitDiffReader(repository).read(revisions.parentSha, revisions.candidateSha));
    const analyzed = selection.adapter.analyze({ snapshotRoot: activeSnapshot.root, obligations: derivation.obligations, dualPrograms: dual, crossVersionIdentity, isPhase4Mode: true } as any);
    if (analyzed.results.some(result => result.proof.auditTrace?.authorityDecision.reason === 'ENGINE_RUNTIME_FAILURE')) throw new SajimoraExecutionError('Existing analysis reported an engine runtime failure.', 6, 'ENGINE_RUNTIME_FAILURE');

    const allCompatibilityResults = new Map<string, CompatibilityResult>();
    for (const result of analyzed.results) {
      const compatList = (result.proof.auditTrace as any)?.compatibility;
      if (Array.isArray(compatList)) {
        for (const item of compatList) {
          if (item?.usageSiteId && item?.result) {
            allCompatibilityResults.set(item.usageSiteId, item.result);
          }
        }
      }
    }

    let semanticCompatibility: Phase1Artifact['semanticCompatibility'] = undefined;
    if (allCompatibilityResults.size > 0) {
      const bundle = Phase4EvidenceAssembler.assembleBundle(allCompatibilityResults);
      const evaluatedConsumers: Phase4ConsumerArtifact[] = [];
      for (const [consumerId, res] of allCompatibilityResults.entries()) {
        evaluatedConsumers.push({
          consumerMappingId: consumerId,
          status: res.status,
          reason: res.reason ?? null,
          proofTree: (res.phase4Evidence as any)?.proofTree ?? (res.phase4Evidence as any)?.partialProofTree
        });
      }
      evaluatedConsumers.sort((a, b) => binaryCompare(a.consumerMappingId, b.consumerMappingId));

      const witnesses: SerializedWitness[] = bundle.witnesses.map(w => ({
        witnessId: w.witnessId,
        failedRelation: w.failedRelation,
        position: w.position,
        parentType: {
          display: w.parentType.display,
          ...(w.parentType.irContentHash ? { irContentHash: w.parentType.irContentHash } : {})
        },
        candidateType: {
          display: w.candidateType.display,
          ...(w.candidateType.irContentHash ? { irContentHash: w.candidateType.irContentHash } : {})
        }
      }));

      const blockerSummary: SerializedBlocker[] = bundle.blockerSummary.map(b => ({
        blockerId: b.blockerId,
        snapshot: b.snapshot,
        detail: b.detail
      }));

      semanticCompatibility = {
        schemaVersion: 'SAJIMORA_COMPATIBILITY_EVIDENCE_V1',
        engineVersion: bundle.engineVersion,
        evaluatedConsumers,
        witnesses,
        blockerSummary,
        typeIRStats: bundle.typeIRStats,
        proofStats: bundle.proofStats,
        phase4Outcome: {
          allConsumersEvaluated: bundle.phase4Outcome.allConsumersEvaluated,
          coverageGaps: [...bundle.phase4Outcome.coverageGaps]
        }
      };
    }

    const artifact: Phase1Artifact = {
      schemaVersion: 'SAJIMORA_ANALYSIS_ARTIFACT_V2',
      repository: { repositoryId },
      revisions: { parent: { repositoryId, commitSha: revisions.parentSha }, candidate: { repositoryId, commitSha: revisions.candidateSha, parentSelection: revisions.parentSelection } },
      adapter: { id: selection.adapter.descriptor.id, version: selection.adapter.descriptor.version, capabilities: [...selection.adapter.descriptor.capabilities].sort() as any, selection: { mode: selection.mode, evidence: [...selection.evidence].sort((a, b) => binaryCompare(`${a.kind}:${a.value}`, `${b.kind}:${b.value}`)) }, toolchain },
      dualProgram: { parentStatus: dual.parent.status, candidateStatus: dual.candidate.status, universe: dual.universe },
      crossVersionIdentity,
      ...(semanticCompatibility ? { semanticCompatibility } : {}),
      analysis: { status: 'COMPLETED', changedFiles: [...derivation.changedFiles].sort(), results: analyzed.results.map(({ obligation, proof }) => {
        const symbol = obligation.mutatedSymbol!; const absolute = path.resolve(symbol.declarationLocation.filePath); const relative = path.relative(activeSnapshot.root, absolute).replace(/\\/g, '/'); if (relative.startsWith('../') || path.isAbsolute(relative)) throw new SajimoraExecutionError('Analysis result escaped the candidate snapshot.', 5, 'ARTIFACT_VALIDATION_FAILURE'); const decision = proof.auditTrace?.authorityDecision;
        return { obligationId: obligation.invariantId.replaceAll(snapshotRoot, '<snapshot>'), target: { name: symbol.qualifiedName, kind: symbol.kind, file: relative, line: symbol.declarationLocation.line }, verdict: proof.verdict, authority: decision ? { source: decision.source, gate: decision.gate, reason: decision.reason } : null };
      }).sort((a, b) => binaryCompare(`${a.target.file}:${a.target.line}:${a.target.name}`, `${b.target.file}:${b.target.line}:${b.target.name}`)) }
    };
    if (before !== repository.statusFingerprint()) throw new SajimoraExecutionError('Target repository changed during analysis.', 6, 'ENGINE_RUNTIME_FAILURE');
    io.stderr(`Sajimora analysis completed in ${Date.now() - started} ms.\n`);
    if (args.failOnViolation || args.strict) {
      const hasViolation = analyzed.results.some(r => r.proof.verdict === 'VIOLATED');
      if (hasViolation) {
        throw new SajimoraExecutionError('Contract compatibility check failed with violations.', 1, 'CONTRACT_VIOLATION');
      }
      if (args.strict && analyzed.results.some(r => r.proof.verdict === 'UNKNOWN' || r.proof.verdict === 'INSUFFICIENT_EVIDENCE')) {
        throw new SajimoraExecutionError('Contract compatibility check inconclusive in strict mode.', 3, 'VERDICT_INCONCLUSIVE');
      }
    }
  } finally { snapshot?.cleanup(); parentSnapshot?.cleanup(); }
}
