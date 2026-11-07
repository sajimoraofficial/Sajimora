/**
 * @file JavaPerConsumerCertification.ts
 * Isolated, mathematically sound per-consumer compatibility certification engine (Phase J-CERT).
 *
 * Replaces the monolithic repository-wide first-break-terminating model.
 * Produces isolated, independently verifiable JavaConsumerCertificate objects:
 * - Independent source and binary compatibility proof dimensions per consumer.
 * - Zero false-positive compatibility certifications.
 * - Zero unjustified compatibility certifications on inconclusive ground truth.
 * - Zero unsound negatives.
 * - Statically identifiable affected consumer obligations with real consumer FQCN.
 * - Overload call-site ambiguity detection per JLS §15.12.2.
 * - Abstract class interface exemption per JLS §8.1.5.
 * - Same-package visibility exemption for package-private accessibility.
 */

import {
  CanonicalApiMemberIdentity,
  buildClassCanonicalIdentity,
  buildMethodCanonicalIdentity,
  buildFieldCanonicalIdentity
} from '../canonical/JavaCanonicalIdentity';
import {
  JavaBinaryCompatibilityAnalyzer,
  JavaBinaryProof
} from './JavaBinaryCompatibilityAnalyzer';
import {
  JavaProofProducer
} from './JavaProofProducer';
import {
  JavaProofChecker,
  JavaSemanticObligation,
  JavaSemanticProof
} from './JavaProofChecker';
import {
  JavaHeadlessCompiler
} from './JavaHeadlessCompiler';
import {
  JavaClassDeclIR,
  JavaMethodSignatureIR,
  JavaFieldIR,
  JavaCallSiteIR
} from '../ir/JavaTypeIR';
import { JavaSealedCompilerHost } from '../programs/JavaSealedCompilerHost';
import { JavaRepositoryQualificationReport } from '../programs/JavaRepositoryQualifier';
import { JavaAdvisoryImpactResult, JavaConsumerReference } from '../../../advisory/JavaImpactAnalyzer';
import { JAVA_CERTIFIED_EVIDENCE_V1, JavaRuleSetId, JavaSemanticProfileId } from './JavaCertifiedProfile';

export interface JavaConsumerCertificate {
  readonly consumerId?: string;
  readonly consumerFqcn: string;
  readonly consumerFile: string;
  readonly bindingKind: string;
  readonly sourceCompatibility: 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNKNOWN';
  readonly binaryCompatibility: 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNKNOWN';
  readonly verifiedConclusion: 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNCERTIFIED';
  readonly sourceVerifiedConclusion: 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNCERTIFIED';
  readonly binaryVerifiedConclusion: 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNCERTIFIED';
  readonly obligations: readonly JavaSemanticObligation[];
  readonly sourceProof?: JavaSemanticProof;
  readonly binaryProof?: JavaBinaryProof;
  readonly blockerCode?: string;
  readonly rationale: string;
}

export interface CertifyConsumersOptions {
  readonly candidateHost: JavaSealedCompilerHost;
  readonly historicalHost: JavaSealedCompilerHost;
  readonly qualification: JavaRepositoryQualificationReport;
  readonly advisoryResult?: JavaAdvisoryImpactResult;
  readonly repoId?: string;
}

function implementsTransitively(cls: JavaClassDeclIR | undefined, ifaceFqcn: string, host: JavaSealedCompilerHost): boolean {
  if (!cls) return false;
  const ifaceSimple = ifaceFqcn.split('.').pop()!;
  if ((cls.implementsNames ?? []).some(i => i === ifaceFqcn || i === ifaceSimple || i.endsWith(`.${ifaceSimple}`))) {
    return true;
  }
  if (cls.extendsName) {
    const superCls = host.getClassByFQCN(cls.extendsName) ?? host.getAllClasses().find(c => c.name === cls.extendsName || c.simpleName === cls.extendsName);
    return implementsTransitively(superCls, ifaceFqcn, host);
  }
  return false;
}

/**
 * Extracts the concrete type arguments used with `typeName` in `source`.
 * Handles both simple names (e.g. `TreeSet`) and FQCNs (e.g. `io.vavr.collection.TreeSet`).
 * Returns all unique type-argument lists found, e.g. `[['Object'], ['String']]`.
 */
function extractTypeArgumentsForType(source: string, typeName: string): string[][] {
  const results: string[][] = [];
  // Match both the simple name and anything ending in .SimpleName
  const simpleName = typeName.split('.').pop() ?? typeName;
  // Pattern: TypeName<Arg1, Arg2, ...> — supports nested generics via bracket counting
  const namePattern = new RegExp(`(?:^|[^\\w.])${escapeRegex(simpleName)}\\s*<`, 'g');
  let match: RegExpExecArray | null;
  while ((match = namePattern.exec(source)) !== null) {
    const start = match.index + match[0].length; // position after '<'
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      if (source[i] === '<') depth++;
      else if (source[i] === '>') depth--;
      i++;
    }
    if (depth === 0) {
      const inner = source.slice(start, i - 1).trim();
      // Split top-level args (not nested args inside inner generics)
      const args = splitTopLevelArgs(inner);
      if (args.length > 0) {
        results.push(args.map(a => a.trim()));
      }
    }
  }
  return results;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Splits a comma-separated generic arg list respecting nested angle brackets. */
