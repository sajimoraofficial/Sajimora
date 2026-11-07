/**
 * @file JavaLanguageAdapter.ts
 * Java Language Adapter implementing LanguageAdapter and LanguageAnalysisAdapter.
 * Purely advisory-only; does not invoke VerdictAuthority.
 * Unresolved or ambiguous symbols fail closed to INCONCLUSIVE.
 */

import * as crypto from 'node:crypto';
import {
  LanguageAdapter,
  LanguageAnalysisAdapter,
  LanguageAdapterDescriptor,
  LanguageContractIR,
  SpecializedUsageContract,
  ExtractionOptions,
  ExtractionResult,
  SpecializationResult,
  AdapterDetectionInput,
  AdapterSupport,
  AdapterAnalysisInput,
  AdapterAnalysisOutput,
  ToolchainIdentity,
  canonicalJson
} from '@sajimora/core';
import {
  JavaTypeIR,
  JavaASTNode,
  JavaTypeIRExtractor,
  mkUnsupported
} from './ir';
import {
  JavaPolicy,
  JavaSemanticRuleSet
} from './compatibility/JavaSemanticRules';
import {
  JavaSealedCompilerHost,
  SealedJavaSnapshotInput
} from './programs/JavaSealedCompilerHost';
import { GenericRelationEngine } from '../../compatibility/GenericRelationEngine';

export interface JavaSnapshotContext {
  readonly root?: string;
  readonly trackedFiles: readonly string[];
  readTextFile(path: string): string | undefined;
  readonly host?: JavaSealedCompilerHost;
}

