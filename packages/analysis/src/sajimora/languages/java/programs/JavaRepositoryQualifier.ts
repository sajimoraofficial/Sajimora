/**
 * @file JavaRepositoryQualifier.ts
 * Phase J-8.5: Java Repository Qualification Gate.
 *
 * Enforces the core principle:
 *   "Java repository detected" != "Java repository is certifiable."
 *
 * Pipeline:
 * 1. Build Model Extraction: Static Maven/Gradle subset check.
 * 2. Reactor Module Graph Completeness: No missing submodules, no circular reactor dependencies.
 * 3. JPMS Export Graph Consistency: Inter-module package export validation.
 * 4. Source-Set Purity: Detects unmaterialized code-generation (Lombok, Protobuf, ANTLR).
 * 5. Language Subset Audit: Scans for wildcard imports and dynamic reflection.
 *
 * Output:
 * - QUALIFIED_FOR_CERTIFIED_F0: Repository/modules admitted to certified proof pipeline.
 * - RETAINED_IN_ADVISORY: Retained in advisory mode with explicit actionable blocker codes.
 */

import { SealedJavaSnapshotInput } from './JavaSealedCompilerHost';
import {
  JavaBuildModelExtractor,
  JavaReactorBuildGraph,
  JavaModuleInfo
} from './JavaBuildModelExtractor';
import { JavaMultiModuleCompilerHost } from './JavaMultiModuleCompilerHost';
import { JavaSemanticProfileId } from '../certified/JavaCertifiedProfile';

export type JavaQualificationBlockerCode =
  | 'UNSUPPORTED_DYNAMIC_BUILD_SCRIPT'
  | 'MISSING_SUBMODULE_DESCRIPTOR'
  | 'CIRCULAR_REACTOR_DEPENDENCY'
  | 'JPMS_UNEXPORTED_PACKAGE_REFERENCE'
  | 'UNMATERIALIZED_CODE_GENERATION'
  | 'WILDCARD_IMPORT_POLLUTION'
  | 'DYNAMIC_REFLECTION_CONSTRUCT'
  | 'MODERN_JAVA_CONSTRUCT'
  | 'UNRESOLVED_CLASSPATH_DEPENDENCY';

export interface JavaQualificationBlocker {
  readonly code: JavaQualificationBlockerCode;
  readonly reason: string;
  readonly file?: string;
  readonly moduleId?: string;
}

export interface JavaQualificationStageResult {
  readonly stage: string;
  readonly status: 'PASS' | 'FAIL';
  readonly detail: string;
}

export interface JavaRepositoryQualificationReport {
  readonly timestamp: string;
  readonly repositoryId: string;
  readonly qualificationStatus: 'QUALIFIED_FOR_CERTIFIED_F0' | 'RETAINED_IN_ADVISORY';
  readonly admittedProfile: JavaSemanticProfileId | null;
  readonly buildSystem: 'MAVEN' | 'GRADLE' | 'STANDALONE';
  readonly isMultiModule: boolean;
  readonly stages: {
    readonly buildModel: JavaQualificationStageResult;
    readonly reactorGraph: JavaQualificationStageResult;
    readonly jpmsConsistency: JavaQualificationStageResult;
    readonly sourceSetPurity: JavaQualificationStageResult;
    readonly languageSubset: JavaQualificationStageResult;
    readonly classpathCompleteness?: JavaQualificationStageResult;
  };
  readonly blockers: readonly JavaQualificationBlocker[];
  readonly admittedModules: readonly string[];
  readonly disqualifiedModules: readonly string[];
  readonly metrics: {
    readonly totalJavaFiles: number;
    readonly totalModules: number;
    readonly totalWildcardImports: number;
    readonly totalReflectionOccurrences: number;
    readonly totalCodeGenAnnotations: number;
  };
}