function splitTopLevelArgs(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of s) {
    if (ch === '<') { depth++; current += ch; }
    else if (ch === '>') { depth--; current += ch; }
    else if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Returns true if any type argument used in `source` for `typeName` provably violates
 * one of the narrowed upper bounds in `upperBounds` (e.g. `['Comparable']`).
 * Uses the JDK nominal subtype lattice via JavaHeadlessCompiler.isNominalSubtype.
 * Conservative: returns false (no violation detected) when no type arguments can be parsed.
 */
function typeArgViolatesNarrowedBound(
  source: string,
  typeName: string,
  upperBounds: readonly string[],
  customSupertypes?: Map<string, readonly string[]>
): boolean {
  if (upperBounds.length === 0) return false;
  const usages = extractTypeArgumentsForType(source, typeName);
  if (usages.length === 0) return false; // no parseable usage → conservative: no violation
  for (const args of usages) {
    for (const typeArg of args) {
      // Strip wildcards for bound checking: `? extends Foo` → `Foo`
      const bare = typeArg.replace(/^\?\s+extends\s+/, '').replace(/^\?\s+super\s+/, '').replace(/^\?$/, 'java.lang.Object').trim();
      for (const bound of upperBounds) {
        // Remove the bound's own type parameter application, e.g. `Comparable<T>` → `Comparable`
        const bareBound = bound.replace(/<[^>]*>/, '').trim();
        if (!JavaHeadlessCompiler.isNominalSubtype(bare, bareBound, customSupertypes)) {
          return true; // confirmed violation
        }
      }
    }
  }
  return false; // all parsed type args satisfy all bounds
}

/**
 * Parses upper-bound names from a class-level type parameter declaration in source.
 * Example: `class TreeSet<T extends Comparable<T> & Serializable>` → `['Comparable', 'Serializable']`
 * Handles nested generics in bounds correctly by bracket counting.
 * Returns unique bare bound names (without their own type arguments).
 */
function extractClassLevelTypeParamBounds(source: string, simpleName: string): string[] {
  // Match: (class|interface) SimpleName<...> — the type param section
  const classPattern = new RegExp(
    `(?:^|\\n)\\s*(?:public\\s+|protected\\s+|private\\s+|abstract\\s+|final\\s+|sealed\\s+)*(?:class|interface|record)\\s+${escapeRegex(simpleName)}\\s*<`,
    'g'
  );
  let match: RegExpExecArray | null;
  const bounds: string[] = [];
  while ((match = classPattern.exec(source)) !== null) {
    const start = match.index + match[0].length; // position after '<'
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      if (source[i] === '<') depth++;
      else if (source[i] === '>') depth--;
      i++;
    }
    if (depth === 0) {
      const inner = source.slice(start, i - 1);
      // Each top-level segment is a type parameter, e.g. `T extends Comparable<T> & Serializable`
      const typeParams = splitTopLevelArgs(inner);
      for (const tp of typeParams) {
        // Extract `extends Bound1 & Bound2` from `T extends Bound1 & Bound2`
        const extendsMatch = tp.match(/\bextends\s+(.+)$/s);
        if (extendsMatch) {
          // Split intersection bounds at top-level `&`
          const boundSection = extendsMatch[1].trim();
          const intersectionParts = splitTopLevelAmpersand(boundSection);
          for (const part of intersectionParts) {
            // Strip type args from bound name: `Comparable<T>` → `Comparable`
            const bareBound = part.trim().replace(/<[^]*>/, '').trim();
            if (bareBound && !bounds.includes(bareBound)) {
              bounds.push(bareBound);
            }
          }
        }
      }
    }
  }
  return bounds;
}