export class JavaLanguageAdapter
  implements LanguageAdapter<JavaTypeIR, JavaPolicy, JavaSnapshotContext, JavaASTNode>,
             LanguageAnalysisAdapter
{
  public readonly languageId = 'java';
  public readonly schemaVersion = '1.0.0';
  public readonly semanticRules = new JavaSemanticRuleSet();

  public readonly descriptor: LanguageAdapterDescriptor = {
    id: 'java-v1',
    version: '1.0.0',
    capabilities: [
      'DECLARATION_DIFF', 'VALUE_REFERENCE_DISCOVERY', 'TYPE_REFERENCE_DISCOVERY',
      'INHERITANCE_DISCOVERY', 'OVERRIDE_DISCOVERY', 'IMPLEMENTATION_DISCOVERY', 'SOURCE_COMPATIBILITY'
    ]
  };

  // LanguageAdapter required methods — advisory-only stubs
  public extractTypeIR(_node: JavaASTNode, _snapshot: JavaSnapshotContext, _options?: ExtractionOptions): ExtractionResult<JavaTypeIR> {
    throw new Error('JavaLanguageAdapter: extractTypeIR not supported in advisory mode');
  }
  public extractContract(_node: JavaASTNode, _snapshot: JavaSnapshotContext): LanguageContractIR<JavaTypeIR> {
    throw new Error('JavaLanguageAdapter: extractContract not supported in advisory mode');
  }
  public extractUsageContract(_node: JavaASTNode, _snapshot: JavaSnapshotContext): SpecializedUsageContract<JavaTypeIR> {
    throw new Error('JavaLanguageAdapter: extractUsageContract not supported in advisory mode');
  }
  public specializeUsage(
    _historicalUsage: SpecializedUsageContract<JavaTypeIR>,
    _candidateDeclaration: LanguageContractIR<JavaTypeIR>,
    _policy: JavaPolicy
  ): SpecializationResult<JavaTypeIR> {
    throw new Error('JavaLanguageAdapter: specializeUsage not supported in advisory mode');
  }
  public hashTypeIR(typeIR: JavaTypeIR): string {
    return typeIR.irContentHash;
  }
  public hashPolicy(policy: JavaPolicy): string {
    return crypto.createHash('sha256').update(canonicalJson(policy), 'utf8').digest('hex');
  }
  public canAnalyze(input: AdapterDetectionInput): AdapterSupport {
    const evidence: AdapterSupport['evidence'] = [];
    if (input.trackedFiles.includes('pom.xml')) {
      evidence.push({ kind: 'CONFIGURATION', value: 'pom.xml' });
    }
    if (input.trackedFiles.includes('build.gradle') || input.trackedFiles.includes('build.gradle.kts')) {
      evidence.push({ kind: 'CONFIGURATION', value: 'build.gradle' });
    }
    const javaCount = input.trackedFiles.filter(f => f.endsWith('.java')).length;
    if (javaCount > 0) {
      evidence.push({ kind: 'SOURCE_EXTENSION', value: `${javaCount} tracked Java source file(s)` });
    }
    if (!evidence.length) {
      return { status: 'UNSUPPORTED', evidence, unsupportedBoundary: 'No tracked Java build configuration or source files.' };
    }
    return { status: 'SUPPORTED', evidence };
  }

  public toolchain(input: AdapterDetectionInput): ToolchainIdentity {
    let declaredVersion: string | null = null;
    const pom = input.readTextFile('pom.xml');
    if (pom) {
      const match = pom.match(/<(?:java\.version|maven\.compiler\.source)>([^<]+)<\//);
      if (match) declaredVersion = match[1].trim();
    }
    if (!declaredVersion) {
      const gradle = input.readTextFile('build.gradle') ?? input.readTextFile('build.gradle.kts');
      if (gradle) {
        const match = gradle.match(/(?:sourceCompatibility|targetCompatibility)\s*=\s*['"]?([0-9.]+)['"]?/);
        if (match) declaredVersion = match[1].trim();
      }
    }
    return {
      compiler: { name: 'javac', version: declaredVersion ?? '21' },
      repositoryDeclaredVersion: declaredVersion,
      mismatch: declaredVersion ? 'MATCH' : 'UNDETERMINED'
    };
  }

  public analyze(input: AdapterAnalysisInput & { parentSnapshot?: SealedJavaSnapshotInput }): AdapterAnalysisOutput {
    const parentInput = input.parentSnapshot ?? {
      root: input.snapshotRoot,
      trackedFiles: [],
      readTextFile: () => undefined
    };
    const parentHost = new JavaSealedCompilerHost(parentInput);
    const engine = new GenericRelationEngine<JavaTypeIR, JavaPolicy>(this);
    const policy: JavaPolicy = { enablePrimitiveWidening: true, strictGenericInvariance: true };

    const results = input.obligations.map(obligation => {
      const resolution = parentHost.resolveClass(obligation.mutatedSymbol?.qualifiedName ?? '');
      if (resolution.status === 'UNRESOLVED') {
        return {
          obligation,
          proof: {
            status: 'UNDECIDABLE' as const,
            obligationId: obligation.invariantId,
            verdict: 'INCONCLUSIVE',
            advisoryVerdict: 'INCONCLUSIVE' as const,
            certificationStatus: 'ADVISORY_ONLY' as const,
            blockers: [{ blockerId: 'JAVA_SYMBOL_UNRESOLVED', reason: resolution.reason, symbol: obligation.mutatedSymbol?.qualifiedName ?? '' }]
          } as any
        };
      }
      if (resolution.status === 'AMBIGUOUS') {
        return {
          obligation,
          proof: {
            status: 'UNDECIDABLE' as const,
            obligationId: obligation.invariantId,
            verdict: 'INCONCLUSIVE',
            advisoryVerdict: 'INCONCLUSIVE' as const,
            certificationStatus: 'ADVISORY_ONLY' as const,
            blockers: [{ blockerId: 'JAVA_SYMBOL_AMBIGUOUS', reason: resolution.reason, candidates: resolution.candidates, symbol: obligation.mutatedSymbol?.qualifiedName ?? '' }]
          } as any
        };
      }

      const typeIR = JavaTypeIRExtractor.extractTypeIR({
        kind: 'DECLARATION',
        declarationKind: 'CLASS',
        decl: resolution.declaration!,
        fqcn: resolution.fqcn,
        file: resolution.declaration?.filePath ?? ''
      });
      const rel = engine.evaluate(typeIR, typeIR, 'ASSIGNABLE_TO', policy);
      return {
        obligation,
        proof: {
          status: rel.status,
          obligationId: obligation.invariantId,
          verdict: rel.status === 'COMPATIBLE' ? 'LIKELY_PRESERVED' : 'INCONCLUSIVE',
          advisoryVerdict: rel.status === 'COMPATIBLE' ? 'LIKELY_PRESERVED' : 'INCONCLUSIVE',
          certificationStatus: 'ADVISORY_ONLY' as const,
          rule: rel.rule
        } as any
      };
    });

    return { results };
  }
}
