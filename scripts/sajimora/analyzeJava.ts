/**
 * @file analyzeJava.ts
 * Primary CLI dispatcher and programmatic analysis engine for the Java Language Track (Phase J-9).
 *
 * Capabilities:
 * - Direct execution of Java repository impact analysis and qualification.
 * - Automatically qualifies repository via Phase J-8.5 gate (auto-selecting F0 vs advisory fallback).
 * - Generates two-panel reports (Panel 1: Certified F0, Panel 2: Advisory Blast Radius).
 * - Emits stable JSON schema matching SAJIMORA_JAVA_ANALYSIS_V1.
 */

import {
  JavaRepositoryQualifier,
  JavaRepositoryQualificationReport,
  JavaTwoPanelReport,
  JavaAnalysisJsonV1,
  AdvisoryJavaImpactAnalyzer,
  JavaAdvisoryImpactResult,
  JavaProofProducer,
  JavaProofChecker,
  JavaSemanticObligation,
  JAVA_CERTIFIED_EVIDENCE_V1,
  JavaRuleSetId,
  JavaPerConsumerCertification,
  JavaConsumerCertificate,
  JavaSnapshotProvider
} from '../../packages/analysis/src/sajimora/advisory';
import {
  JavaSealedCompilerHost,
  SealedJavaSnapshotInput
} from '../../packages/analysis/src/sajimora/languages/java/programs/JavaSealedCompilerHost';

export interface RunJavaAnalysisOptions {
  readonly repoId?: string;
  readonly snapshot?: SealedJavaSnapshotInput;
  readonly historicalFiles?: Readonly<Record<string, string>> | JavaSnapshotProvider;
  readonly candidateFiles?: Readonly<Record<string, string>> | JavaSnapshotProvider;
  readonly targetSymbol?: string;
  readonly profile?: 'auto' | 'f0' | 'advisory';
  readonly format?: 'two-panel' | 'markdown' | 'json';
}

export interface RunJavaAnalysisResult {
  readonly qualification: JavaRepositoryQualificationReport;
  readonly reportText: string;
  readonly reportMarkdown: string;
  readonly reportJson: JavaAnalysisJsonV1;
  readonly effectiveVerdict: string;
  readonly advisoryResult?: JavaAdvisoryImpactResult;
  readonly consumerCertificates?: readonly JavaConsumerCertificate[];
}