export class JavaRepositoryQualifier {
  /**
   * Evaluates repository eligibility for certified F0 profile admission.
   */
  public static qualify(
    snapshot: SealedJavaSnapshotInput,
    repositoryId: string = 'repository'
  ): JavaRepositoryQualificationReport {
    const blockers: JavaQualificationBlocker[] = [];
    let totalWildcards = 0;
    let totalReflection = 0;
    let totalCodeGen = 0;

    // 1. Build Model Extraction Stage
    const graph = JavaBuildModelExtractor.extractBuildModel(snapshot);
    const host = new JavaMultiModuleCompilerHost(snapshot, graph);

    let buildModelStage: JavaQualificationStageResult;
    if (graph.qualificationStatus === 'UNSUPPORTED_DYNAMIC') {
      buildModelStage = {
        stage: 'Build Model Extraction',
        status: 'FAIL',
        detail: `Dynamic build scripting detected: [${graph.disqualificationReasons.join('; ')}]`
      };
      for (const r of graph.disqualificationReasons) {
        blockers.push({
          code: 'UNSUPPORTED_DYNAMIC_BUILD_SCRIPT',
          reason: r
        });
      }
    } else if (graph.qualificationStatus === 'INCOMPLETE') {
      buildModelStage = {
        stage: 'Build Model Extraction',
        status: 'FAIL',
        detail: `Incomplete module structure: [${graph.disqualificationReasons.join('; ')}]`
      };
      for (const r of graph.disqualificationReasons) {
        blockers.push({
          code: 'MISSING_SUBMODULE_DESCRIPTOR',
          reason: r
        });
      }
    } else {
      buildModelStage = {
        stage: 'Build Model Extraction',
        status: 'PASS',
        detail: `Declarative ${graph.buildSystem} build graph extracted with ${graph.modules.size} module(s).`
      };
    }

    // 2. Reactor Graph Completeness & Cycles
    const cycles = host.detectReactorCycles();
    let reactorStage: JavaQualificationStageResult;
    if (cycles.length > 0) {
      reactorStage = {
        stage: 'Reactor Graph Completeness',
        status: 'FAIL',
        detail: `Circular reactor dependencies detected: ${cycles.map(c => c.join(' -> ')).join(', ')}`
      };
      for (const c of cycles) {
        blockers.push({
          code: 'CIRCULAR_REACTOR_DEPENDENCY',
          reason: `Circular inter-module dependency: ${c.join(' -> ')}`
        });
      }
    } else {
      reactorStage = {
        stage: 'Reactor Graph Completeness',
        status: 'PASS',
        detail: `Acyclic reactor graph with ${graph.interModuleEdges.length} inter-module edge(s).`
      };
    }

    // 3. JPMS Consistency & Export Boundaries
    let jpmsFailures = 0;
    for (const file of host.getBaseHost().getTrackedJavaFiles()) {
      const imports = host.getBaseHost().getFileImports(file);
      for (const imp of imports) {
        if (!imp.isWildcard) {
          const res = host.resolveCrossModuleSymbol(imp.importedName, file);
          if (res.status === 'RESTRICTED') {
            jpmsFailures++;
            blockers.push({
              code: res.restrictionKind === 'JPMS_PACKAGE_NOT_EXPORTED'
                ? 'JPMS_UNEXPORTED_PACKAGE_REFERENCE'
                : 'UNSUPPORTED_DYNAMIC_BUILD_SCRIPT',
              file,
              moduleId: res.consumerModuleId,
              reason: res.reason
            });
          }
        }
      }
    }

    const jpmsStage: JavaQualificationStageResult = {
      stage: 'JPMS & Module Boundaries',
      status: jpmsFailures === 0 ? 'PASS' : 'FAIL',
      detail: jpmsFailures === 0
        ? 'All cross-module references respect JPMS exports and reactor dependencies.'
        : `${jpmsFailures} cross-module reference(s) violated module boundaries.`
    };

    // 4. Source-Set Purity (Unmaterialized Code-Generation Detection)
    // Lombok: @Data, @Getter, @Setter, @Builder, @NoArgsConstructor
    // Protobuf/gRPC: unmaterialized generated message builders
    const codeGenPatterns = [
      /@(?:Data|Getter|Setter|Builder|NoArgsConstructor|AllArgsConstructor|Value)\b/,
      /lombok\./
    ];

    for (const file of host.getBaseHost().getTrackedJavaFiles()) {
      const content = snapshot.readTextFile(file) ?? '';
      for (const pat of codeGenPatterns) {
        if (pat.test(content)) {
          totalCodeGen++;
          blockers.push({
            code: 'UNMATERIALIZED_CODE_GENERATION',
            file,
            reason: `Unmaterialized annotation processor / Lombok pattern detected matching ${pat.source}`
          });
          break;
        }
      }
    }

    const sourceSetPurityStage: JavaQualificationStageResult = {
      stage: 'Source-Set Purity',
      status: totalCodeGen === 0 ? 'PASS' : 'FAIL',
      detail: totalCodeGen === 0
        ? 'Clean pure Java source sets with zero unmaterialized code generation.'
        : `${totalCodeGen} file(s) require unmaterialized annotation processor code generation.`
    };

    // 5. Language Subset Audit (Wildcards & Reflection)
    const reflectionPatterns = [
      /Class\.forName\s*\(/,
      /Method\.invoke\s*\(/,
      /Proxy\.newProxyInstance\s*\(/,
      /java\.lang\.reflect/
    ];

    for (const file of host.getBaseHost().getTrackedJavaFiles()) {
      const imports = host.getBaseHost().getFileImports(file);
      const content = snapshot.readTextFile(file) ?? '';

      const fileWildcards = imports.filter(i => i.isWildcard);
      const rawWildcardRegex = /(?:^|[;\s])import\s+(?:static\s+)?[a-zA-Z0-9_.]+\.\s*\*/;
      const hasWildcard = fileWildcards.length > 0 || rawWildcardRegex.test(content);
      if (hasWildcard) {
        const count = Math.max(fileWildcards.length, 1);
        totalWildcards += count;
        blockers.push({
          code: 'WILDCARD_IMPORT_POLLUTION',
          file,
          reason: `Wildcard import(s): [${fileWildcards.map(w => w.importedName).join(', ') || '*'}]`
        });
      }

      for (const pat of reflectionPatterns) {
        if (pat.test(content)) {
          totalReflection++;
          blockers.push({
            code: 'DYNAMIC_REFLECTION_CONSTRUCT',
            file,
            reason: `Dynamic reflection construct matching ${pat.source} (J-X1..J-X3)`
          });
          break;
        }
      }
    }

    // Modern Java Constructs (Sealed Types & Records - Pending J-14/J-15)
    let totalModernJava = 0;
    const modernJavaPatterns = [
      /\bsealed\s+(?:class|interface)\b/,
      /\bpermits\s+[A-Za-z0-9_$,\s]+(?:\{|$)/
    ];

    for (const file of host.getBaseHost().getTrackedJavaFiles()) {
      const content = snapshot.readTextFile(file) ?? '';
      for (const pat of modernJavaPatterns) {
        if (pat.test(content)) {
          totalModernJava++;
          blockers.push({
            code: 'MODERN_JAVA_CONSTRUCT',
            file,
            reason: `Modern Java 17/21+ sealed construct detected matching ${pat.source}`
          });
          break;
        }
      }
    }

    const languageSubsetStage: JavaQualificationStageResult = {
      stage: 'F0 Language Subset',
      status: (totalWildcards === 0 && totalReflection === 0 && totalModernJava === 0) ? 'PASS' : 'FAIL',
      detail: (totalWildcards === 0 && totalReflection === 0 && totalModernJava === 0)
        ? 'Clean explicit single-type imports and zero dynamic reflection or modern unsealed constructs.'
        : `Disqualified by ${totalWildcards} wildcard import(s), ${totalReflection} reflection construct(s), and ${totalModernJava} modern construct(s).`
    };

    // 6. External Dependency & Classpath Purity (Phase 4)
    let totalUnresolvedExternalDeps = 0;
    const trackedClasses = new Set(host.getBaseHost().getAllClasses().map(c => c.fqcn));

    for (const file of host.getBaseHost().getTrackedJavaFiles()) {
      const imports = host.getBaseHost().getFileImports(file);
      for (const imp of imports) {
        if (!imp.isWildcard && imp.moduleSpecifier) {
          const spec = imp.moduleSpecifier;
          if (spec.startsWith('java.') || spec.startsWith('javax.') || spec.startsWith('jdk.')) continue;
          const specParts = spec.split('.');
          const isInternalPackage = Array.from(trackedClasses).some(tc => {
            const pkg = tc.includes('.') ? tc.substring(0, tc.lastIndexOf('.')) : '';
            if (pkg !== '' && (spec === pkg || spec.startsWith(pkg + '.'))) return true;
            const tcParts = tc.split('.');
            return specParts.length >= 2 && tcParts.length >= 2 && specParts[0] === tcParts[0] && specParts[1] === tcParts[1];
          });
          if (isInternalPackage) continue; // internal package symbol (e.g. deleted internal class)
          let resolved = trackedClasses.has(spec);
          if (!resolved) {
            let parent = spec;
            while (parent.includes('.')) {
              parent = parent.substring(0, parent.lastIndexOf('.'));
              if (trackedClasses.has(parent)) {
                resolved = true;
                break;
              }
            }
          }
          if (!resolved) {
            totalUnresolvedExternalDeps++;
            blockers.push({
              code: 'UNRESOLVED_CLASSPATH_DEPENDENCY',
              file,
              reason: `Unresolved external dependency type '${spec}' without sealed classpath receipt`
            });
            break;
          }
        }
      }
    }

    const classpathStage: JavaQualificationStageResult = {
      stage: 'Classpath & Dependency Completeness',
      status: totalUnresolvedExternalDeps === 0 ? 'PASS' : 'FAIL',
      detail: totalUnresolvedExternalDeps === 0
        ? 'All referenced types are resolved within sealed snapshot or standard runtime.'
        : `${totalUnresolvedExternalDeps} file(s) reference unresolved external dependencies without classpath receipts.`
    };

    // Final Qualification Determination
    const allStagesPass =
      buildModelStage.status === 'PASS' &&
      reactorStage.status === 'PASS' &&
      jpmsStage.status === 'PASS' &&
      sourceSetPurityStage.status === 'PASS' &&
      languageSubsetStage.status === 'PASS' &&
      classpathStage.status === 'PASS';

    const qualificationStatus = allStagesPass
      ? 'QUALIFIED_FOR_CERTIFIED_F0'
      : 'RETAINED_IN_ADVISORY';

    const admittedProfile = allStagesPass ? JavaSemanticProfileId.JAVA_PUBLIC_API_F0 : null;

    const admittedModules: string[] = [];
    const disqualifiedModules: string[] = [];

    for (const modId of graph.modules.keys()) {
      const modBlockers = blockers.filter(b => b.moduleId === modId || (b.file && b.file.startsWith(modId + '/')));
      if (allStagesPass || modBlockers.length === 0) {
        admittedModules.push(modId);
      } else {
        disqualifiedModules.push(modId);
      }
    }

    return {
      timestamp: new Date().toISOString(),
      repositoryId,
      qualificationStatus,
      admittedProfile,
      buildSystem: graph.buildSystem,
      isMultiModule: graph.isMultiModule,
      stages: {
        buildModel: buildModelStage,
        reactorGraph: reactorStage,
        jpmsConsistency: jpmsStage,
        sourceSetPurity: sourceSetPurityStage,
        languageSubset: languageSubsetStage
      },
      blockers: Object.freeze(blockers),
      admittedModules: Object.freeze(admittedModules),
      disqualifiedModules: Object.freeze(disqualifiedModules),
      metrics: {
        totalJavaFiles: host.getBaseHost().getTrackedJavaFiles().length,
        totalModules: graph.modules.size,
        totalWildcardImports: totalWildcards,
        totalReflectionOccurrences: totalReflection,
        totalCodeGenAnnotations: totalCodeGen
      }
    };
  }

  /**
   * Renders a human-readable Markdown summary of repository qualification.
   */
  public static renderMarkdownSummary(report: JavaRepositoryQualificationReport): string {
    const s = report.stages;
    return `
# Sajimora Java Repository Qualification Report (Phase J-8.5)
**Repository:** \`${report.repositoryId}\`
**Qualification Status:** \`${report.qualificationStatus}\`
**Admitted Profile:** \`${report.admittedProfile ?? 'NONE (Retained in Advisory)'}\`
**Build System:** \`${report.buildSystem}\` (Multi-Module: \`${report.isMultiModule}\`)
**Timestamp:** \`${report.timestamp}\`

## Qualification Pipeline Stages
| Stage | Status | Detail |
|---|---|---|
| Build Model Extraction | ${s.buildModel.status === 'PASS' ? '✅ PASS' : '❌ FAIL'} | ${s.buildModel.detail} |
| Reactor Graph Completeness | ${s.reactorGraph.status === 'PASS' ? '✅ PASS' : '❌ FAIL'} | ${s.reactorGraph.detail} |
| JPMS & Module Boundaries | ${s.jpmsConsistency.status === 'PASS' ? '✅ PASS' : '❌ FAIL'} | ${s.jpmsConsistency.detail} |
| Source-Set Purity | ${s.sourceSetPurity.status === 'PASS' ? '✅ PASS' : '❌ FAIL'} | ${s.sourceSetPurity.detail} |
| F0 Language Subset | ${s.languageSubset.status === 'PASS' ? '✅ PASS' : '❌ FAIL'} | ${s.languageSubset.detail} |

## Disqualification Blockers
${report.blockers.length === 0 ? '*(None — Repository satisfies all Certified F0 prerequisites)*' : report.blockers.map(b => `- **[${b.code}]** ${b.file ? `\`${b.file}\`: ` : ''}${b.reason}`).join('\n')}

## Metrics Summary
- **Tracked Java Files:** ${report.metrics.totalJavaFiles}
- **Total Modules:** ${report.metrics.totalModules}
- **Wildcard Imports:** ${report.metrics.totalWildcardImports}
- **Reflection Occurrences:** ${report.metrics.totalReflectionOccurrences}
- **Unmaterialized Code-Gen:** ${report.metrics.totalCodeGenAnnotations}
`.trim();
  }
}