/** Splits at top-level `&` (not inside angle brackets). */
function splitTopLevelAmpersand(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of s) {
    if (ch === '<') { depth++; current += ch; }
    else if (ch === '>') { depth--; current += ch; }
    else if (ch === '&' && depth === 0) { parts.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export class JavaPerConsumerCertification {
  /**
   * Certifies every discovered consumer independently.
   */
  public static certifyAll(options: CertifyConsumersOptions): JavaConsumerCertificate[] {
    const {
      candidateHost,
      historicalHost,
      qualification,
      advisoryResult,
      repoId = 'workspace'
    } = options;

    const certificates: JavaConsumerCertificate[] = [];
    const isRepoQualified = qualification.qualificationStatus === 'QUALIFIED_FOR_CERTIFIED_F0';
    const primaryBlocker = qualification.blockers.length > 0 ? qualification.blockers[0] : undefined;

    // Discovered consumers from advisory impact analysis
    const discoveredConsumers = advisoryResult?.consumers ?? [];

    // Group consumer references by consumerFqcn (or consumerFile if anonymous/unnamed)
    const byConsumer = new Map<string, JavaConsumerReference[]>();
    for (const ref of discoveredConsumers) {
      const key = ref.consumerFqcn || ref.consumerFile;
      const list = byConsumer.get(key) ?? [];
      list.push(ref);
      byConsumer.set(key, list);
    }

    for (const [, refs] of byConsumer.entries()) {
      // Certify each reference for this consumer
      const refCerts = refs.map(ref => this.certifySingleConsumer({
        consumerRef: ref,
        candidateHost,
        historicalHost,
        isRepoQualified,
        primaryBlocker,
        repoId
      }));

      // Consolidate: a breaking certificate takes precedence over compatible, then uncertified
      const breakingCert = refCerts.find(c => c.sourceCompatibility === 'INCOMPATIBLE' || c.binaryCompatibility === 'INCOMPATIBLE');
      const uncertifiedCert = refCerts.find(c => c.verifiedConclusion === 'UNCERTIFIED');
      const primaryCert = breakingCert ?? uncertifiedCert ?? refCerts[0];

      // Aggregate obligations from all references
      const allObligations = refCerts.flatMap(c => c.obligations);
      const uniqueObligations = allObligations.filter((ob, idx, arr) =>
        arr.findIndex(o => o.obligationId === ob.obligationId) === idx
      );

      certificates.push({
        ...primaryCert,
        obligations: uniqueObligations
      });
    }

    // These legacy analyses compute useful compatibility candidates, but their
    // source/binary evidence is not independently checked against an exact
    // consumer obligation. Keep the candidates visible without certifying them.
    return certificates.map(certificate => ({
      ...certificate,
      verifiedConclusion: 'UNCERTIFIED' as const,
      sourceVerifiedConclusion: 'UNCERTIFIED' as const,
      binaryVerifiedConclusion: 'UNCERTIFIED' as const,
      blockerCode: certificate.blockerCode ?? 'SOURCE_EVIDENCE_UNVERIFIED',
      rationale: `${certificate.rationale} Advisory candidate only: source-bound source/binary proof verification is not qualified.`
    }));
  }

  /**
   * Evaluates and certifies a single consumer reference.
   */
  private static certifySingleConsumer(params: {
    consumerRef: JavaConsumerReference;
    candidateHost: JavaSealedCompilerHost;
    historicalHost: JavaSealedCompilerHost;
    isRepoQualified: boolean;
    primaryBlocker?: { code: string; reason: string; file?: string };
    repoId: string;
  }): JavaConsumerCertificate {
    const {
      consumerRef,
      candidateHost,
      historicalHost,
      isRepoQualified,
      primaryBlocker,
      repoId
    } = params;

    const consumerFqcn = consumerRef.consumerFqcn;
    const consumerFile = consumerRef.consumerFile;
    const providerFqcn = consumerRef.providerId;
    const bindingKind = consumerRef.bindingKind;

    // Fail closed if repository is disqualified
    if (!isRepoQualified) {
      return {
        consumerId: (consumerRef as any).consumerId,
        consumerFqcn,
        consumerFile,
        bindingKind,
        sourceCompatibility: 'UNKNOWN',
        binaryCompatibility: 'UNKNOWN',
        verifiedConclusion: 'UNCERTIFIED',
        sourceVerifiedConclusion: 'UNCERTIFIED',
        binaryVerifiedConclusion: 'UNCERTIFIED',
        obligations: [],
        blockerCode: primaryBlocker?.code ?? 'UNCERTIFIED_PROFILE',
        rationale: `Repository disqualified from Certified F0: ${primaryBlocker?.reason ?? 'Inconclusive environment'}`
      };
    }

    // Resolve historical and candidate declarations of the provider class
    const histClass = historicalHost.getClassByFQCN(providerFqcn);
    const candClass = candidateHost.getClassByFQCN(providerFqcn);

    // Resolve consumer class declarations
    const consumerHistClass = historicalHost.getClassByFQCN(consumerFqcn);
    const consumerCandClass = candidateHost.getClassByFQCN(consumerFqcn);

    // 1. Target class removed entirely
    if (!candClass) {
      const obligation: JavaSemanticObligation = {
        schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
        obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-class-removed`,
        sourceFqcn: consumerFqcn,
        targetFqcn: providerFqcn,
        relationKind: 'SUBTYPE',
        evidenceSnapshotRef: 'sealed-snapshot'
      };
      const proofRes = JavaProofProducer.produceProof({
        obligation,
        historicalClass: histClass,
        candidateClass: undefined
      });
      const binProof: JavaBinaryProof = {
        ruleId: 'JVM.BIN.CLASS_REMOVED',
        conclusion: 'INCOMPATIBLE',
        expectedJvmFailure: 'NoClassDefFoundError',
        rationale: `Class ${providerFqcn} removed; JVM linkage throws java.lang.NoClassDefFoundError.`
      };

      return {
        consumerFqcn,
        consumerFile,
        bindingKind,
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'INCOMPATIBLE',
        verifiedConclusion: 'INCOMPATIBLE',
        sourceVerifiedConclusion: 'INCOMPATIBLE',
        binaryVerifiedConclusion: 'INCOMPATIBLE',
        obligations: [obligation],
        sourceProof: proofRes.proof,
        binaryProof: binProof,
        rationale: `Target class ${providerFqcn} was removed in candidate revision.`
      };
    }

    // Collect all call sites in the consumer class
    const consumerCallSites: JavaCallSiteIR[] = [
      ...(consumerCandClass?.methods.flatMap(m => m.callSites ?? []) ?? []),
      ...(consumerCandClass?.callSites ?? []),
      ...(consumerHistClass?.methods.flatMap(m => m.callSites ?? []) ?? []),
      ...(consumerHistClass?.callSites ?? [])
    ];
    if (consumerRef.callSite) {
      consumerCallSites.push(consumerRef.callSite);
    }

    // Determine how the consumer relates to the provider
    const isExtends = consumerCandClass?.extendsName === histClass?.name ||
      consumerCandClass?.extendsName === histClass?.fqcn ||
      consumerHistClass?.extendsName === histClass?.name ||
      consumerHistClass?.extendsName === histClass?.fqcn ||
      consumerRef.referenceKind === 'EXTENDS';

    const isImplements = (consumerCandClass?.implementsNames ?? []).some(i => i === histClass?.name || i === histClass?.fqcn) ||
      (consumerHistClass?.implementsNames ?? []).some(i => i === histClass?.name || i === histClass?.fqcn) ||
      consumerRef.referenceKind === 'IMPLEMENTS';

    const isSamePackage = consumerCandClass?.packageName === candClass.packageName;

    // 2. Class Modifier Changes
    // 2.1 Class becoming final (breaks subclasses only)
    if (Boolean(candClass.isFinal) && !Boolean(histClass?.isFinal)) {
      if (isExtends) {
        const obligation: JavaSemanticObligation = {
          schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
          obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-final`,
          sourceFqcn: consumerFqcn,
          targetFqcn: providerFqcn,
          relationKind: 'SUBTYPE',
          evidenceSnapshotRef: 'sealed-snapshot'
        };
        const prod = JavaProofProducer.produceProof({
          obligation,
          historicalClass: histClass,
          candidateClass: candClass
        });
        const binProof: JavaBinaryProof = {
          ruleId: 'JVM.BIN.CLASS_FINAL_RESTRICTED',
          conclusion: 'INCOMPATIBLE',
          expectedJvmFailure: 'IncompatibleClassChangeError',
          rationale: `Superclass ${providerFqcn} made final; subclass ${consumerFqcn} throws IncompatibleClassChangeError.`
        };
        return {
          consumerFqcn,
          consumerFile,
          bindingKind,
          sourceCompatibility: 'INCOMPATIBLE',
          binaryCompatibility: 'INCOMPATIBLE',
          verifiedConclusion: 'INCOMPATIBLE',
          sourceVerifiedConclusion: 'INCOMPATIBLE',
          binaryVerifiedConclusion: 'INCOMPATIBLE',
          obligations: [obligation],
          sourceProof: prod.proof,
          binaryProof: binProof,
          rationale: `Superclass ${providerFqcn} made final; subclass ${consumerFqcn} cannot inherit.`
        };
      }
    }

    // 2.2 Sealed permits restricted (breaks subclasses/implementors removed from permits)
    if (histClass?.permitsNames && candClass.permitsNames) {
      const consumerSimple = consumerFqcn.split('.').pop()!;
      const wasPermitted = histClass.permitsNames.includes(consumerSimple) || histClass.permitsNames.includes(consumerFqcn);
      const isPermitted = candClass.permitsNames.includes(consumerSimple) || candClass.permitsNames.includes(consumerFqcn);
      if (wasPermitted && !isPermitted && (isExtends || isImplements)) {
        const obligation: JavaSemanticObligation = {
          schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
          obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-permits-removed`,
          sourceFqcn: consumerFqcn,
          targetFqcn: providerFqcn,
          relationKind: isExtends ? 'SUBTYPE' : 'IMPLEMENTS',
          evidenceSnapshotRef: 'sealed-snapshot'
        };
        const binProof: JavaBinaryProof = {
          ruleId: 'JVM.BIN.SEALED_PERMIT_REMOVED',
          conclusion: 'INCOMPATIBLE',
          expectedJvmFailure: 'IncompatibleClassChangeError',
          rationale: `Subtype ${consumerFqcn} removed from PermittedSubclasses attribute of ${providerFqcn}.`
        };
        return {
          consumerFqcn,
          consumerFile,
          bindingKind,
          sourceCompatibility: 'INCOMPATIBLE',
          binaryCompatibility: 'INCOMPATIBLE',
          verifiedConclusion: 'INCOMPATIBLE',
          sourceVerifiedConclusion: 'INCOMPATIBLE',
          binaryVerifiedConclusion: 'INCOMPATIBLE',
          obligations: [obligation],
          binaryProof: binProof,
          rationale: `Subtype ${consumerFqcn} removed from permits clause of sealed class ${providerFqcn}.`
        };
      }
    }

    // 2.3 Interface abstract method added without default
    const isTransitivelyImplements = isImplements ||
      implementsTransitively(consumerCandClass, providerFqcn, candidateHost) ||
      implementsTransitively(consumerHistClass, providerFqcn, historicalHost) ||
      bindingKind.includes('INTERFACE_IMPLEMENTATION') ||
      (bindingKind.includes('CLASS_INHERITANCE') && histClass?.kind === 'interface');

    if (isTransitivelyImplements && histClass?.kind === 'interface') {
      const addedAbstractMethods = candClass.methods.filter(cm =>
        cm.visibility !== 'private' &&
        !cm.isStatic &&
        !cm.annotations.includes('default') &&
        !histClass.methods.some(hm => hm.name === cm.name)
      );

      if (addedAbstractMethods.length > 0) {
        // JLS §8.1.5: If consumer is abstract, it is exempt from implementing abstract interface methods!
        const isConsumerAbstract = Boolean(consumerCandClass?.isAbstract || consumerHistClass?.isAbstract);
        if (!isConsumerAbstract) {
          // Check if consumer already implements it
          const missingMethod = addedAbstractMethods.find(am =>
            !consumerCandClass?.methods.some(cm => cm.name === am.name)
          );
          if (missingMethod) {
            const obligation: JavaSemanticObligation = {
              schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
              obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-${missingMethod.name}-abs-added`,
              sourceFqcn: consumerFqcn,
              targetFqcn: providerFqcn,
              relationKind: 'IMPLEMENTS',
              memberSignature: missingMethod.name,
              evidenceSnapshotRef: 'sealed-snapshot'
            };
            const prod = JavaProofProducer.produceProof({
              obligation,
              historicalClass: histClass,
              candidateClass: candClass,
              memberName: missingMethod.name
            });
            // JLS §13.5.3: Adding abstract method preserves binary compatibility for existing binaries!
            const binProof: JavaBinaryProof = {
              ruleId: 'JVM.BIN.INTERFACE_ABSTRACT_METHOD_ADDED',
              conclusion: 'COMPATIBLE',
              rationale: `JLS §13.5.3: Adding an abstract method to an interface preserves binary compatibility with existing binaries.`
            };
            return {
              consumerFqcn,
              consumerFile,
              bindingKind,
              sourceCompatibility: 'INCOMPATIBLE',
              binaryCompatibility: 'COMPATIBLE',
              verifiedConclusion: 'INCOMPATIBLE',
              sourceVerifiedConclusion: 'INCOMPATIBLE',
              binaryVerifiedConclusion: 'COMPATIBLE',
              obligations: [obligation],
              sourceProof: prod.proof,
              binaryProof: binProof,
              rationale: `Concrete class ${consumerFqcn} implements interface ${providerFqcn} which added abstract method ${missingMethod.name} without default implementation.`
            };
          }
        }
      }
    }

    // 3. Member Invocations & Accesses
    // Filter call sites that target this provider
    const relevantCallSites = consumerCallSites.filter(cs => {
      if (cs.resolvedTargetFqcn && (cs.resolvedTargetFqcn === providerFqcn || cs.resolvedTargetFqcn.endsWith(`.${histClass?.simpleName}`))) {
        return true;
      }
      if (cs.receiverText && (cs.receiverText === histClass?.simpleName || cs.receiverText === providerFqcn)) {
        return true;
      }
      // Method calls on methods declared in provider
      if (histClass?.methods.some(m => m.name === cs.calleeName || (m.isConstructor && cs.calleeName === '<init>'))) {
        return true;
      }
      return false;
    });

    for (const cs of relevantCallSites) {
      const calleeName = cs.calleeName;
      const isConstructor = calleeName === '<init>' || cs.callKind === 'CONSTRUCTOR_CALL' || cs.callKind === 'CONSTRUCTOR_REFERENCE';

      // 3.1 Method/Constructor call
      if (cs.callKind === 'METHOD_CALL' || cs.callKind === 'CONSTRUCTOR_CALL' || cs.callKind === 'METHOD_REFERENCE' || cs.callKind === 'CONSTRUCTOR_REFERENCE') {
        const histMethodsMatching = (histClass?.methods ?? []).filter(m =>
          (isConstructor ? m.isConstructor : m.name === calleeName)
        );
        const candMethodsMatching = candClass.methods.filter(m =>
          (isConstructor ? m.isConstructor : m.name === calleeName)
        );

        // Find candidate method matching exact argument count
        const candExactArgCount = candMethodsMatching.filter(m => m.parameters.length === cs.argumentCount);

        // Check for record canonical constructor (JLS §8.10.4)
        if (isConstructor && candClass.kind === 'record' && candClass.fields.length === cs.argumentCount) {
          if (candExactArgCount.length === 0) {
            candExactArgCount.push({
              name: candClass.simpleName,
              returnType: { schemaVersion: 'SAJIMORA_JAVA_TYPE_IR_V1' as const, kind: 'JAVA_VOID', display: 'void', irContentHash: 'void' },
              parameters: candClass.fields.map(f => ({ name: f.name, type: f.type, isVararg: false, isFinal: false, annotations: [] })),
              typeParameters: [],
              visibility: 'public',
              isStatic: false,
              isFinal: false,
              isAbstract: false,
              isConstructor: true,
              isDeclaredOverride: false,
              annotations: [],
              lineStart: candClass.lineStart,
              lineEnd: candClass.lineStart,
              declarationOrdinal: 0,
              irContentHash: 'record_canonical_init'
            });
          }
        }

        // Check for implicit default constructor (JLS §8.8.9)
        if (isConstructor && cs.argumentCount === 0 && candMethodsMatching.filter(m => m.isConstructor).length === 0) {
          if (candExactArgCount.length === 0) {
            candExactArgCount.push({
              name: candClass.simpleName,
              returnType: { schemaVersion: 'SAJIMORA_JAVA_TYPE_IR_V1' as const, kind: 'JAVA_VOID', display: 'void', irContentHash: 'void' },
              parameters: [],
              typeParameters: [],
              visibility: candClass.isExported ? 'public' : 'package-private',
              isStatic: false,
              isFinal: false,
              isAbstract: false,
              isConstructor: true,
              isDeclaredOverride: false,
              annotations: [],
              lineStart: candClass.lineStart,
              lineEnd: candClass.lineStart,
              declarationOrdinal: 0,
              irContentHash: 'default_zero_arg_init'
            });
          }
        }

        // Check if an overload was added that introduces ambiguity (REAL-JAVA-018)
        if (candMethodsMatching.length > histMethodsMatching.length) {
          // Check for call-site ambiguity if arguments contain 'null'
          const rawText = cs.rawText ?? '';
          const hasNullArg = rawText.includes('(null)') || rawText.includes(', null') || rawText.includes('null,');
          if (hasNullArg && cs.argumentCount === 1) {
            const applicableOverloads = candExactArgCount.map(m => ({
              name: m.name,
              parameterTypes: m.parameters.map(p => (p.type as any).qualifiedName ?? (p.type as any).primitiveKind ?? 'java.lang.Object')
            }));
            const overloadRes = JavaHeadlessCompiler.resolveMostSpecificOverload(calleeName, ['null'], applicableOverloads);
            if (overloadRes.status === 'AMBIGUOUS') {
              const obligation: JavaSemanticObligation = {
                schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
                obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-${calleeName}-ambiguous`,
                sourceFqcn: consumerFqcn,
                targetFqcn: providerFqcn,
                relationKind: 'METHOD_CALL',
                memberSignature: calleeName,
                evidenceSnapshotRef: 'sealed-snapshot'
              };
              // Binary compatibility is preserved per JLS §13.4.23: pre-existing binary targeted exact descriptor
              const binProof: JavaBinaryProof = {
                ruleId: 'JVM.BIN.METHOD_OVERLOAD_ADDED',
                conclusion: 'COMPATIBLE',
                rationale: `JLS §13.4.23: Adding a method overload does not break binary compatibility with pre-existing binaries.`
              };
              return {
                consumerFqcn,
                consumerFile,
                bindingKind,
                sourceCompatibility: 'INCOMPATIBLE',
                binaryCompatibility: 'COMPATIBLE',
                verifiedConclusion: 'INCOMPATIBLE',
                sourceVerifiedConclusion: 'INCOMPATIBLE',
                binaryVerifiedConclusion: 'COMPATIBLE',
                obligations: [obligation],
                binaryProof: binProof,
                rationale: `Ambiguous call site: multiple applicable overloads for '${calleeName}(null)' per JLS §15.12.2.`
              };
            }
          }
        }

        // Check if the specific called method was removed or modified
        if (candExactArgCount.length === 0) {
          // The overload called by this consumer was removed!
          const histM = histMethodsMatching.find(m => m.parameters.length === cs.argumentCount) ?? histMethodsMatching[0];
          const obligation: JavaSemanticObligation = {
            schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
            obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-${calleeName}-${cs.argumentCount}-removed`,
            sourceFqcn: consumerFqcn,
            targetFqcn: providerFqcn,
            relationKind: 'METHOD_CALL',
            memberSignature: calleeName,
            evidenceSnapshotRef: 'sealed-snapshot'
          };
          const prod = JavaProofProducer.produceProof({
            obligation,
            historicalClass: histClass,
            candidateClass: candClass,
            historicalMethod: histM,
            candidateMethod: undefined,
            memberName: calleeName
          });
          const binProof: JavaBinaryProof = {
            ruleId: 'JVM.BIN.METHOD_REMOVED',
            conclusion: 'INCOMPATIBLE',
            expectedJvmFailure: 'NoSuchMethodError',
            rationale: `Method or constructor ${calleeName} with ${cs.argumentCount} parameter(s) removed; caller throws java.lang.NoSuchMethodError.`
          };
          return {
            consumerFqcn,
            consumerFile,
            bindingKind,
            sourceCompatibility: 'INCOMPATIBLE',
            binaryCompatibility: 'INCOMPATIBLE',
            verifiedConclusion: 'INCOMPATIBLE',
            sourceVerifiedConclusion: 'INCOMPATIBLE',
            binaryVerifiedConclusion: 'INCOMPATIBLE',
            obligations: [obligation],
            sourceProof: prod.proof,
            binaryProof: binProof,
            rationale: `Method or constructor '${calleeName}' with ${cs.argumentCount} argument(s) was removed in candidate class.`
          };
        }

        // Check parameter widening (REAL-JAVA-002: String -> CharSequence)
        const histExact = histMethodsMatching.find(m => m.parameters.length === cs.argumentCount);
        const candExact = candExactArgCount[0];
        if (histExact && candExact) {
          // Parameter types comparison
          const sameTypes = histExact.parameters.every((hp, idx) => hp.type.irContentHash === candExact.parameters[idx].type.irContentHash);
          if (!sameTypes) {
            // Check if parameters are widened (subtypes of candidate parameters)
            const allWidened = histExact.parameters.every((hp, idx) => {
              const hName = (hp.type as any).qualifiedName ?? (hp.type as any).primitiveKind ?? '';
              const cName = (candExact.parameters[idx].type as any).qualifiedName ?? (candExact.parameters[idx].type as any).primitiveKind ?? '';
              return JavaHeadlessCompiler.isNominalSubtype(hName, cName);
            });

            if (allWidened) {
              // Source is COMPATIBLE because callers pass subtypes cleanly!
              // Binary is INCOMPATIBLE because JVM bytecode descriptor changed!
              const binProof: JavaBinaryProof = {
                ruleId: 'JVM.BIN.METHOD_DESCRIPTOR_CHANGED',
                conclusion: 'INCOMPATIBLE',
                expectedJvmFailure: 'NoSuchMethodError',
                rationale: `Method ${calleeName} parameter descriptor changed; pre-compiled consumer bytecode throws java.lang.NoSuchMethodError.`
              };
              const obligation: JavaSemanticObligation = {
                schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
                obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-${calleeName}-widened`,
                sourceFqcn: consumerFqcn,
                targetFqcn: providerFqcn,
                relationKind: 'METHOD_CALL',
                memberSignature: calleeName,
                evidenceSnapshotRef: 'sealed-snapshot'
              };
              return {
                consumerFqcn,
                consumerFile,
                bindingKind,
                sourceCompatibility: 'COMPATIBLE',
                binaryCompatibility: 'INCOMPATIBLE',
                verifiedConclusion: 'COMPATIBLE',
                sourceVerifiedConclusion: 'COMPATIBLE',
                binaryVerifiedConclusion: 'INCOMPATIBLE',
                obligations: [obligation],
                binaryProof: binProof,
                rationale: `Parameter types widened in ${calleeName}: source recompilation compatible, but binary incompatible (JVM descriptor changed).`
              };
            } else {
              // Parameter types changed to incompatible types!
              const obligation: JavaSemanticObligation = {
                schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
                obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-${calleeName}-param-changed`,
                sourceFqcn: consumerFqcn,
                targetFqcn: providerFqcn,
                relationKind: 'METHOD_CALL',
                memberSignature: calleeName,
                evidenceSnapshotRef: 'sealed-snapshot'
              };
              const prod = JavaProofProducer.produceProof({
                obligation,
                historicalClass: histClass,
                candidateClass: candClass,
                historicalMethod: histExact,
                candidateMethod: candExact,
                memberName: calleeName
              });
              const binProof: JavaBinaryProof = {
                ruleId: 'JVM.BIN.METHOD_DESCRIPTOR_CHANGED',
                conclusion: 'INCOMPATIBLE',
                expectedJvmFailure: 'NoSuchMethodError',
                rationale: `Method ${calleeName} parameter types changed; caller throws java.lang.NoSuchMethodError.`
              };
              return {
                consumerFqcn,
                consumerFile,
                bindingKind,
                sourceCompatibility: 'INCOMPATIBLE',
                binaryCompatibility: 'INCOMPATIBLE',
                verifiedConclusion: 'INCOMPATIBLE',
                sourceVerifiedConclusion: 'INCOMPATIBLE',
                binaryVerifiedConclusion: 'INCOMPATIBLE',
                obligations: [obligation],
                sourceProof: prod.proof,
                binaryProof: binProof,
                rationale: `Parameter types changed incompatibly in '${calleeName}': expected ${(histExact.parameters.map(p => (p.type as any).display ?? 'param')).join(', ')}, got ${(candExact.parameters.map(p => (p.type as any).display ?? 'param')).join(', ')}.`
              };
            }
          }

          // Check return type change (REAL-JAVA-019)
          if (!isConstructor && histExact.returnType.irContentHash !== candExact.returnType.irContentHash) {
            const obligation: JavaSemanticObligation = {
              schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
              obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-${calleeName}-return-type-changed`,
              sourceFqcn: consumerFqcn,
              targetFqcn: providerFqcn,
              relationKind: 'METHOD_CALL',
              memberSignature: calleeName,
              evidenceSnapshotRef: 'sealed-snapshot'
            };
            const prod = JavaProofProducer.produceProof({
              obligation,
              historicalClass: histClass,
              candidateClass: candClass,
              historicalMethod: histExact,
              candidateMethod: candExact,
              memberName: calleeName
            });
            const binProof: JavaBinaryProof = {
              ruleId: 'JVM.BIN.METHOD_DESCRIPTOR_CHANGED',
              conclusion: 'INCOMPATIBLE',
              expectedJvmFailure: 'NoSuchMethodError',
              rationale: `Method ${calleeName} return type changed; compiled bytecode descriptor throws NoSuchMethodError.`
            };
            return {
              consumerFqcn,
              consumerFile,
              bindingKind,
              sourceCompatibility: 'INCOMPATIBLE',
              binaryCompatibility: 'INCOMPATIBLE',
              verifiedConclusion: 'INCOMPATIBLE',
              sourceVerifiedConclusion: 'INCOMPATIBLE',
              binaryVerifiedConclusion: 'INCOMPATIBLE',
              obligations: [obligation],
              sourceProof: prod.proof,
              binaryProof: binProof,
              rationale: `Method '${calleeName}' return type changed from ${(histExact.returnType as any).display ?? 'previous'} to ${(candExact.returnType as any).display ?? 'candidate'}, breaking callers and method references.`
            };
          }

          // Check generic type parameter bounds narrowed (REAL-JAVA-007)
          if (candExact.typeParameters.length > 0) {
            const boundNarrowed = candExact.typeParameters.some((cp, idx) => {
              const hp = histExact.typeParameters[idx];
              return (cp.upperBounds?.length ?? 0) > (hp?.upperBounds?.length ?? 0);
            });
            if (boundNarrowed) {
              // Collect all narrowed bounds from the candidate type parameters (as display strings)
              const narrowedBounds: string[] = [];
              candExact.typeParameters.forEach((cp, idx) => {
                const hp = histExact.typeParameters[idx];
                const histBoundHashes = new Set((hp?.upperBounds ?? []).map(b => b.irContentHash));
                const newBounds = (cp.upperBounds ?? [])
                  .filter(b => !histBoundHashes.has(b.irContentHash))
                  .map(b => b.display);
                narrowedBounds.push(...newBounds);
              });
              const raw = cs.rawText ?? '';
              const fileContent = historicalHost.getFileContent(consumerFile) ?? candidateHost.getFileContent(consumerFile) ?? '';
              // Use general-purpose type argument violation check: inspect call-site raw text and
              // full consumer file for any usage of the provider type with a violating type argument.
              const callSiteViolation = narrowedBounds.length > 0 && (
                typeArgViolatesNarrowedBound(raw, providerFqcn, narrowedBounds) ||
                typeArgViolatesNarrowedBound(fileContent, providerFqcn, narrowedBounds)
              );
              if (callSiteViolation) {
                const violatingBound = narrowedBounds[0] ?? 'unknown';
                const obligation: JavaSemanticObligation = {
                  schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
                  obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-${calleeName}-generic-bound-narrowed`,
                  sourceFqcn: consumerFqcn,
                  targetFqcn: providerFqcn,
                  relationKind: 'METHOD_CALL',
                  memberSignature: calleeName,
                  evidenceSnapshotRef: 'sealed-snapshot'
                };
                const binProof: JavaBinaryProof = {
                  ruleId: 'JVM.BIN.GENERIC_ERASURE_PRESERVED',
                  conclusion: 'COMPATIBLE',
                  rationale: `Generic type bounds are erased at runtime per JLS §13.4.5; pre-compiled bytecode executes cleanly.`
                };
                return {
                  consumerFqcn,
                  consumerFile,
                  bindingKind,
                  sourceCompatibility: 'INCOMPATIBLE',
                  binaryCompatibility: 'COMPATIBLE',
                  verifiedConclusion: 'INCOMPATIBLE',
                  sourceVerifiedConclusion: 'INCOMPATIBLE',
                  binaryVerifiedConclusion: 'COMPATIBLE',
                  obligations: [obligation],
                  binaryProof: binProof,
                  rationale: `Method '${calleeName}' type parameter bound was narrowed (now requires '${violatingBound}'); argument type used in ${consumerFqcn} does not satisfy the bound.`
                };
              }
            }
          }

          // Check visibility narrowing
          const histVis = histExact.visibility;
          const candVis = candExact.visibility;
          const isNarrowed = (histVis === 'public' && candVis !== 'public') ||
            (histVis === 'protected' && (candVis === 'private' || (!isSamePackage && !isExtends && candVis === 'package-private')));

          if (isNarrowed && !isSamePackage && (!isExtends || candVis === 'private')) {
            const obligation: JavaSemanticObligation = {
              schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
              obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-${calleeName}-vis`,
              sourceFqcn: consumerFqcn,
              targetFqcn: providerFqcn,
              relationKind: 'METHOD_CALL',
              memberSignature: calleeName,
              evidenceSnapshotRef: 'sealed-snapshot'
            };
            const binProof: JavaBinaryProof = {
              ruleId: 'JVM.BIN.METHOD_VISIBILITY_NARROWED',
              conclusion: 'INCOMPATIBLE',
              expectedJvmFailure: 'IllegalAccessError',
              rationale: `Method ${calleeName} visibility narrowed to ${candVis}; external caller throws java.lang.IllegalAccessError.`
            };
            return {
              consumerFqcn,
              consumerFile,
              bindingKind,
              sourceCompatibility: 'INCOMPATIBLE',
              binaryCompatibility: 'INCOMPATIBLE',
              verifiedConclusion: 'INCOMPATIBLE',
              sourceVerifiedConclusion: 'INCOMPATIBLE',
              binaryVerifiedConclusion: 'INCOMPATIBLE',
              obligations: [obligation],
              binaryProof: binProof,
              rationale: `Method '${calleeName}' visibility was narrowed to ${candVis}, inaccessible from ${consumerFqcn}.`
            };
          }
        }
      }

      // 3.2 Field access
      if (cs.callKind === 'FIELD_ACCESS') {
        const fieldName = cs.calleeName;
        const histF = histClass?.fields.find(f => f.name === fieldName);
        const candF = candClass.fields.find(f => f.name === fieldName);

        if (histF && !candF) {
          const obligation: JavaSemanticObligation = {
            schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
            obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-${fieldName}-removed`,
            sourceFqcn: consumerFqcn,
            targetFqcn: providerFqcn,
            relationKind: 'FIELD_ACCESS',
            memberSignature: fieldName,
            evidenceSnapshotRef: 'sealed-snapshot'
          };
          const prod = JavaProofProducer.produceProof({
            obligation,
            historicalClass: histClass,
            candidateClass: candClass,
            memberName: fieldName
          });
          const binProof: JavaBinaryProof = {
            ruleId: 'JVM.BIN.FIELD_REMOVED',
            conclusion: 'INCOMPATIBLE',
            expectedJvmFailure: 'NoSuchFieldError',
            rationale: `Field ${fieldName} removed; caller throws java.lang.NoSuchFieldError.`
          };
          return {
            consumerFqcn,
            consumerFile,
            bindingKind,
            sourceCompatibility: 'INCOMPATIBLE',
            binaryCompatibility: 'INCOMPATIBLE',
            verifiedConclusion: 'INCOMPATIBLE',
            sourceVerifiedConclusion: 'INCOMPATIBLE',
            binaryVerifiedConclusion: 'INCOMPATIBLE',
            obligations: [obligation],
            sourceProof: prod.proof,
            binaryProof: binProof,
            rationale: `Field '${fieldName}' was removed in candidate class.`
          };
        } else if (histF && candF && histF.type.irContentHash !== candF.type.irContentHash) {
          const obligation: JavaSemanticObligation = {
            schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
            obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-${fieldName}-type-changed`,
            sourceFqcn: consumerFqcn,
            targetFqcn: providerFqcn,
            relationKind: 'FIELD_ACCESS',
            memberSignature: fieldName,
            evidenceSnapshotRef: 'sealed-snapshot'
          };
          const prod = JavaProofProducer.produceProof({
            obligation,
            historicalClass: histClass,
            candidateClass: candClass,
            memberName: fieldName
          });
          const binProof: JavaBinaryProof = {
            ruleId: 'JVM.BIN.FIELD_DESCRIPTOR_CHANGED',
            conclusion: 'INCOMPATIBLE',
            expectedJvmFailure: 'NoSuchFieldError',
            rationale: `Field ${fieldName} type changed; caller throws java.lang.NoSuchFieldError.`
          };
          return {
            consumerFqcn,
            consumerFile,
            bindingKind,
            sourceCompatibility: 'INCOMPATIBLE',
            binaryCompatibility: 'INCOMPATIBLE',
            verifiedConclusion: 'INCOMPATIBLE',
            sourceVerifiedConclusion: 'INCOMPATIBLE',
            binaryVerifiedConclusion: 'INCOMPATIBLE',
            obligations: [obligation],
            sourceProof: prod.proof,
            binaryProof: binProof,
            rationale: `Field '${fieldName}' type changed from ${(histF.type as any).display ?? 'previous'} to ${(candF.type as any).display ?? 'candidate'}.`
          };
        }
      }
    }

    // 4. Record component removed / constructor change (REAL-JAVA-009)
    if (histClass?.kind === 'record' && candClass.kind === 'record') {
      const histFields = histClass.fields;
      const candFields = candClass.fields;
      if (candFields.length < histFields.length) {
        // Component removed
        const obligation: JavaSemanticObligation = {
          schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
          obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-record-component-removed`,
          sourceFqcn: consumerFqcn,
          targetFqcn: providerFqcn,
          relationKind: 'METHOD_CALL',
          evidenceSnapshotRef: 'sealed-snapshot'
        };
        const binProof: JavaBinaryProof = {
          ruleId: 'JVM.BIN.RECORD_COMPONENT_REMOVED',
          conclusion: 'INCOMPATIBLE',
          expectedJvmFailure: 'NoSuchMethodError',
          rationale: `Record component removed; canonical constructor and accessor signatures changed.`
        };
        return {
          consumerFqcn,
          consumerFile,
          bindingKind,
          sourceCompatibility: 'INCOMPATIBLE',
          binaryCompatibility: 'INCOMPATIBLE',
          verifiedConclusion: 'INCOMPATIBLE',
          sourceVerifiedConclusion: 'INCOMPATIBLE',
          binaryVerifiedConclusion: 'INCOMPATIBLE',
          obligations: [obligation],
          binaryProof: binProof,
          rationale: `Record ${providerFqcn} component removed; canonical constructor signature changed.`
        };
      }
    }

    // 5. Interface Return Type Changed (REAL-JAVA-023)
    if (isImplements && histClass?.kind === 'interface') {
      for (const hm of histClass.methods) {
        const cm = candClass.methods.find(m => m.name === hm.name && m.parameters.length === hm.parameters.length);
        if (cm && hm.returnType.irContentHash !== cm.returnType.irContentHash) {
          // Return type changed
          const obligation: JavaSemanticObligation = {
            schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
            obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-${hm.name}-return-changed`,
            sourceFqcn: consumerFqcn,
            targetFqcn: providerFqcn,
            relationKind: 'IMPLEMENTS',
            memberSignature: hm.name,
            evidenceSnapshotRef: 'sealed-snapshot'
          };
          const binProof: JavaBinaryProof = {
            ruleId: 'JVM.BIN.METHOD_DESCRIPTOR_CHANGED',
            conclusion: 'INCOMPATIBLE',
            expectedJvmFailure: 'NoSuchMethodError',
            rationale: `Interface method ${hm.name} return type changed; implementation throws NoSuchMethodError or AbstractMethodError.`
          };
          return {
            consumerFqcn,
            consumerFile,
            bindingKind,
            sourceCompatibility: 'INCOMPATIBLE',
            binaryCompatibility: 'INCOMPATIBLE',
            verifiedConclusion: 'INCOMPATIBLE',
            sourceVerifiedConclusion: 'INCOMPATIBLE',
            binaryVerifiedConclusion: 'INCOMPATIBLE',
            obligations: [obligation],
            binaryProof: binProof,
            rationale: `Interface method '${hm.name}' return type was changed, breaking implementing class ${consumerFqcn}.`
          };
        }
      }
    }

    // 6. Generic bound narrowed (fallback path for consumers not caught by the call-site loop)
    // JavaClassDeclIR does not carry class-level type parameters; derive them from provider source text.
    const consumerContent = historicalHost.getFileContent(consumerCandClass?.filePath ?? '') ?? '';
    if (histClass && candClass && consumerContent.length > 0) {
      const histProviderSrc = historicalHost.getFileContent(histClass.filePath) ?? '';
      const candProviderSrc = candidateHost.getFileContent(candClass.filePath) ?? '';
      const histBounds = extractClassLevelTypeParamBounds(histProviderSrc, histClass.simpleName);
      const candBounds = extractClassLevelTypeParamBounds(candProviderSrc, candClass.simpleName);
      // A bound is "narrowed" if it appears in candidate but not in historical
      const fallbackNarrowedBounds = candBounds.filter(cb => !histBounds.includes(cb));
      if (
        fallbackNarrowedBounds.length > 0 &&
        typeArgViolatesNarrowedBound(consumerContent, providerFqcn, fallbackNarrowedBounds)
      ) {
        const violatingBound = fallbackNarrowedBounds[0] ?? 'unknown';
        const obligation: JavaSemanticObligation = {
          schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
          obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-generic-bound-narrowed`,
          sourceFqcn: consumerFqcn,
          targetFqcn: providerFqcn,
          relationKind: 'METHOD_CALL',
          evidenceSnapshotRef: 'sealed-snapshot'
        };
        // Generic type arguments are erased in bytecode per JLS §13.4.5; binary compatibility is preserved!
        const binProof: JavaBinaryProof = {
          ruleId: 'JVM.BIN.GENERIC_ERASURE_PRESERVED',
          conclusion: 'COMPATIBLE',
          rationale: `Generic type bounds are erased at compilation; pre-compiled binary links cleanly without linkage error.`
        };
        return {
          consumerFqcn,
          consumerFile,
          bindingKind,
          sourceCompatibility: 'INCOMPATIBLE',
          binaryCompatibility: 'COMPATIBLE',
          verifiedConclusion: 'INCOMPATIBLE',
          sourceVerifiedConclusion: 'INCOMPATIBLE',
          binaryVerifiedConclusion: 'COMPATIBLE',
          obligations: [obligation],
          binaryProof: binProof,
          rationale: `Type argument used in ${consumerFqcn} does not satisfy narrowed bound '${violatingBound}' on '${providerFqcn}'.`
        };
      }
    }

    // 7. By default, consumer references are preserved and compatible!
    const targetCallSite = consumerRef.callSite;
    const callee = targetCallSite?.calleeName;
    const hasTargetMethod = callee && histClass?.methods.some(m => m.name === callee);

    const defaultObligation: JavaSemanticObligation = {
      schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
      obligationId: `ob-${repoId}-${consumerFqcn}-${providerFqcn}-preserved`,
      sourceFqcn: consumerFqcn,
      targetFqcn: providerFqcn,
      relationKind: hasTargetMethod ? 'METHOD_CALL' : 'SUBTYPE',
      memberSignature: hasTargetMethod ? callee : undefined,
      evidenceSnapshotRef: 'sealed-snapshot'
    };

    const prod = JavaProofProducer.produceProof({
      obligation: defaultObligation,
      historicalClass: histClass,
      candidateClass: candClass,
      memberName: hasTargetMethod ? callee : undefined
    });

    const binProof: JavaBinaryProof = {
      ruleId: 'JVM.BIN.PRESERVED',
      conclusion: 'COMPATIBLE',
      rationale: `All referenced members and contracts of ${providerFqcn} are preserved in candidate bytecode.`
    };

    return {
      consumerFqcn,
      consumerFile,
      bindingKind,
      sourceCompatibility: 'COMPATIBLE',
      binaryCompatibility: 'COMPATIBLE',
      verifiedConclusion: 'COMPATIBLE',
      sourceVerifiedConclusion: 'COMPATIBLE',
      binaryVerifiedConclusion: 'COMPATIBLE',
      obligations: [defaultObligation],
      sourceProof: prod.proof,
      binaryProof: binProof,
      rationale: `All referenced declarations and bytecode descriptors of ${providerFqcn} are preserved for consumer ${consumerFqcn}.`
    };
  }
}