export function runJavaAnalysis(options: RunJavaAnalysisOptions): RunJavaAnalysisResult {
  const repoId = options.repoId ?? 'java-workspace';
  const format = options.format ?? 'two-panel';
  const profile = options.profile ?? 'auto';

  // 1. Build snapshot from candidate files if provided
  let candidateSnapshot: SealedJavaSnapshotInput;
  if (options.snapshot) {
    candidateSnapshot = options.snapshot;
  } else if (options.candidateFiles) {
    const files = options.candidateFiles;
    const isProvider = 'readTextFile' in files && typeof (files as any).readTextFile === 'function';
    candidateSnapshot = isProvider
      ? {
          root: 'candidate-snapshot',
          trackedFiles: (files as JavaSnapshotProvider).trackedFiles,
          readTextFile: (relPath: string) => (files as JavaSnapshotProvider).readTextFile(relPath)
        }
      : {
          root: 'candidate-snapshot',
          trackedFiles: Object.keys(files).sort(),
          readTextFile: (relPath: string) => (files as Record<string, string>)[relPath]
        };
  } else {
    throw new Error('Cannot run Java analysis without snapshot or candidateFiles provided.');
  }

  // 2. Run Phase J-8.5 Repository Qualification Gate
  const qualification = JavaRepositoryQualifier.qualify(candidateSnapshot, repoId);

  // 3. Determine execution mode
  const shouldAttemptCertified =
    profile === 'f0' ||
    (profile === 'auto' && qualification.qualificationStatus === 'QUALIFIED_FOR_CERTIFIED_F0');

  // 4. Run Advisory Impact Analysis if historical files are present
  let advisoryResult: JavaAdvisoryImpactResult | undefined = undefined;
  let certifiedProofResult: any = undefined;
  let consumerCertificates: JavaConsumerCertificate[] = [];

  if (options.historicalFiles && options.candidateFiles) {
    const parent = {
      commitSha: 'historical-commit',
      files: options.historicalFiles
    };
    const candidate = {
      commitSha: 'candidate-commit',
      files: options.candidateFiles
    };

    const analyzer = new AdvisoryJavaImpactAnalyzer();
    advisoryResult = analyzer.analyze({
      parent,
      candidate,
      target: options.targetSymbol ? { fqcn: options.targetSymbol } : undefined
    });

    // 5. Evaluate Per-Consumer Certification
    if (advisoryResult && options.historicalFiles && options.candidateFiles) {
      const host = new JavaSealedCompilerHost(candidateSnapshot);
      const histFiles = options.historicalFiles;
      const isHistProvider = 'readTextFile' in histFiles && typeof (histFiles as any).readTextFile === 'function';
      const histHost = new JavaSealedCompilerHost(isHistProvider
        ? {
            root: 'historical-snapshot',
            trackedFiles: (histFiles as JavaSnapshotProvider).trackedFiles,
            readTextFile: (relPath: string) => (histFiles as JavaSnapshotProvider).readTextFile(relPath)
          }
        : {
            root: 'historical-snapshot',
            trackedFiles: Object.keys(histFiles).sort(),
            readTextFile: (relPath: string) => (histFiles as Record<string, string>)[relPath]
          }
      );

      consumerCertificates = JavaPerConsumerCertification.certifyAll({
        candidateHost: host,
        historicalHost: histHost,
        qualification,
        advisoryResult,
        repoId
      });

      // If qualified for Certified F0, derive representative Panel 1 certified proof
      if (shouldAttemptCertified) {
        // If targetSymbol is specified or a provider narrowed/removed a public method, check provider declaration contract
        let targetSymbolProof: any = undefined;
        const brokenProvider = advisoryResult?.providers.find(p => p.change !== 'CLASS_ADDED');
        const targetFqcn = options.targetSymbol ?? brokenProvider?.fqcn;
        if (targetFqcn) {
          const histTarget = histHost.getClassByFQCN(targetFqcn);
          const candTarget = host.getClassByFQCN(targetFqcn);
          if (histTarget && candTarget) {
            const brokenMethod = histTarget.methods.find(hm => {
              if (hm.visibility !== 'public') return false;
              const cm = candTarget.methods.find(m =>
                m.name === hm.name &&
                m.parameters.length === hm.parameters.length &&
                m.parameters.every((p, idx) => p.type.irContentHash === hm.parameters[idx].type.irContentHash)
              );
              if (!cm) return true; // removed or signature changed!
              if (cm.visibility !== 'public') return true; // narrowed!
              if (cm.returnType.irContentHash !== hm.returnType.irContentHash) return true; // return type changed!
              return false;
            });
            const brokenField = histTarget.fields.find(hf => {
              if (hf.visibility !== 'public' && hf.visibility !== 'protected') return false;
              const cf = candTarget.fields.find(f => f.name === hf.name);
              if (!cf) return true; // removed!
              if (cf.type.irContentHash !== hf.type.irContentHash) return true; // type changed!
              if (cf.visibility !== hf.visibility && cf.visibility !== 'public') return true; // narrowed!
              return false;
            });

            if (brokenMethod) {
              const obligation: JavaSemanticObligation = {
                schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
                obligationId: `ob-${repoId}-${targetFqcn}-${brokenMethod.name}-narrowed`,
                sourceFqcn: targetFqcn,
                targetFqcn: targetFqcn,
                relationKind: 'METHOD_CALL',
                memberSignature: brokenMethod.name,
                evidenceSnapshotRef: 'sealed-snapshot'
              };
              const proofRes = JavaProofProducer.produceProof({
                obligation,
                historicalClass: histTarget,
                candidateClass: candTarget,
                historicalMethod: brokenMethod,
                memberName: brokenMethod.name
              });
              if (proofRes.success && proofRes.proof) {
                const verif = JavaProofChecker.verify(obligation, proofRes.proof);
                targetSymbolProof = {
                  ...verif,
                  obligationDigest: proofRes.proof.obligationDigest,
                  ruleDerivations: proofRes.proof.nodes.map((n: any) => n.ruleId)
                };
              }
            } else if (brokenField) {
              const obligation: JavaSemanticObligation = {
                schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
                obligationId: `ob-${repoId}-${targetFqcn}-${brokenField.name}-field`,
                sourceFqcn: targetFqcn,
                targetFqcn: targetFqcn,
                relationKind: 'FIELD_ACCESS',
                memberSignature: brokenField.name,
                evidenceSnapshotRef: 'sealed-snapshot'
              };
              const proofRes = JavaProofProducer.produceProof({
                obligation,
                historicalClass: histTarget,
                candidateClass: candTarget,
                memberName: brokenField.name
              });
              if (proofRes.success && proofRes.proof) {
                const verif = JavaProofChecker.verify(obligation, proofRes.proof);
                targetSymbolProof = {
                  ...verif,
                  obligationDigest: proofRes.proof.obligationDigest,
                  ruleDerivations: proofRes.proof.nodes.map((n: any) => n.ruleId)
                };
              }
            }
          }
        }

        if (targetSymbolProof && targetSymbolProof.verifiedConclusion === 'INCOMPATIBLE') {
          certifiedProofResult = targetSymbolProof;
        } else if (consumerCertificates.length > 0) {
          const breakingCert = consumerCertificates.find(c => c.verifiedConclusion === 'INCOMPATIBLE');
          const repCert = breakingCert ?? consumerCertificates.find(c => c.verifiedConclusion === 'COMPATIBLE');
          if (repCert && repCert.sourceProof && repCert.obligations.length > 0) {
            const verif = JavaProofChecker.verify(repCert.obligations[0], repCert.sourceProof);
            certifiedProofResult = {
              ...verif,
              obligationDigest: repCert.sourceProof.obligationDigest,
              ruleDerivations: repCert.sourceProof.nodes.map((n: any) => n.ruleId)
            };
          }
        } else if (advisoryResult && advisoryResult.providers.length > 0) {
          // No consumers in repository: verify provider declaration contracts directly
          const firstProvider = advisoryResult.providers[0];
          const histClass = histHost.getClassByFQCN(firstProvider.fqcn);
          const candClass = host.getClassByFQCN(firstProvider.fqcn);
          if (histClass && candClass) {
            const obligation: JavaSemanticObligation = {
              schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
              obligationId: `ob-${repoId}-${firstProvider.fqcn}-direct-contract`,
              sourceFqcn: firstProvider.fqcn,
              targetFqcn: firstProvider.fqcn,
              relationKind: 'SUBTYPE',
              evidenceSnapshotRef: 'sealed-snapshot'
            };
            const proofRes = JavaProofProducer.produceProof({
              obligation,
              historicalClass: histClass,
              candidateClass: candClass
            });
            if (proofRes.success && proofRes.proof) {
              const verif = JavaProofChecker.verify(obligation, proofRes.proof);
              certifiedProofResult = {
                ...verif,
                obligationDigest: proofRes.proof.obligationDigest,
                ruleDerivations: proofRes.proof.nodes.map((n: any) => n.ruleId)
              };
            }
          }
        } else if (host.getAllClasses().length > 0 && histHost.getAllClasses().length > 0) {
          // No API changes (e.g. whitespace, comments): verify nominal preservation of declarations
          const sampleClass = histHost.getAllClasses()[0];
          const candClass = host.getClassByFQCN(sampleClass.fqcn);
          if (sampleClass && candClass) {
            const obligation: JavaSemanticObligation = {
              schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
              obligationId: `ob-${repoId}-${sampleClass.fqcn}-identical`,
              sourceFqcn: sampleClass.fqcn,
              targetFqcn: sampleClass.fqcn,
              relationKind: 'SUBTYPE',
              evidenceSnapshotRef: 'sealed-snapshot'
            };
            const proofRes = JavaProofProducer.produceProof({
              obligation,
              historicalClass: sampleClass,
              candidateClass: candClass
            });
            if (proofRes.success && proofRes.proof) {
              const verif = JavaProofChecker.verify(obligation, proofRes.proof);
              certifiedProofResult = {
                ...verif,
                obligationDigest: proofRes.proof.obligationDigest,
                ruleDerivations: proofRes.proof.nodes.map((n: any) => n.ruleId)
              };
            }
          }
        }
      }
    }
  }

  const reportInput = {
    repositoryId: repoId,
    targetSymbol: options.targetSymbol,
    qualification,
    certifiedProofResult,
    advisoryResult,
    consumerCertificates
  };

  const reportText = JavaTwoPanelReport.formatText(reportInput);
  const reportMarkdown = JavaTwoPanelReport.formatMarkdown(reportInput);
  const reportJson = JavaTwoPanelReport.toJSON(reportInput);

  return {
    qualification,
    reportText,
    reportMarkdown,
    reportJson,
    effectiveVerdict: reportJson.effectiveVerdict,
    advisoryResult,
    consumerCertificates
  };
}

// CLI entry point
if (require.main === module) {
  process.stderr.write('analyzeJava.ts requires revision snapshots. Use "sajimora analyze" or "npm run sajimora:analyze" instead.\n');
  process.exit(1);
}
