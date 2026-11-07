/**
 * @file JavaImpactAnalyzer.ts
 * Advisory-only Java impact slice for Sajimora Phase J-4.
 *
 * Design constraints (enforced by architecture — do NOT relax):
 *   - certificationStatus is always 'ADVISORY_ONLY'.
 *   - No object produced here ever enters VerdictAuthority or the certified F0/PR0–PR5 pipeline.
 *   - Unresolved or ambiguous symbols always fail closed to INCONCLUSIVE.
 *   - The only filesystem reads are through the sealed JavaSealedCompilerHost; no live-FS access.
 *   - Cross-language certified verdicts are NOT produced; §7.2 of the architecture doc is absolute.
 *
 * Schema:
 *   schemaVersion: 'ADVISORY_JAVA_IMPACT_V1'
 *   certificationStatus: 'ADVISORY_ONLY'
 *
 * Feeds into the result reconciler defined by casebgoal.md §Phase 7.
 */

import { JavaSealedCompilerHost, SealedJavaSnapshotInput } from '../languages/java/programs/JavaSealedCompilerHost';
import { JavaClassDeclIR, JavaMethodSignatureIR, JavaFieldIR, JavaCallSiteIR, JavaImportIR } from '../languages/java/ir/JavaTypeIR';
import { JavaBuildModelExtractor } from '../languages/java/programs/JavaBuildModelExtractor';
import { GitObjectReader, GitRepository } from '../snapshots';
import { scanProviderFrameworkReachability, FrameworkReachabilityEvidence } from './JavaFrameworkScanner';

// ---------------------------------------------------------------------------
// Re-export schema version so consumers can guard on it
// ---------------------------------------------------------------------------
export const ADVISORY_JAVA_SCHEMA_VERSION = 'ADVISORY_JAVA_IMPACT_V1' as const;

// ---------------------------------------------------------------------------
// Verdict / completeness
// ---------------------------------------------------------------------------

/** Advisory verdict — never certified. Maps directly to the advisory path verdict surface. */
export type JavaAdvisoryVerdict =
  | 'LIKELY_PRESERVED'
  | 'LIKELY_VIOLATED'
  | 'INCONCLUSIVE'
  | 'ANALYSIS_ERROR';

export type JavaCompletenessStatus = 'COMPLETE' | 'INCOMPLETE';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface JavaSnapshotProvider {
  readonly trackedFiles: readonly string[];
  readTextFile(relativePath: string): string | undefined;
  readonly [filePath: string]: any;
}

/** A sealed pair of Java source snapshots: parent and candidate. */
export interface JavaSealedRevision {
  /** Git commit SHA identifying the revision. */
  readonly commitSha: string;
  /** Sealed file map or lazy provider. Only .java files are analyzed. */
  readonly files: Readonly<Record<string, string>> | JavaSnapshotProvider;
  /** Optional subset tracking from upstream selection (e.g. casebgoal.md §Phase 7 slicing). */
  readonly selection?: JavaSealedSelection;
}

export interface JavaSealedSelection {
  readonly selectedFiles: number;
  readonly selectedBytes: number;
  readonly scannedFiles: number;
  readonly scannedBytes: number;
  readonly incompleteReasons: readonly string[];
}

/** Optional pin: restrict the analysis to a specific Java class+member. */
export interface JavaTargetDeclaration {
  /** Fully-qualified class name, e.g. "com.acme.Foo". */
  readonly fqcn: string;
  /**
   * Optional member name to narrow analysis.
   * For a method, use the simple name (without parameters).
   * Omit to analyze the entire class.
   */
  readonly memberName?: string;
}

export interface JavaAdvisoryInput {
  readonly parent: JavaSealedRevision;
  readonly candidate: JavaSealedRevision;
  /** If set, only this declaration is analyzed as a provider. */
  readonly target?: JavaTargetDeclaration;
  readonly resourceLimits?: {
    readonly maxExecutionMs?: number;
    readonly maxRssBytes?: number;
  };
}

// ---------------------------------------------------------------------------
// Provider / consumer output types
// ---------------------------------------------------------------------------

/**
 * Describes what changed at the declaration (provider) level between parent and candidate.
 * Mirrors ProviderChangeKind in the TypeScript analyzer but uses Java-specific vocabulary.
 */
export type JavaProviderChangeKind =
  | 'CLASS_ADDED'
  | 'CLASS_REMOVED'
  | 'CLASS_KIND_CHANGED'            // e.g. class -> interface
  | 'CLASS_VISIBILITY_NARROWED'
  | 'CLASS_VISIBILITY_WIDENED'
  | 'METHOD_ADDED'
  | 'METHOD_REMOVED'
  | 'METHOD_RETURN_TYPE_CHANGED'
  | 'METHOD_PARAMETER_REMOVED'
  | 'METHOD_PARAMETER_ADDED'
  | 'METHOD_PARAMETER_TYPE_CHANGED'
  | 'METHOD_VISIBILITY_NARROWED'
  | 'METHOD_VISIBILITY_WIDENED'
  | 'METHOD_THROWS_CHANGED'
  | 'METHOD_STATIC_CHANGED'         // static <-> instance
  | 'METHOD_ABSTRACT_CHANGED'
  | 'FIELD_ADDED'
  | 'FIELD_REMOVED'
  | 'FIELD_TYPE_CHANGED'
  | 'FIELD_VISIBILITY_NARROWED'
  | 'FIELD_VISIBILITY_WIDENED'
  | 'FIELD_STATIC_CHANGED'
  | 'FIELD_FINAL_CHANGED'
  | 'CONSTANT_VALUE_CHANGED'
  | 'SEALED_PERMITS_RESTRICTED'
  | 'INHERITANCE_CHANGED'           // superclass / implements list changed
  | 'ANNOTATION_CHANGED'
  | 'DECLARATION_CHANGED';          // catch-all for non-enumerated structural diff

/** A source-level span inside a sealed Java file. */
export interface JavaAdvisorySpan {
  readonly file: string;
  readonly line: number;
}

/**
 * A provider declaration that changed between parent and candidate.
 * The `id` is the stable FQCN-based identity key:
 *   - For classes:   "<fqcn>"
 *   - For methods:   "<fqcn>#<methodName>#<ordinal>"
 *   - For fields:    "<fqcn>.<fieldName>"
 */
export interface JavaProviderDeclaration {
  readonly id: string;
  readonly file: string;
  readonly fqcn: string;
  /** Simple name of the changed member (empty string for top-level class changes). */
  readonly memberName: string;
  readonly memberKind: 'CLASS' | 'METHOD' | 'FIELD';
  readonly span: JavaAdvisorySpan | null;
  /** Serialized text of the declaration in parent (null if not present). */
  readonly before: string | null;
  /** Serialized text of the declaration in candidate (null if not present). */
  readonly after: string | null;
  readonly change: JavaProviderChangeKind;
  /**
   * CASE_A: symbol present in both parent and candidate (signature changed).
   * CASE_B: symbol present in only one revision (added or removed).
   */
  readonly identity: 'CASE_A' | 'CASE_B';
}

/**
 * How a candidate file references a changed provider.
 * Derived from FQCN-based static analysis of import lists and inheritance edges;
 * method-body call sites require Phase J-5 (tree-sitter/JavaParser).
 */
export type JavaConsumerReferenceKind =
  | 'SINGLE_IMPORT'          // J-1: import com.acme.Foo;
  | 'WILDCARD_IMPORT'        // J-2: import com.acme.*;
  | 'STATIC_SINGLE_IMPORT'   // J-3: import static com.acme.Foo.bar;
  | 'STATIC_WILDCARD_IMPORT' // J-4: import static com.acme.Foo.*;
  | 'EXTENDS'                // J-7/J-9
  | 'IMPLEMENTS'             // J-8
  | 'SAME_PACKAGE'           // J-6
  | 'CALL_SITE'              // J-5: method-body invocation
  | 'METHOD_REFERENCE'       // J-10: ClassName::method
  | 'CONSTRUCTOR_REFERENCE'; // J-11: ClassName::new

export interface JavaConsumerReference {
  readonly providerId: string;
  readonly consumerFile: string;
  readonly consumerFqcn: string;
  readonly referenceKind: JavaConsumerReferenceKind;
  readonly directness: 'DIRECT' | 'TRANSITIVE';
  readonly resolutionStatus: 'COMPLETE' | 'INCOMPLETE';
  /** Binding kind tag per JavaBindingKind union (J-1..J-12) for downstream reconciler. */
  readonly bindingKind: string;
  /** Detailed call-site metadata (Phase J-5) */
  readonly callSite?: JavaCallSiteIR;
}

/**
 * Classification of the impact a provider change has on a specific consumer reference.
 */
export type JavaConsumerImpactClassification =
  | 'UNAFFECTED'
  | 'LIKELY_BROKEN'           // e.g. method removed, field type changed
  | 'LIKELY_COMPATIBLE'       // e.g. method added to non-final class
  | 'UNRESOLVED'              // consumer or provider has unresolved symbols
  | 'ADVISORY_ONLY_LIMIT';    // impact class unknown without body-level analysis (J-5)

export interface JavaConsumerImpact {
  readonly providerId: string;
  readonly consumerFile: string;
  readonly consumerFqcn: string;
  readonly referenceKind: JavaConsumerReferenceKind;
  readonly line?: number;
  readonly classification: JavaConsumerImpactClassification;
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// Trace types (mirrors AdvisoryImpactTrace for reconciler compatibility)
// ---------------------------------------------------------------------------

export interface JavaAdvisoryTraceStep {
  readonly kind: 'PROVIDER' | 'IMPORT' | 'EXTENDS' | 'IMPLEMENTS' | 'CONSUMER' | 'LIMIT';
  readonly file: string;
  readonly span: JavaAdvisorySpan | null;
  readonly detail: string;
}

export interface JavaAdvisoryImpactTrace {
  readonly providerId: string;
  readonly classification: JavaConsumerImpactClassification;
  readonly completeness: 'COMPLETE' | 'INCONCLUSIVE';
  readonly steps: readonly JavaAdvisoryTraceStep[];
}

// ---------------------------------------------------------------------------
// Top-level result
// ---------------------------------------------------------------------------

/**
 * Engine-derived attribution for why a run abstained. The per-impact derivation is
 * capture-only, but two codes are produced by deliberate verdict-level soundness
 * guards (`ABST_UNSEALED_IMPLEMENTOR_SET`, `ABST_UNINDEXED_DECLARATION`): they exist
 * to retract a `LIKELY_PRESERVED` that the snapshot cannot prove, never to promote one.
 */
export type JavaAdvisoryAbstentionCode =
  | 'ABST_WILDCARD_IMPORT'
  | 'ABST_STATIC_WILDCARD_IMPORT'
  | 'ABST_ADVISORY_ONLY_LIMIT'
  | 'ABST_RECEIVER_UNRESOLVED'
  | 'ABST_UNRESOLVED_SYMBOL'
  | 'ABST_BUILD_INCOMPLETE'
  | 'ABST_SNAPSHOT_UNRESOLVED'
  | 'ABST_TARGET_MISSING'
  | 'ABST_BUDGET_EXCEEDED'
  | 'ABST_EMPTY_SNAPSHOT'
  | 'ABST_UNSEALED_IMPLEMENTOR_SET'
  | 'ABST_UNINDEXED_DECLARATION'
  | 'ABST_UNROUTED_CHANGE_KIND'
  | 'ABST_REFLECTION_NO_LITERAL'
  | 'ABST_THROWS_HIERARCHY_UNKNOWN'
  | 'ABST_FRAMEWORK_REACHABLE';

/** Stable vocabulary, emitted in full by the histogram. A code whose detector
 * has not landed yet reports 0 rather than being silently absent. */
export const JAVA_ADVISORY_ABSTENTION_CODES: readonly JavaAdvisoryAbstentionCode[] = [
  'ABST_ADVISORY_ONLY_LIMIT',
  'ABST_BUILD_INCOMPLETE',
  'ABST_BUDGET_EXCEEDED',
  'ABST_EMPTY_SNAPSHOT',
  'ABST_FRAMEWORK_REACHABLE',
  'ABST_RECEIVER_UNRESOLVED',
  'ABST_REFLECTION_NO_LITERAL',
  'ABST_SNAPSHOT_UNRESOLVED',
  'ABST_STATIC_WILDCARD_IMPORT',
  'ABST_TARGET_MISSING',
  'ABST_THROWS_HIERARCHY_UNKNOWN',
  'ABST_UNINDEXED_DECLARATION',
  'ABST_UNRESOLVED_SYMBOL',
  'ABST_UNROUTED_CHANGE_KIND',
  'ABST_UNSEALED_IMPLEMENTOR_SET',
  'ABST_WILDCARD_IMPORT'
];

export interface JavaAdvisoryImpactResult {
  readonly schemaVersion: typeof ADVISORY_JAVA_SCHEMA_VERSION;
  readonly certificationStatus: 'ADVISORY_ONLY';
  readonly verdict: JavaAdvisoryVerdict;
  readonly parentCommitSha: string;
  readonly candidateCommitSha: string;
  readonly providers: readonly JavaProviderDeclaration[];
  readonly consumers: readonly JavaConsumerReference[];
  readonly impacts: readonly JavaConsumerImpact[];
  readonly traces: readonly JavaAdvisoryImpactTrace[];
  readonly completeness: {
    readonly status: JavaCompletenessStatus;
    readonly consumersAnalyzed: number;
    readonly unresolvedDependencyCount: number;
    readonly unresolvedFiles: readonly string[];
    readonly symbolResolutionQuality?: 'FULL_BUILD_MODEL' | 'NAMESPACE_FALLBACK';
    readonly selection?: {
      readonly parent: JavaSealedSelection | null;
      readonly candidate: JavaSealedSelection | null;
    };
  };
  readonly confidenceRationale: readonly string[];
  readonly evidenceReferences: readonly string[];
  readonly abstentionCodes: readonly JavaAdvisoryAbstentionCode[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Normalise path separators to forward slashes for deterministic keys. */
function slash(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Build a SealedJavaSnapshotInput from a JavaSealedRevision.
 * Only .java files are surfaced as tracked sources; other files are still readable
 * via readTextFile but not indexed by the host as Java sources.
 */
function revisionToSnapshotInput(rev: JavaSealedRevision): SealedJavaSnapshotInput {
  if ('readTextFile' in rev.files && Array.isArray((rev.files as any).trackedFiles)) {
    const provider = rev.files as JavaSnapshotProvider;
    const cache = new Map<string, string | undefined>();
    const trackedFiles = [...provider.trackedFiles].map(slash).sort();
    return {
      trackedFiles,
      readTextFile: (relativePath: string) => {
        const normalised = slash(relativePath);
        if (cache.has(normalised)) return cache.get(normalised);
        const text = provider.readTextFile(relativePath) ?? provider.readTextFile(normalised);
        cache.set(normalised, text);
        return text;
      }
    };
  }

  const normalised: Record<string, string> = Object.fromEntries(
    Object.entries(rev.files)
      .map(([p, text]) => [slash(p), text])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
  return {
    trackedFiles: Object.keys(normalised).sort(),
    readTextFile: (relativePath: string) => normalised[slash(relativePath)]
  };
}

/**
 * Render a JavaClassDeclIR to a compact, deterministic text blob for
 * before/after comparison. Covers class shape, methods, and fields.
 */
function renderClassDecl(cls: JavaClassDeclIR): string {
  const vis = cls.isExported ? 'public' : 'package-private';
  const header = [
    cls.annotations.join(' '),
    vis,
    cls.isAbstract ? 'abstract' : '',
    cls.isFinal ? 'final' : '',
    (cls as any).isSealed ? 'sealed' : '',
    cls.kind,
    cls.fqcn
  ].filter(Boolean).join(' ');
  const lines: string[] = [
    header,
    cls.extendsName ? `  extends: ${cls.extendsName}` : '',
    cls.implementsNames.length ? `  implements: ${[...cls.implementsNames].sort().join(', ')}` : '',
    (cls as any).permitsNames?.length ? `  permits: ${[...(cls as any).permitsNames].sort().join(', ')}` : ''
  ].filter(Boolean);

  for (const m of [...cls.methods].sort(
    (a, b) => (a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.declarationOrdinal - b.declarationOrdinal)
  )) {
    lines.push(`  [method] ${renderMethod(m)}`);
  }
  for (const f of [...cls.fields].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    lines.push(`  [field] ${renderField(f)}`);
  }
  return lines.join('\n');
}

/**
 * Render only the class declaration header (modifiers, inheritance clauses),
 * deliberately excluding members. Class-level provider diffs must fire only on
 * genuine header edits; member changes are diffed per-member in diffProviders.
 * Field set mirrors classChangeKind's comparisons (sorted where it sorts).
 */
function renderClassHeader(cls: JavaClassDeclIR): string {
  const vis = cls.isExported ? 'public' : 'package-private';
  const header = [
    [...cls.annotations].sort().join(' '),
    vis,
    cls.isAbstract ? 'abstract' : '',
    cls.isFinal ? 'final' : '',
    cls.isSealed ? 'sealed' : '',
    cls.kind,
    cls.fqcn
  ].filter(Boolean).join(' ');
  return [
    header,
    cls.extendsName ? `  extends: ${cls.extendsName}` : '',
    cls.implementsNames.length ? `  implements: ${[...cls.implementsNames].sort().join(', ')}` : '',
    cls.permitsNames?.length ? `  permits: ${[...cls.permitsNames].sort().join(', ')}` : ''
  ].filter(Boolean).join('\n');
}

function renderMethod(m: JavaMethodSignatureIR): string {
  const params = m.parameters
    .map(p => `${p.type.display} ${p.name}${p.isVararg ? '...' : ''}`)
    .join(', ');
  const mods = [
    m.visibility,
    m.isStatic ? 'static' : '',
    m.isFinal ? 'final' : '',
    m.isAbstract ? 'abstract' : ''
  ].filter(Boolean).join(' ');
  // throws annotations are stored as 'throws:ExType' entries by the extractor
  const throws_ = m.annotations.filter(a => a.startsWith('throws:')).join(', ');
  return `${mods} ${m.returnType.display} ${m.name}(${params})${throws_ ? ' throws ' + throws_ : ''}`.replace(/\s+/g, ' ').trim();
}

function renderField(f: JavaFieldIR): string {
  const mods = [
    f.visibility,
    f.isStatic ? 'static' : '',
    f.isFinal ? 'final' : ''
  ].filter(Boolean).join(' ');
  const val = f.constantValue !== undefined ? ` = ${f.constantValue}` : '';
  return `${mods} ${f.type.display} ${f.name}${val}`.replace(/\s+/g, ' ').trim();
}

/**
 * Method identity is its signature, not its position in the file. Keying on the
 * declaration ordinal turned every body-only edit into a phantom REMOVE+ADD pair.
 * Java forbids two methods with the same signature, so the `@n` suffix in
 * `methodIdentityMap` only keeps a malformed parse from silently dropping one.
 */
function renderMethodId(fqcn: string, m: JavaMethodSignatureIR): string {
  return `${fqcn}#${m.name}#${m.parameters.map(p => p.type.display).join(',')}`;
}

function methodIdentityMap(fqcn: string, methods: readonly JavaMethodSignatureIR[]): Map<string, JavaMethodSignatureIR> {
  const map = new Map<string, JavaMethodSignatureIR>();
  for (const m of methods) {
    const signature = renderMethodId(fqcn, m);
    let key = signature;
    for (let n = 1; map.has(key); n++) key = `${signature}@${n}`;
    map.set(key, m);
  }
  return map;
}

function renderFieldId(fqcn: string, f: JavaFieldIR): string {
  return `${fqcn}.${f.name}`;
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

function classChangeKind(
  before: JavaClassDeclIR | undefined,
  after: JavaClassDeclIR | undefined
): JavaProviderChangeKind {
  if (!before) return 'CLASS_ADDED';
  if (!after) return 'CLASS_REMOVED';
  if (before.kind !== after.kind) return 'CLASS_KIND_CHANGED';
  if (before.isExported !== after.isExported) {
    return before.isExported ? 'CLASS_VISIBILITY_NARROWED' : 'CLASS_VISIBILITY_WIDENED';
  }
  if ((before.isAbstract || false) !== (after.isAbstract || false)) return 'DECLARATION_CHANGED';
  if ((before.isFinal || false) !== (after.isFinal || false)) return 'DECLARATION_CHANGED';
  const beforeSuper = before.extendsName ?? '';
  const afterSuper = after.extendsName ?? '';
  const beforeImpls = [...before.implementsNames].sort().join(',');
  const afterImpls = [...after.implementsNames].sort().join(',');
  if (beforeSuper !== afterSuper || beforeImpls !== afterImpls) return 'INHERITANCE_CHANGED';
  const beforePermits = [...((before as any).permitsNames ?? [])].sort().join(',');
  const afterPermits = [...((after as any).permitsNames ?? [])].sort().join(',');
  if (beforePermits !== afterPermits) return 'SEALED_PERMITS_RESTRICTED';
  const beforeAnno = [...before.annotations].sort().join(',');
  const afterAnno = [...after.annotations].sort().join(',');
  if (beforeAnno !== afterAnno) return 'ANNOTATION_CHANGED';
  return 'DECLARATION_CHANGED';
}

function methodChangeKind(
  before: JavaMethodSignatureIR | undefined,
  after: JavaMethodSignatureIR | undefined
): JavaProviderChangeKind {
  if (!before) return 'METHOD_ADDED';
  if (!after) return 'METHOD_REMOVED';
  if (before.parameters.length > after.parameters.length) return 'METHOD_PARAMETER_REMOVED';
  if (before.parameters.length < after.parameters.length) return 'METHOD_PARAMETER_ADDED';
  if (before.returnType.irContentHash !== after.returnType.irContentHash) return 'METHOD_RETURN_TYPE_CHANGED';
  if (before.visibility !== after.visibility) {
    const order: Record<string, number> = { private: 0, 'package-private': 1, protected: 2, public: 3 };
    return (order[before.visibility] ?? 0) > (order[after.visibility] ?? 0)
      ? 'METHOD_VISIBILITY_NARROWED'
      : 'METHOD_VISIBILITY_WIDENED';
  }
  if (before.isStatic !== after.isStatic) return 'METHOD_STATIC_CHANGED';
  if (before.isAbstract !== after.isAbstract) return 'METHOD_ABSTRACT_CHANGED';
  for (let i = 0; i < before.parameters.length; i++) {
    if (before.parameters[i].type.irContentHash !== after.parameters[i].type.irContentHash) {
      return 'METHOD_PARAMETER_TYPE_CHANGED';
    }
  }
  const beforeThrows = before.annotations.filter(a => a.startsWith('throws:')).sort().join(',');
  const afterThrows = after.annotations.filter(a => a.startsWith('throws:')).sort().join(',');
  if (beforeThrows !== afterThrows) return 'METHOD_THROWS_CHANGED';
  const beforeAnno = before.annotations.filter(a => !a.startsWith('throws:')).sort().join(',');
  const afterAnno = after.annotations.filter(a => !a.startsWith('throws:')).sort().join(',');
  if (beforeAnno !== afterAnno) return 'ANNOTATION_CHANGED';
  return 'DECLARATION_CHANGED';
}

function fieldChangeKind(
  before: JavaFieldIR | undefined,
  after: JavaFieldIR | undefined
): JavaProviderChangeKind {
  if (!before) return 'FIELD_ADDED';
  if (!after) return 'FIELD_REMOVED';
  if (before.constantValue !== after.constantValue) return 'CONSTANT_VALUE_CHANGED';
  if (before.type.irContentHash !== after.type.irContentHash) return 'FIELD_TYPE_CHANGED';
  if (before.visibility !== after.visibility) {
    const order: Record<string, number> = { private: 0, 'package-private': 1, protected: 2, public: 3 };
    return (order[before.visibility] ?? 0) > (order[after.visibility] ?? 0)
      ? 'FIELD_VISIBILITY_NARROWED'
      : 'FIELD_VISIBILITY_WIDENED';
  }
  if (before.isStatic !== after.isStatic) return 'FIELD_STATIC_CHANGED';
  if (before.isFinal !== after.isFinal) return 'FIELD_FINAL_CHANGED';
  const beforeAnno = [...before.annotations].sort().join(',');
  const afterAnno = [...after.annotations].sort().join(',');
  if (beforeAnno !== afterAnno) return 'ANNOTATION_CHANGED';
  return 'DECLARATION_CHANGED';
}

/**
 * Compile-time partition of every provider change kind. A new member of
 * `JavaProviderChangeKind` is a type error until it is categorised here, which is
 * what stops the classifier's fail-closed default from being reached silently.
 */
type ChangeCategory = 'ADDITIVE_SAFE' | 'DIRECT_REF_BREAKING' | 'SIGNATURE_CONTEXTUAL' | 'EXPLICIT_RULE';

const CHANGE_KIND_CATEGORY: Record<JavaProviderChangeKind, ChangeCategory> = {
  CLASS_ADDED: 'ADDITIVE_SAFE',
  CLASS_REMOVED: 'DIRECT_REF_BREAKING',
  CLASS_KIND_CHANGED: 'SIGNATURE_CONTEXTUAL',
  CLASS_VISIBILITY_NARROWED: 'DIRECT_REF_BREAKING',
  CLASS_VISIBILITY_WIDENED: 'ADDITIVE_SAFE',
  METHOD_ADDED: 'EXPLICIT_RULE',
  METHOD_REMOVED: 'DIRECT_REF_BREAKING',
  METHOD_RETURN_TYPE_CHANGED: 'SIGNATURE_CONTEXTUAL',
  METHOD_PARAMETER_REMOVED: 'SIGNATURE_CONTEXTUAL',
  METHOD_PARAMETER_ADDED: 'SIGNATURE_CONTEXTUAL',
  METHOD_PARAMETER_TYPE_CHANGED: 'SIGNATURE_CONTEXTUAL',
  METHOD_VISIBILITY_NARROWED: 'DIRECT_REF_BREAKING',
  METHOD_VISIBILITY_WIDENED: 'ADDITIVE_SAFE',
  METHOD_THROWS_CHANGED: 'EXPLICIT_RULE',
  METHOD_STATIC_CHANGED: 'SIGNATURE_CONTEXTUAL',
  METHOD_ABSTRACT_CHANGED: 'EXPLICIT_RULE',
  FIELD_ADDED: 'ADDITIVE_SAFE',
  FIELD_REMOVED: 'DIRECT_REF_BREAKING',
  FIELD_TYPE_CHANGED: 'SIGNATURE_CONTEXTUAL',
  FIELD_VISIBILITY_NARROWED: 'DIRECT_REF_BREAKING',
  FIELD_VISIBILITY_WIDENED: 'ADDITIVE_SAFE',
  FIELD_STATIC_CHANGED: 'SIGNATURE_CONTEXTUAL',
  FIELD_FINAL_CHANGED: 'EXPLICIT_RULE',
  CONSTANT_VALUE_CHANGED: 'EXPLICIT_RULE',
  SEALED_PERMITS_RESTRICTED: 'EXPLICIT_RULE',
  INHERITANCE_CHANGED: 'EXPLICIT_RULE',
  ANNOTATION_CHANGED: 'EXPLICIT_RULE',
  DECLARATION_CHANGED: 'EXPLICIT_RULE'
};

/**
 * IR and raw-source evidence available while classifying one consumer impact.
 * Built per impact from the sealed worlds; never widened beyond the snapshot.
 */
interface AdvisoryEvidence {
  readonly providerClassBefore: JavaClassDeclIR | undefined;
  readonly providerClassAfter: JavaClassDeclIR | undefined;
  readonly providerMethodBefore: JavaMethodSignatureIR | undefined;
  readonly providerMethodAfter: JavaMethodSignatureIR | undefined;
  readonly providerFieldBefore: JavaFieldIR | undefined;
  readonly providerFieldAfter: JavaFieldIR | undefined;
  readonly providerMemberKind: JavaProviderDeclaration['memberKind'];
  readonly consumerClass: JavaClassDeclIR | undefined;
  /** Consumer file text with comments and literals removed, line-for-line. */
  readonly consumerCode: string | undefined;
  readonly consumerImports?: ReadonlyArray<JavaImportIR>;
  readonly typeIndex: ReadonlyMap<string, readonly JavaClassDeclIR[]>;
  readonly abstentionSink: Set<JavaAdvisoryAbstentionCode>;
}

function simpleTypeName(type: string): string {
  const base = type.replace(/<[^<>]*>/g, '').trim();
  return (base.split('.').pop() ?? base).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Comments and literals are not code: a name appearing only there proves nothing.
 * Blanks are kept line-for-line so the result stays addressable by source line.
 */
function withoutCommentsAndLiterals(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, mark => ' '.repeat(mark.length))
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

/** The extractor carries a method's throws clause as `throws:<Type>` annotations. */
function throwsOfMethod(method: JavaMethodSignatureIR | undefined): string[] {
  if (!method) return [];
  return method.annotations
    .filter(a => a.startsWith('throws:'))
    .map(a => simpleTypeName(a.slice('throws:'.length)))
    .filter(Boolean)
    .sort();
}

function mentionsToken(code: string | undefined, token: string, asCall: boolean): boolean {
  if (!code || !token) return false;
  const escaped = escapeRegExp(token);
  const pattern = asCall ? `\\b${escaped}\\s*\\(|::\\s*\\b${escaped}\\b` : `\\b${escaped}\\b`;
  return new RegExp(pattern).test(code);
}

function isAssignedInSource(code: string | undefined, token: string): boolean {
  if (!code || !token) return false;
  return new RegExp(`\\b${escapeRegExp(token)}\\s*(?:[+*/%-]?=(?!=)|\\+\\+|--)`).test(code);
}

type CheckedOrUnchecked = 'CHECKED' | 'UNCHECKED' | 'UNKNOWN_HIERARCHY';

/**
 * Checked/unchecked status from the `java.lang` roots, then by walking the sealed
 * world's superclass chain. Anything the snapshot cannot prove stays unknown and
 * the caller fails closed — never assumes compile safety.
 */
function exceptionStatus(
  type: string,
  index: ReadonlyMap<string, readonly JavaClassDeclIR[]>
): CheckedOrUnchecked {
  if (type === 'Exception' || type === 'Throwable') return 'CHECKED';
  if (type === 'RuntimeException' || type === 'Error') return 'UNCHECKED';
  const roots = index.get(type);
  if (!roots || roots.length !== 1) return 'UNKNOWN_HIERARCHY';
  let current = roots[0];
  const seen = new Set<string>([current.fqcn]);
  for (let depth = 0; depth < 32; depth++) {
    const superName = current.extendsName ? simpleTypeName(current.extendsName) : '';
    if (!superName) return 'UNKNOWN_HIERARCHY';
    if (superName === 'RuntimeException' || superName === 'Error') return 'UNCHECKED';
    if (superName === 'Exception' || superName === 'Throwable') return 'CHECKED';
    const next = index.get(superName);
    if (!next || next.length !== 1 || seen.has(next[0].fqcn)) return 'UNKNOWN_HIERARCHY';
    seen.add(next[0].fqcn);
    current = next[0];
  }
  return 'UNKNOWN_HIERARCHY';
}

/** Does `cover` (a catch or re-thrown type) discharge a thrown `type`? */
function coverHandles(
  cover: string,
  thrown: string,
  index: ReadonlyMap<string, readonly JavaClassDeclIR[]>
): boolean {
  if (cover === thrown) return true;
  if (cover === 'Throwable') return true;
  if (cover === 'Exception') return exceptionStatus(thrown, index) !== 'UNCHECKED' && thrown !== 'Error';
  return false;
}

function catchTypesInSource(lines: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    const matches = line.matchAll(/catch\s*\(\s*(?:final\s+)?([\w.]+(?:\s*\|\s*[\w.]+)*)\s+\w/g);
    for (const m of matches) {
      for (const part of m[1].split('|')) found.push(simpleTypeName(part.trim()));
    }
  }
  return found;
}

/**
 * Handling evidence for a broadened checked throw, limited to the enclosing method:
 * a re-thrown clause covering the type, or a catch of it inside that method's lines.
 * No handler found only counts as *proved absent* for types whose hierarchy is known.
 */
function throwIsHandled(ev: AdvisoryEvidence, callSite: JavaCallSiteIR | undefined, thrown: string): boolean {
  const consumer = ev.consumerClass;
  if (!consumer || !callSite) return false;
  const enclosing = consumer.methods.filter(m =>
    m.name === callSite.enclosingMethodName || (m.isConstructor && callSite.enclosingMethodName === '<init>')
  );
  for (const method of enclosing) {
    for (const cover of throwsOfMethod(method)) {
      if (coverHandles(cover, thrown, ev.typeIndex)) return true;
    }
    if (ev.consumerCode) {
      const lines = ev.consumerCode.split('\n').slice(method.lineStart - 1, method.lineEnd);
      for (const cover of catchTypesInSource(lines)) {
        if (coverHandles(cover, thrown, ev.typeIndex)) return true;
      }
    }
  }
  return false;
}

/**
 * Throws-clause oracle (§5.2 rule 0 + checked propagation). Widening to an
 * unchecked type is compile-safe and never breaks a caller; a checked type breaks
 * only where the call chain cannot be shown to handle it.
 */
function classifyThrowsChange(
  ev: AdvisoryEvidence,
  callSite: JavaCallSiteIR | undefined
): JavaConsumerImpactClassification {
  if (!ev.providerMethodBefore && !ev.providerMethodAfter) return 'ADVISORY_ONLY_LIMIT';
  const before = throwsOfMethod(ev.providerMethodBefore);
  const after = throwsOfMethod(ev.providerMethodAfter);
  const broadened = after.filter(t => !before.includes(t));
  if (broadened.length === 0) return 'LIKELY_COMPATIBLE';

  let outcome: JavaConsumerImpactClassification = 'LIKELY_COMPATIBLE';
  for (const thrown of broadened) {
    const status = exceptionStatus(thrown, ev.typeIndex);
    if (status === 'UNCHECKED') continue;
    if (throwIsHandled(ev, callSite, thrown)) continue;
    if (status === 'UNKNOWN_HIERARCHY') {
      ev.abstentionSink.add('ABST_THROWS_HIERARCHY_UNKNOWN');
      outcome = 'UNRESOLVED';
      continue;
    }
    return 'LIKELY_BROKEN';
  }
  return outcome;
}

/**
 * True when neither sealed world records anything that extends or implements the
 * interface. Absence cannot separate "nobody implements this" from "implementors were
 * not selected into the snapshot", so no `PRESERVED` assurance may rest on it.
 */
function implementorSetIsOpen(
  cls: JavaClassDeclIR,
  typeIndex: ReadonlyMap<string, readonly JavaClassDeclIR[]>
): boolean {
  for (const [, candidates] of typeIndex) {
    for (const other of candidates) {
      if (other.fqcn === cls.fqcn) continue;
      if (other.extendsName && simpleTypeName(other.extendsName) === cls.simpleName) return false;
      if (other.implementsNames.some(i => simpleTypeName(i) === cls.simpleName)) return false;
    }
  }
  return true;
}

/** Kinds that change what an implementor must supply, not only the declaring source. */
const INTERFACE_CONTRACT_CHANGES: ReadonlySet<JavaProviderChangeKind> = new Set([
  'METHOD_ADDED',
  'METHOD_REMOVED',
  'METHOD_ABSTRACT_CHANGED',
  'INHERITANCE_CHANGED',
  'DECLARATION_CHANGED',
  'CLASS_REMOVED'
]);

/** Simple-name index over both sealed worlds, used for hierarchy and implementor walks. */
function buildTypeIndex(
  parentWorld: WorldIndex,
  candidateWorld: WorldIndex
): ReadonlyMap<string, readonly JavaClassDeclIR[]> {
  const index = new Map<string, JavaClassDeclIR[]>();
  for (const world of [parentWorld, candidateWorld]) {
    for (const cls of world.host.getAllClasses()) {
      const bucket = index.get(cls.simpleName);
      if (bucket) {
        if (!bucket.some(c => c.fqcn === cls.fqcn)) bucket.push(cls);
      } else {
        index.set(cls.simpleName, [cls]);
      }
    }
  }
  for (const [name, bucket] of index) {
    index.set(name, bucket.sort((a, b) => (a.fqcn < b.fqcn ? -1 : a.fqcn > b.fqcn ? 1 : 0)));
  }
  return index;
}

// ---------------------------------------------------------------------------
// Structural coverage guard
// ---------------------------------------------------------------------------

const DECLARED_TYPE_RE = /(?:@?interface|class|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

function declaredTypeNames(source: string): readonly string[] {
  const names = new Set<string>();
  for (const m of withoutCommentsAndLiterals(source).matchAll(DECLARED_TYPE_RE)) names.add(m[1]);
  return [...names].sort();
}

function symmetricDifference(a: Iterable<string>, b: Iterable<string>): string[] {
  const setB = new Set(b);
  const setA = new Set(a);
  const out: string[] = [];
  for (const name of setA) if (!setB.has(name)) out.push(name);
  for (const name of setB) if (!setA.has(name)) out.push(name);
  return out.sort();
}

/**
 * The IR indexes top-level type declarations only, so a nested type added or removed
 * inside an already-parsed file produces no provider at all. Comparing the type names
 * the source declares with the names the IR reported on each side separates that blind
 * spot from changes the diff did see: the guard reports a difference the engine cannot
 * account for, and never claims what the difference means.
 */
function unindexedDeclarationGaps(
  parentWorld: WorldIndex,
  candidateWorld: WorldIndex
): readonly string[] {
  const gaps: string[] = [];
  for (const file of candidateWorld.host.getTrackedJavaFiles()) {
    const parentText = parentWorld.host.getFileContent(file);
    const candidateText = candidateWorld.host.getFileContent(file);
    if (parentText === undefined || candidateText === undefined) continue;
    const beforeNames = declaredTypeNames(parentText);
    const afterNames = declaredTypeNames(candidateText);
    if (beforeNames.join('') === afterNames.join('')) continue;
    const beforeIndexed = parentWorld.host.getFileClasses(file).map(c => c.simpleName);
    const afterIndexed = candidateWorld.host.getFileClasses(file).map(c => c.simpleName);
    const textDelta = symmetricDifference(beforeNames, afterNames);
    const irDelta = symmetricDifference(beforeIndexed, afterIndexed);
    const unaccounted = textDelta.filter(n => !irDelta.includes(n));
    if (unaccounted.length) gaps.push(`${file}: ${unaccounted.join(', ')}`);
  }
  return gaps.sort();
}

// ---------------------------------------------------------------------------
// Consumer impact classification
// ---------------------------------------------------------------------------

function visibilityRank(v: 'public' | 'protected' | 'package-private' | 'private'): number {
  switch (v) {
    case 'public': return 3;
    case 'protected': return 2;
    case 'package-private': return 1;
    case 'private': return 0;
  }
}

function findSubtypeMethodCollision(
  addedMethod: JavaMethodSignatureIR,
  subClass: JavaClassDeclIR
): { reason: string } | undefined {
  if (addedMethod.visibility === 'private') return undefined;

  for (const subMethod of subClass.methods) {
    if (subMethod.name !== addedMethod.name) continue;
    if (subMethod.parameters.length !== addedMethod.parameters.length) continue;

    let paramsMatch = true;
    for (let i = 0; i < addedMethod.parameters.length; i++) {
      const p1 = addedMethod.parameters[i].type;
      const p2 = subMethod.parameters[i].type;
      const hash1 = p1.irContentHash;
      const hash2 = p2.irContentHash;
      if (hash1 && hash2 && hash1 !== hash2) {
        paramsMatch = false;
        break;
      }
    }
    if (!paramsMatch) continue;

    // 1. Weaker visibility in subclass
    if (visibilityRank(subMethod.visibility) < visibilityRank(addedMethod.visibility)) {
      return {
        reason: `Subclass method '${subMethod.name}' in ${subClass.fqcn} has weaker visibility (${subMethod.visibility}) than added superclass method (${addedMethod.visibility})`
      };
    }

    // 2. Incompatible return type in subclass
    const r1 = addedMethod.returnType;
    const r2 = subMethod.returnType;
    if (r1.irContentHash && r2.irContentHash && r1.irContentHash !== r2.irContentHash) {
      if (r1.kind !== 'JAVA_VOID' && r2.kind !== 'JAVA_VOID') {
        return {
          reason: `Subclass method '${subMethod.name}' in ${subClass.fqcn} has return type incompatible with added superclass method`
        };
      }
    }
  }

  return undefined;
}

/**
 * Detect conflicting wildcard imports where two or more wildcard packages
 * export the target class name, causing unqualified references to be ambiguous (ADV-04).
 */
function hasConflictingWildcardImports(
  imports: ReadonlyArray<JavaImportIR>,
  targetSimpleName: string,
  typeIndex: ReadonlyMap<string, readonly JavaClassDeclIR[]>
): boolean {
  if (!targetSimpleName) return false;
  const wildcardPackages = imports
    .filter(i => !i.isStatic && i.isWildcard)
    .map(i => i.moduleSpecifier.replace(/\.\*$/, ''));
  if (wildcardPackages.length < 2) return false;

  const classesWithSameName = typeIndex.get(targetSimpleName) ?? [];
  let matchingWildcardPackages = 0;
  for (const pkg of wildcardPackages) {
    if (classesWithSameName.some(c => c.packageName === pkg)) {
      matchingWildcardPackages++;
    }
  }
  return matchingWildcardPackages >= 2;
}

/**
 * Classify how a given provider change impacts a consumer that references it.
 * Fail-closed by construction: only provably additive or provably unused outcomes
 * may read as safe, and every change kind is categorised at compile time.
 */
function classifyImpact(
  change: JavaProviderChangeKind,
  ref: JavaConsumerReferenceKind,
  callSite: JavaCallSiteIR | undefined,
  providerMemberName: string | undefined,
  ev: AdvisoryEvidence
): JavaConsumerImpactClassification {
  const providerClassSimple =
    ev.providerClassAfter?.simpleName || ev.providerClassBefore?.simpleName || '';
  const token =
    (providerMemberName && providerMemberName !== '<init>' ? providerMemberName : undefined) ||
    providerClassSimple;
  const tokenIsMethod =
    ev.providerMemberKind === 'METHOD' && token !== '' && providerMemberName !== '<init>';
  const usedInConsumer = mentionsToken(ev.consumerCode, token, tokenIsMethod);

  const hasWildcardConflict =
    Boolean(ev.consumerImports &&
    hasConflictingWildcardImports(ev.consumerImports, providerClassSimple, ev.typeIndex));

  const samePackageRef = ref === 'SAME_PACKAGE';
  const wildcardRef = ref === 'WILDCARD_IMPORT' || ref === 'STATIC_WILDCARD_IMPORT';
  const memberProvider = ev.providerMemberKind !== 'CLASS';

  // Call-site specific classification (Phase J-5)
  if (ref === 'CALL_SITE' || ref === 'METHOD_REFERENCE' || ref === 'CONSTRUCTOR_REFERENCE') {
    const isTargetMember =
      !providerMemberName ||
      callSite?.calleeName === providerMemberName ||
      (providerMemberName === '<init>' && callSite?.callKind === 'CONSTRUCTOR_CALL');

    if (isTargetMember) {
      if (change === 'METHOD_THROWS_CHANGED') return classifyThrowsChange(ev, callSite);
      const callBreakers = new Set<JavaProviderChangeKind>([
        'CLASS_REMOVED', 'METHOD_REMOVED', 'FIELD_REMOVED',
        'METHOD_RETURN_TYPE_CHANGED', 'METHOD_PARAMETER_REMOVED', 'METHOD_PARAMETER_ADDED',
        'METHOD_PARAMETER_TYPE_CHANGED', 'FIELD_TYPE_CHANGED',
        'CLASS_VISIBILITY_NARROWED', 'METHOD_VISIBILITY_NARROWED', 'FIELD_VISIBILITY_NARROWED',
        'METHOD_STATIC_CHANGED', 'FIELD_STATIC_CHANGED'
      ]);
      if (callBreakers.has(change)) return 'LIKELY_BROKEN';
      return 'LIKELY_COMPATIBLE';
    } else {
      // Call site invokes a different member on the class; unaffected by this member's change
      if (change === 'CLASS_REMOVED') return 'LIKELY_BROKEN';
      return 'UNAFFECTED';
    }
  }

  // Additive-only changes never break existing consumers, EXCEPT adding an abstract method to an interface breaks implementors
  // or adding a method that collides with an existing subclass method with weaker access or incompatible return type (§5.1.2)
  if (change === 'METHOD_ADDED') {
    if (ref === 'IMPLEMENTS') return 'LIKELY_BROKEN';
    if (ref === 'EXTENDS') {
      const added = ev.providerMethodAfter;
      const consumer = ev.consumerClass;
      if (added && consumer) {
        const collision = findSubtypeMethodCollision(added, consumer);
        if (collision) {
          return 'LIKELY_BROKEN';
        }
      }
    }
    return 'LIKELY_COMPATIBLE';
  }

  const additiveSafe = new Set<JavaProviderChangeKind>([
    'CLASS_ADDED', 'FIELD_ADDED',
    'CLASS_VISIBILITY_WIDENED', 'METHOD_VISIBILITY_WIDENED', 'FIELD_VISIBILITY_WIDENED'
  ]);
  if (additiveSafe.has(change)) return 'LIKELY_COMPATIBLE';

  // Removals always break consumers that directly reference the symbol
  const removals = new Set<JavaProviderChangeKind>([
    'CLASS_REMOVED', 'METHOD_REMOVED', 'FIELD_REMOVED'
  ]);
  if (removals.has(change)) {
    // A wildcard-imported consumer's scope is ambiguous if conflicting wildcard imports exist
    // or if the token is present in the file. If token is absent from file, it is provably unaffected (§4 Phase 1B #8).
    if (wildcardRef) {
      if (hasWildcardConflict) return 'ADVISORY_ONLY_LIMIT';
      if (!usedInConsumer) return 'UNAFFECTED';
      return 'ADVISORY_ONLY_LIMIT';
    }
    if (samePackageRef) {
      if (!usedInConsumer) return 'UNAFFECTED';
      return memberProvider ? 'UNRESOLVED' : 'LIKELY_BROKEN';
    }
    return 'LIKELY_BROKEN';
  }

  // Visibility narrowing always breaks consumers with broader access
  const narrowing = new Set<JavaProviderChangeKind>([
    'CLASS_VISIBILITY_NARROWED', 'METHOD_VISIBILITY_NARROWED', 'FIELD_VISIBILITY_NARROWED'
  ]);
  if (narrowing.has(change)) {
    if (samePackageRef && !usedInConsumer) return 'UNAFFECTED';
    if (wildcardRef) {
      if (hasWildcardConflict) return 'ADVISORY_ONLY_LIMIT';
      if (!usedInConsumer) return 'UNAFFECTED';
      return 'ADVISORY_ONLY_LIMIT';
    }
    return 'LIKELY_BROKEN';
  }

  // Type / signature changes: call sites and inheritors break; import-only references may not
  const signatureBreakers = new Set<JavaProviderChangeKind>([
    'METHOD_RETURN_TYPE_CHANGED', 'METHOD_PARAMETER_REMOVED', 'METHOD_PARAMETER_ADDED',
    'METHOD_PARAMETER_TYPE_CHANGED', 'FIELD_TYPE_CHANGED', 'CLASS_KIND_CHANGED',
    'METHOD_STATIC_CHANGED', 'FIELD_STATIC_CHANGED'
  ]);
  if (signatureBreakers.has(change)) {
    if (ref === 'EXTENDS' || ref === 'IMPLEMENTS') return 'LIKELY_BROKEN';
    if (samePackageRef) return usedInConsumer ? 'UNRESOLVED' : 'UNAFFECTED';
    if (wildcardRef) {
      if (hasWildcardConflict) return 'ADVISORY_ONLY_LIMIT';
      return usedInConsumer ? 'ADVISORY_ONLY_LIMIT' : 'UNAFFECTED';
    }
    if (ref === 'SINGLE_IMPORT' || ref === 'STATIC_SINGLE_IMPORT') {
      return usedInConsumer ? 'ADVISORY_ONLY_LIMIT' : 'UNAFFECTED';
    }
    return 'ADVISORY_ONLY_LIMIT';
  }

  // A new checked exception is only a break at a call chain that cannot discharge it.
  if (change === 'METHOD_THROWS_CHANGED') return 'ADVISORY_ONLY_LIMIT';

  if (change === 'METHOD_ABSTRACT_CHANGED') {
    const before = ev.providerMethodBefore;
    const after = ev.providerMethodAfter;
    if (!before || !after) return 'ADVISORY_ONLY_LIMIT';
    if (!after.isAbstract) return 'LIKELY_COMPATIBLE';
    if (ref !== 'EXTENDS' && ref !== 'IMPLEMENTS') return 'LIKELY_COMPATIBLE';
    const consumer = ev.consumerClass;
    if (!consumer) return 'ADVISORY_ONLY_LIMIT';
    if (consumer.isAbstract || consumer.kind === 'interface') return 'LIKELY_COMPATIBLE';
    if (usedInConsumer) return 'UNRESOLVED';
    return 'LIKELY_COMPATIBLE';
  }

  if (change === 'FIELD_FINAL_CHANGED') {
    const before = ev.providerFieldBefore;
    const after = ev.providerFieldAfter;
    if (!before || !after) return 'ADVISORY_ONLY_LIMIT';
    if (!after.isFinal) return 'LIKELY_COMPATIBLE';
    // Writing a now-final field is the only way this breaks a consumer, and a file
    // that never assigns the name provably does not.
    if (ev.consumerCode === undefined) return 'ADVISORY_ONLY_LIMIT';
    return isAssignedInSource(ev.consumerCode, token) ? 'UNRESOLVED' : 'UNAFFECTED';
  }

  if (change === 'SEALED_PERMITS_RESTRICTED') {
    if (ref !== 'EXTENDS' && ref !== 'IMPLEMENTS') return 'LIKELY_COMPATIBLE';
    const before = (ev.providerClassBefore?.permitsNames ?? []).map(simpleTypeName).sort();
    const after = (ev.providerClassAfter?.permitsNames ?? []).map(simpleTypeName).sort();
    const consumerName = ev.consumerClass?.simpleName ?? '';
    if (!before.length || !after.length || !consumerName) return 'ADVISORY_ONLY_LIMIT';
    if (after.includes(consumerName)) return 'LIKELY_COMPATIBLE';
    return before.includes(consumerName) ? 'LIKELY_BROKEN' : 'UNRESOLVED';
  }

  if (change === 'CONSTANT_VALUE_CHANGED') {
    // Signature-compatible: the declaration is intact, so nothing fails to compile.
    // The value is inlined into consumers, which is a behaviour change the advisory
    // layer cannot assess from source — abstain where the constant is actually used.
    return usedInConsumer ? 'ADVISORY_ONLY_LIMIT' : 'UNAFFECTED';
  }

  // Inheritance changes break direct inheritors
  if (change === 'INHERITANCE_CHANGED') {
    if (ref === 'EXTENDS' || ref === 'IMPLEMENTS') return 'LIKELY_BROKEN';
    if (samePackageRef && !usedInConsumer) return 'UNAFFECTED';
    return 'LIKELY_COMPATIBLE';
  }

  if (change === 'DECLARATION_CHANGED') {
    // Unenumerated structural edits (class header or method signature) are not
    // provably safe for inheritors; fail closed instead of asserting breakage — unless
    // the header edit is one whose consequence is decidable from the IR.
    if (ref === 'EXTENDS' || ref === 'IMPLEMENTS') {
      const before = ev.providerClassBefore;
      const after = ev.providerClassAfter;
      if (before && after) {
        if (!before.isFinal && after.isFinal) return 'LIKELY_BROKEN';
        if (!before.isSealed && after.isSealed) {
          const permitted = (after.permitsNames ?? []).map(simpleTypeName);
          const consumerName = ev.consumerClass?.simpleName;
          if (consumerName && permitted.length) {
            return permitted.includes(consumerName) ? 'LIKELY_COMPATIBLE' : 'LIKELY_BROKEN';
          }
        }
      }
      return 'UNRESOLVED';
    }
    if (samePackageRef && !usedInConsumer) return 'UNAFFECTED';
    return 'LIKELY_COMPATIBLE';
  }

  if (change === 'ANNOTATION_CHANGED') {
    if (samePackageRef && !usedInConsumer) return 'UNAFFECTED';
    return 'LIKELY_COMPATIBLE';
  }

  // Unreachable for the current vocabulary: each kind is routed above and the
  // compile-time partition forces a new kind to be categorised. Reaching it must
  // abstain loudly, never read as preserved.
  if (CHANGE_KIND_CATEGORY[change] === 'ADDITIVE_SAFE') return 'LIKELY_COMPATIBLE';
  ev.abstentionSink.add('ABST_UNROUTED_CHANGE_KIND');
  return 'ADVISORY_ONLY_LIMIT';
}

function rationalise(
  classification: JavaConsumerImpactClassification,
  change: JavaProviderChangeKind,
  ref: JavaConsumerReferenceKind,
  callSite?: JavaCallSiteIR,
  memberName?: string
): string {
  if (ref === 'CALL_SITE' || ref === 'METHOD_REFERENCE' || ref === 'CONSTRUCTOR_REFERENCE') {
    const target = callSite?.calleeName ?? memberName ?? 'member';
    if (classification === 'LIKELY_BROKEN') {
      return `${change} directly breaks call site invoking ${target} (line ${callSite?.line ?? '?'}, ${callSite?.evidenceKind ?? 'STATIC_AST'})`;
    }
    if (classification === 'LIKELY_COMPATIBLE') {
      return `${change} is compatible with call site invoking ${target}`;
    }
    if (classification === 'UNAFFECTED') {
      return `Call site invokes ${target} which is unaffected by ${change}`;
    }
  }
  if (classification === 'LIKELY_BROKEN') return `${change} is a breaking change for ${ref} consumers`;
  if (classification === 'LIKELY_COMPATIBLE') return `${change} is an additive change that does not break existing ${ref} references`;
  if (classification === 'ADVISORY_ONLY_LIMIT') return `${change} may affect ${ref} consumers; body-level analysis (Phase J-5) is required for certainty`;
  if (classification === 'UNRESOLVED') return 'Resolution was incomplete; result cannot be treated as preserved';
  return `${change} does not affect ${ref} consumers`;
}

// ---------------------------------------------------------------------------
// Consumer discovery
// ---------------------------------------------------------------------------

function isSubtypeOf(
  targetFqcn: string,
  ancestorFqcn: string,
  host: JavaSealedCompilerHost,
  parentHost?: JavaSealedCompilerHost
): boolean {
  if (targetFqcn === ancestorFqcn) return true;
  const ancestorSimple = ancestorFqcn.split('.').pop() ?? ancestorFqcn;
  const queue: string[] = [targetFqcn];
  const seen = new Set<string>([targetFqcn]);

  while (queue.length > 0) {
    if (seen.size > 32) break;
    const current = queue.shift()!;
    const cls = host.getClassByFQCN(current) ?? parentHost?.getClassByFQCN(current);
    if (!cls) continue;

    const parents: string[] = [];
    if (cls.extendsName) parents.push(cls.extendsName);
    parents.push(...cls.implementsNames);

    for (const p of parents) {
      const pSimple = p.split('.').pop() ?? p;
      if (p === ancestorFqcn || (pSimple === ancestorSimple && (!p.includes('.') || p === ancestorFqcn))) {
        return true;
      }
      let pFqcn = p;
      if (!p.includes('.')) {
        const fileImports = host.getFileImports(slash(cls.filePath));
        const imp = fileImports.find(i => !i.isStatic && !i.isWildcard && i.importedName === p);
        if (imp) {
          pFqcn = imp.moduleSpecifier;
        } else if (cls.packageName) {
          pFqcn = `${cls.packageName}.${p}`;
        }
      }
      if (pFqcn === ancestorFqcn) return true;
      if (!seen.has(pFqcn)) {
        seen.add(pFqcn);
        queue.push(pFqcn);
      }
    }
  }
  return false;
}

/**
 * Discover all Java classes in `host` that reference the given provider FQCN
 * via their import lists or inheritance declarations.
 *
 * Coverage: J-1 (single import), J-2 (wildcard import), J-3 (static single),
 *           J-4 (static wildcard), J-6 (same-package), J-7/J-8/J-9 (extends/implements).
 *
 * Method-body call sites (J-5+) require Phase J-5 (tree-sitter/JavaParser) and are
 * intentionally absent here.
 */
function discoverConsumers(
  host: JavaSealedCompilerHost,
  providerFqcn: string,
  parentHost?: JavaSealedCompilerHost
): JavaConsumerReference[] {
  const refs: JavaConsumerReference[] = [];
  const providerSimpleName = providerFqcn.split('.').pop() ?? '';

  const hostCls = host.getClassByFQCN(providerFqcn) ?? parentHost?.getClassByFQCN(providerFqcn);
  const providerPackage = hostCls?.packageName ?? (providerFqcn.includes('.')
    ? providerFqcn.slice(0, providerFqcn.lastIndexOf('.'))
    : '');

  const isInnerClass = hostCls?.binaryName.includes('$') || false;
  const outerSimpleName = isInnerClass ? hostCls!.binaryName.split('$')[0] : '';
  const outerFqcn = isInnerClass
    ? (hostCls!.packageName ? `${hostCls!.packageName}.${outerSimpleName}` : outerSimpleName)
    : '';

  for (const cls of host.getAllClasses()) {
    const filePath = slash(cls.filePath);
    const imports = host.getFileImports(filePath);

    // J-1: single-type import  (import com.acme.Foo; or import com.acme.Outer;)
    const singleImport = imports.find(
      i => !i.isStatic && !i.isWildcard && (i.moduleSpecifier === providerFqcn || (outerFqcn && i.moduleSpecifier === outerFqcn))
    );
    if (singleImport) {
      refs.push({ providerId: providerFqcn, consumerFile: filePath, consumerFqcn: cls.fqcn, referenceKind: 'SINGLE_IMPORT', directness: 'DIRECT', resolutionStatus: 'COMPLETE', bindingKind: 'J-1' });
    }

    // J-2: wildcard import  (import com.acme.*; or import com.acme.Outer.*;)
    if (providerPackage) {
      const wildcardImport = imports.find(
        i => !i.isStatic && i.isWildcard && (i.moduleSpecifier === `${providerPackage}.*` || (outerFqcn && i.moduleSpecifier === `${outerFqcn}.*`))
      );
      if (wildcardImport) {
        refs.push({ providerId: providerFqcn, consumerFile: filePath, consumerFqcn: cls.fqcn, referenceKind: 'WILDCARD_IMPORT', directness: 'DIRECT', resolutionStatus: 'COMPLETE', bindingKind: 'J-2' });
      }
    }

    // J-3: static single import  (import static com.acme.Foo.MEMBER;)
    const staticSingleImport = imports.find(
      i => i.isStatic && !i.isWildcard && (i.moduleSpecifier.startsWith(`${providerFqcn}.`) || (outerFqcn && i.moduleSpecifier.startsWith(`${outerFqcn}.`)))
    );
    if (staticSingleImport) {
      refs.push({ providerId: providerFqcn, consumerFile: filePath, consumerFqcn: cls.fqcn, referenceKind: 'STATIC_SINGLE_IMPORT', directness: 'DIRECT', resolutionStatus: 'COMPLETE', bindingKind: 'J-3' });
    }

    // J-4: static wildcard import  (import static com.acme.Foo.*;)
    const staticWildcardImport = imports.find(
      i => i.isStatic && i.isWildcard && (i.moduleSpecifier === `${providerFqcn}.*` || (outerFqcn && i.moduleSpecifier === `${outerFqcn}.*`))
    );
    if (staticWildcardImport) {
      refs.push({ providerId: providerFqcn, consumerFile: filePath, consumerFqcn: cls.fqcn, referenceKind: 'STATIC_WILDCARD_IMPORT', directness: 'DIRECT', resolutionStatus: 'COMPLETE', bindingKind: 'J-4' });
    }

    // J-6: same-package reference (no import needed in Java)
    if (providerPackage && cls.packageName === providerPackage && cls.fqcn !== providerFqcn && (!outerFqcn || cls.fqcn !== outerFqcn)) {
      const alreadyCaptured = refs.some(r => r.consumerFqcn === cls.fqcn && r.referenceKind === 'SINGLE_IMPORT');
      if (!alreadyCaptured) {
        refs.push({ providerId: providerFqcn, consumerFile: filePath, consumerFqcn: cls.fqcn, referenceKind: 'SAME_PACKAGE', directness: 'DIRECT', resolutionStatus: 'COMPLETE', bindingKind: 'J-6' });
      }
    }

    // J-7 / J-9: extends  (class Foo extends Provider -> J-7; interface Foo extends Provider -> J-9)
    if (cls.extendsName) {
      const extendsFqcn = cls.extendsName.includes('.') ? cls.extendsName : `${providerPackage}.${cls.extendsName}`;
      if (
        extendsFqcn === providerFqcn ||
        cls.extendsName === providerSimpleName ||
        (isInnerClass && (cls.extendsName === `${outerSimpleName}.${providerSimpleName}` || extendsFqcn === `${outerFqcn}.${providerSimpleName}`))
      ) {
        const bindingKind = cls.kind === 'interface' ? 'J-9' : 'J-7';
        refs.push({ providerId: providerFqcn, consumerFile: filePath, consumerFqcn: cls.fqcn, referenceKind: 'EXTENDS', directness: 'DIRECT', resolutionStatus: 'COMPLETE', bindingKind });
      }
    }

    // J-8 / J-9: implements / interface extends
    for (const implName of cls.implementsNames) {
      const implFqcn = implName.includes('.') ? implName : `${providerPackage}.${implName}`;
      if (
        implFqcn === providerFqcn ||
        implName === providerSimpleName ||
        (isInnerClass && (implName === `${outerSimpleName}.${providerSimpleName}` || implFqcn === `${outerFqcn}.${providerSimpleName}`))
      ) {
        const bindingKind = cls.kind === 'interface' ? 'J-9' : 'J-8';
        refs.push({ providerId: providerFqcn, consumerFile: filePath, consumerFqcn: cls.fqcn, referenceKind: 'IMPLEMENTS', directness: 'DIRECT', resolutionStatus: 'COMPLETE', bindingKind });
      }
    }

    // J-12 / J-5: Type-position references without import (field types, method return/param types) (§4 Phase 1B #7)
    if (!singleImport && cls.packageName !== providerPackage) {
      for (const f of cls.fields) {
        const fieldTypeRef = f.type.kind === 'JAVA_REFERENCE' ? (f.type as any) : undefined;
        if (fieldTypeRef?.qualifiedName === providerFqcn) {
          refs.push({
            providerId: providerFqcn,
            consumerFile: filePath,
            consumerFqcn: cls.fqcn,
            referenceKind: 'CALL_SITE',
            directness: 'DIRECT',
            resolutionStatus: 'COMPLETE',
            bindingKind: 'J-5',
            callSite: {
              enclosingClassFqcn: cls.fqcn,
              enclosingMethodName: '<class>',
              calleeName: f.name,
              receiverText: providerSimpleName,
              argumentCount: 0,
              line: f.line,
              callKind: 'FIELD_ACCESS',
              evidenceKind: 'STATIC_AST',
              resolvedTargetFqcn: providerFqcn,
              rawText: `${fieldTypeRef.simpleName ?? f.name} ${f.name}`
            }
          });
        }
      }

      for (const m of cls.methods) {
        const retRef = m.returnType.kind === 'JAVA_REFERENCE' ? (m.returnType as any) : undefined;
        const retMatches = retRef?.qualifiedName === providerFqcn;
        const paramMatches = m.parameters.some(p => {
          const pRef = p.type.kind === 'JAVA_REFERENCE' ? (p.type as any) : undefined;
          return pRef?.qualifiedName === providerFqcn;
        });
        if (retMatches || paramMatches) {
          refs.push({
            providerId: providerFqcn,
            consumerFile: filePath,
            consumerFqcn: cls.fqcn,
            referenceKind: 'CALL_SITE',
            directness: 'DIRECT',
            resolutionStatus: 'COMPLETE',
            bindingKind: 'J-5',
            callSite: {
              enclosingClassFqcn: cls.fqcn,
              enclosingMethodName: m.name,
              calleeName: m.name,
              receiverText: providerSimpleName,
              argumentCount: m.parameters.length,
              line: m.lineStart,
              callKind: 'METHOD_CALL',
              evidenceKind: 'STATIC_AST',
              resolvedTargetFqcn: providerFqcn,
              rawText: `${m.name}(...)`
            }
          });
        }
      }
    }

    // J-5 / J-10 / J-11: Method-body call sites (Phase J-5)
    const classCallSites = cls.callSites ?? host.getFileCallSites(filePath).filter(cs => cs.enclosingClassFqcn === cls.fqcn);
    for (const cs of classCallSites) {
      const isTarget =
        cs.resolvedTargetFqcn === providerFqcn ||
        (Boolean(cs.resolvedTargetFqcn) && isSubtypeOf(cs.resolvedTargetFqcn!, providerFqcn, host, parentHost)) ||
        (cs.receiverText && (
          cs.receiverText === providerSimpleName ||
          cs.receiverText === providerFqcn ||
          (isInnerClass && (
            cs.receiverText === `${outerSimpleName}.${providerSimpleName}` ||
            cs.receiverText === outerSimpleName ||
            cs.receiverText === outerFqcn
          ))
        ));

      if (isTarget) {
        if (cs.callKind === 'CONSTRUCTOR_REFERENCE') {
          refs.push({
            providerId: providerFqcn,
            consumerFile: filePath,
            consumerFqcn: cls.fqcn,
            referenceKind: 'CONSTRUCTOR_REFERENCE',
            directness: 'DIRECT',
            resolutionStatus: 'COMPLETE',
            bindingKind: 'J-11',
            callSite: cs
          });
        } else if (cs.callKind === 'METHOD_REFERENCE') {
          refs.push({
            providerId: providerFqcn,
            consumerFile: filePath,
            consumerFqcn: cls.fqcn,
            referenceKind: 'METHOD_REFERENCE',
            directness: 'DIRECT',
            resolutionStatus: 'COMPLETE',
            bindingKind: 'J-10',
            callSite: cs
          });
        } else {
          refs.push({
            providerId: providerFqcn,
            consumerFile: filePath,
            consumerFqcn: cls.fqcn,
            referenceKind: 'CALL_SITE',
            directness: 'DIRECT',
            resolutionStatus: 'COMPLETE',
            bindingKind: 'J-5',
            callSite: cs
          });
        }
      }
    }
  }

  // Deduplicate by (consumerFqcn, providerId, referenceKind, callSite key)
  const seen = new Map<string, JavaConsumerReference>();
  for (const ref of refs) {
    const key = ref.callSite
      ? `${ref.consumerFqcn}|${ref.providerId}|${ref.referenceKind}|${ref.callSite.calleeName}|${ref.callSite.line}`
      : `${ref.consumerFqcn}|${ref.providerId}|${ref.referenceKind}`;
    if (!seen.has(key)) seen.set(key, ref);
  }

  return [...seen.values()].sort(
    (a, b) => (a.consumerFqcn !== b.consumerFqcn ? (a.consumerFqcn < b.consumerFqcn ? -1 : 1) : (a.referenceKind < b.referenceKind ? -1 : a.referenceKind > b.referenceKind ? 1 : 0))
  );
}

// ---------------------------------------------------------------------------
// World construction
// ---------------------------------------------------------------------------

interface WorldIndex {
  readonly host: JavaSealedCompilerHost;
  readonly unresolved: string[];
  readonly buildQualified: boolean;
}

function buildWorld(rev: JavaSealedRevision): WorldIndex {
  const snapshotInput = revisionToSnapshotInput(rev);
  const unresolved: string[] = [...(rev.selection?.incompleteReasons ?? [])];
  let buildQualified = true;
  try {
    const buildModel = JavaBuildModelExtractor.extractBuildModel(snapshotInput);
    if (buildModel.qualificationStatus !== 'SUPPORTED_DECLARATIVE') {
      buildQualified = false;
      unresolved.push(...buildModel.disqualificationReasons);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    unresolved.push(`BUILD_MODEL_EXTRACTION_FAILURE: ${msg}`);
    buildQualified = false;
  }
  let host: JavaSealedCompilerHost;
  try {
    host = new JavaSealedCompilerHost(snapshotInput);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    unresolved.push(`SNAPSHOT_BUILD_FAILURE: ${msg}`);
    host = new JavaSealedCompilerHost({ trackedFiles: [], readTextFile: () => undefined });
  }
  return { host, unresolved, buildQualified };
}

// ---------------------------------------------------------------------------
// Provider diff
// ---------------------------------------------------------------------------

/**
 * The IR behind one provider id. The classifier decides from these pairs instead of
 * from the change label alone, which is what lets it tell "made final" from "no longer
 * final" and "throws a checked exception" from "throws a runtime one".
 */
interface ProviderIrContext {
  readonly classBefore: JavaClassDeclIR | undefined;
  readonly classAfter: JavaClassDeclIR | undefined;
  readonly methodBefore: JavaMethodSignatureIR | undefined;
  readonly methodAfter: JavaMethodSignatureIR | undefined;
  readonly fieldBefore: JavaFieldIR | undefined;
  readonly fieldAfter: JavaFieldIR | undefined;
}

interface ProviderDiffResult {
  readonly providers: JavaProviderDeclaration[];
  readonly irContexts: ReadonlyMap<string, ProviderIrContext>;
}

/**
 * Collect all provider declarations that changed between parent and candidate.
 *
 * Detection strategy:
 *   1. Class-level shape (kind, visibility, inheritance, permits, annotations) — header only.
 *   2. Method signatures — paired by signature; leftovers paired by name, so an overload
 *      edit reads as METHOD_PARAMETER_* instead of a phantom remove plus add.
 *   3. Field declarations — keyed by name.
 */
function diffProviders(
  parentWorld: WorldIndex,
  candidateWorld: WorldIndex,
  targetFqcn?: string
): ProviderDiffResult {
  const providers: JavaProviderDeclaration[] = [];
  const irContexts = new Map<string, ProviderIrContext>();

  const parentClasses = new Map(parentWorld.host.getAllClasses().map(c => [c.fqcn, c]));
  const candidateClasses = new Map(candidateWorld.host.getAllClasses().map(c => [c.fqcn, c]));
  const allFqcns = [...new Set([...parentClasses.keys(), ...candidateClasses.keys()])].sort();

  for (const fqcn of allFqcns) {
    // A target-scoped run diffs the target type *and* the types declared inside it: a
    // nested type removal is precisely what a consumer of `Outer.Nested` breaks on, so
    // restricting the scope to the exact FQCN hides the change it exists to find.
    if (targetFqcn && fqcn !== targetFqcn && !fqcn.startsWith(`${targetFqcn}.`)) continue;

    const before = parentClasses.get(fqcn);
    const after = candidateClasses.get(fqcn);
    const providerFile = slash((after ?? before!).filePath);

    const emitMethod = (
      id: string,
      bm: JavaMethodSignatureIR | undefined,
      am: JavaMethodSignatureIR | undefined,
      change: JavaProviderChangeKind
    ): void => {
      const repr = am ?? bm!;
      providers.push({
        id,
        file: providerFile,
        fqcn,
        memberName: repr.name,
        memberKind: 'METHOD',
        span: repr.lineStart > 0 ? { file: providerFile, line: repr.lineStart } : null,
        before: bm ? renderMethod(bm) : null,
        after: am ? renderMethod(am) : null,
        change,
        identity: bm && am ? 'CASE_A' : 'CASE_B'
      });
      irContexts.set(id, {
        classBefore: before, classAfter: after,
        methodBefore: bm, methodAfter: am,
        fieldBefore: undefined, fieldAfter: undefined
      });
    };

    // --- Class-level diff: gated on header-only comparison so member edits
    // never emit a spurious class-level DECLARATION_CHANGED ---
    const beforeHeader = before ? renderClassHeader(before) : null;
    const afterHeader = after ? renderClassHeader(after) : null;
    const beforeText = before ? renderClassDecl(before) : null;
    const afterText = after ? renderClassDecl(after) : null;

    if (beforeHeader !== afterHeader) {
      const classChange = classChangeKind(before, after);
      const representative = after ?? before!;
      providers.push({
        id: fqcn,
        file: slash(representative.filePath),
        fqcn,
        memberName: '',
        memberKind: 'CLASS',
        span: representative.lineStart > 0 ? { file: slash(representative.filePath), line: representative.lineStart } : null,
        before: beforeText,
        after: afterText,
        change: classChange,
        identity: before && after ? 'CASE_A' : 'CASE_B'
      });
      irContexts.set(fqcn, {
        classBefore: before, classAfter: after,
        methodBefore: undefined, methodAfter: undefined,
        fieldBefore: undefined, fieldAfter: undefined
      });
    }

    // Method and field diffs are only meaningful when both sides exist and the class kind is unchanged
    if (before && after && before.kind === after.kind) {
      // --- Method-level diff, paired by signature ---
      const beforeMethods = methodIdentityMap(fqcn, before.methods);
      const afterMethods = methodIdentityMap(fqcn, after.methods);
      const methodIds = [...new Set([...beforeMethods.keys(), ...afterMethods.keys()])].sort();
      const leftoverBefore = new Map<string, JavaMethodSignatureIR>();
      const leftoverAfter = new Map<string, JavaMethodSignatureIR>();

      for (const mid of methodIds) {
        const bm = beforeMethods.get(mid);
        const am = afterMethods.get(mid);
        if (bm && am) {
          if (bm.irContentHash === am.irContentHash) continue;
          emitMethod(mid, bm, am, methodChangeKind(bm, am));
        } else if (bm) {
          leftoverBefore.set(mid, bm);
        } else if (am) {
          leftoverAfter.set(mid, am);
        }
      }

      const byName = (source: Map<string, JavaMethodSignatureIR>): Map<string, JavaMethodSignatureIR[]> => {
        const grouped = new Map<string, JavaMethodSignatureIR[]>();
        for (const [, m] of [...source].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
          const bucket = grouped.get(m.name);
          if (bucket) bucket.push(m);
          else grouped.set(m.name, [m]);
        }
        return grouped;
      };
      const removedByName = byName(leftoverBefore);
      const addedByName = byName(leftoverAfter);

      for (const name of [...new Set([...removedByName.keys(), ...addedByName.keys()])].sort()) {
        const removed = removedByName.get(name) ?? [];
        const added = addedByName.get(name) ?? [];
        if (removed.length === 1 && added.length === 1) {
          emitMethod(
            `${fqcn}#${name}#signature-edit`,
            removed[0],
            added[0],
            methodChangeKind(removed[0], added[0])
          );
          continue;
        }
        for (const bm of removed) {
          emitMethod(`${fqcn}#${bm.name}#${bm.declarationOrdinal}#removed`, bm, undefined, 'METHOD_REMOVED');
        }
        for (const am of added) {
          emitMethod(`${fqcn}#${am.name}#${am.declarationOrdinal}#added`, undefined, am, 'METHOD_ADDED');
        }
      }

      // --- Field-level diff ---
      const beforeFields = new Map<string, JavaFieldIR>();
      for (const f of before.fields) beforeFields.set(renderFieldId(fqcn, f), f);
      const afterFields = new Map<string, JavaFieldIR>();
      for (const f of after.fields) afterFields.set(renderFieldId(fqcn, f), f);
      const allFieldIds = [...new Set([...beforeFields.keys(), ...afterFields.keys()])].sort();

      for (const fid of allFieldIds) {
        const bf = beforeFields.get(fid);
        const af = afterFields.get(fid);
        if ((bf?.irContentHash ?? null) === (af?.irContentHash ?? null)) continue;
        const fieldChange = fieldChangeKind(bf, af);
        const repr = af ?? bf!;
        providers.push({
          id: fid,
          file: slash((after ?? before!).filePath),
          fqcn,
          memberName: repr.name,
          memberKind: 'FIELD',
          span: repr.line > 0 ? { file: slash((after ?? before!).filePath), line: repr.line } : null,
          before: bf ? renderField(bf) : null,
          after: af ? renderField(af) : null,
          change: fieldChange,
          identity: bf && af ? 'CASE_A' : 'CASE_B'
        });
        irContexts.set(fid, {
          classBefore: before, classAfter: after,
          methodBefore: undefined, methodAfter: undefined,
          fieldBefore: bf, fieldAfter: af
        });
      }
    }
  }

  return { providers, irContexts };
}

// ---------------------------------------------------------------------------
// Main analyzer class
// ---------------------------------------------------------------------------

/**
 * Advisory-only Java impact analyzer — Phase J-4.
 *
 * Usage:
 * ```ts
 * const analyzer = new AdvisoryJavaImpactAnalyzer();
 * const result = analyzer.analyze({ parent, candidate });
 * // result.certificationStatus === 'ADVISORY_ONLY'  — always
 * ```
 *
 * The result feeds into the reconciler at casebgoal.md §Phase 7.
 * It NEVER enters VerdictAuthority or the certified proof pipeline.
 */
export class AdvisoryJavaImpactAnalyzer {
  public analyze(input: JavaAdvisoryInput): JavaAdvisoryImpactResult {
    try {
      const started = performance.now();

      // Build sealed worlds for parent and candidate independently.
      // No host object crosses the revision boundary (mirrors the DualProgramContext invariant).
      const parentWorld = buildWorld(input.parent);
      const candidateWorld = buildWorld(input.candidate);

      const targetFqcn = input.target?.fqcn;
      const targetMemberName = input.target?.memberName;

      // --- Provider diff ---
      const providerDiff = diffProviders(parentWorld, candidateWorld, targetFqcn);

      // If a specific member name was requested, further filter to that member
      const providers = targetMemberName
        ? providerDiff.providers.filter(p => p.memberKind === 'CLASS' || p.memberName === targetMemberName)
        : providerDiff.providers;

      const impactAbstentions = new Set<JavaAdvisoryAbstentionCode>();
      // Built on demand: cloning every class in both worlds costs real time on a large
      // snapshot, and most runs never ask a hierarchy or implementor question.
      let typeIndexCache: ReadonlyMap<string, readonly JavaClassDeclIR[]> | undefined;
      const getTypeIndex = (): ReadonlyMap<string, readonly JavaClassDeclIR[]> =>
        (typeIndexCache ??= buildTypeIndex(parentWorld, candidateWorld));
      const hasUnresolved = candidateWorld.unresolved.length > 0 || parentWorld.unresolved.length > 0;

      // Host lookups deep-clone the IR they return, so the same consumer is fetched
      // once per run rather than once per reference to it.
      const consumerClassCache = new Map<string, JavaClassDeclIR | undefined>();
      const consumerCodeCache = new Map<string, string | undefined>();
      const consumerClassOf = (fqcn: string): JavaClassDeclIR | undefined => {
        if (!consumerClassCache.has(fqcn)) {
          consumerClassCache.set(
            fqcn,
            candidateWorld.host.getClassByFQCN(fqcn) ?? parentWorld.host.getClassByFQCN(fqcn)
          );
        }
        return consumerClassCache.get(fqcn);
      };
      const consumerCodeOf = (file: string): string | undefined => {
        if (!consumerCodeCache.has(file)) {
          const raw =
            candidateWorld.host.getFileContent(file) ?? parentWorld.host.getFileContent(file);
          consumerCodeCache.set(file, raw === undefined ? undefined : withoutCommentsAndLiterals(raw));
        }
        return consumerCodeCache.get(file);
      };

      // --- Consumer discovery ---
      const consumers: JavaConsumerReference[] = [];
      const impacts: JavaConsumerImpact[] = [];

      for (const provider of providers) {
        // Consumer graph is always rooted at the class FQCN; method/field-level providers
        // propagate impact through that class's consumer references.
        const classFqcn = provider.fqcn;
        const refs = discoverConsumers(candidateWorld.host, classFqcn, parentWorld.host);

        // Account for missing unindexed submodule descriptors in reactor
        const missingPomReasons = [...candidateWorld.unresolved, ...parentWorld.unresolved].filter(u =>
          u.includes('Missing submodule pom.xml at declared path')
        );
        for (const unres of missingPomReasons) {
          const match = unres.match(/Missing submodule pom\.xml at declared path '([^']+)'/);
          if (match) {
            const missingMod = match[1].replace(/\/pom\.xml$/, '');
            refs.push({
              providerId: classFqcn,
              consumerFile: `${missingMod}/...`,
              consumerFqcn: 'UNKNOWN_CONSUMER',
              referenceKind: 'CALL_SITE',
              directness: 'DIRECT',
              resolutionStatus: 'INCOMPLETE',
              bindingKind: 'UNKNOWN'
            });
          }
        }

        const context = providerDiff.irContexts.get(provider.id);
        for (const ref of refs) {
          consumers.push(ref);
          const classification: JavaConsumerImpactClassification =
            ref.resolutionStatus === 'INCOMPLETE'
              ? 'UNRESOLVED'
              : classifyImpact(provider.change, ref.referenceKind, ref.callSite, provider.memberName, {
                providerClassBefore: context?.classBefore,
                providerClassAfter: context?.classAfter,
                providerMethodBefore: context?.methodBefore,
                providerMethodAfter: context?.methodAfter,
                providerFieldBefore: context?.fieldBefore,
                providerFieldAfter: context?.fieldAfter,
                providerMemberKind: provider.memberKind,
                consumerClass: consumerClassOf(ref.consumerFqcn),
                consumerCode: consumerCodeOf(ref.consumerFile),
                consumerImports: candidateWorld.host.getFileImports(ref.consumerFile),
                get typeIndex() {
                  return getTypeIndex();
                },
                abstentionSink: impactAbstentions
              });
          impacts.push({
            providerId: provider.id,
            consumerFile: ref.consumerFile,
            consumerFqcn: ref.consumerFqcn,
            referenceKind: ref.referenceKind,
            line: ref.callSite?.line,
            classification,
            rationale: rationalise(classification, provider.change, ref.referenceKind, ref.callSite, provider.memberName)
          });
        }
      }

      // --- Build traces ---
      const traces: JavaAdvisoryImpactTrace[] = impacts.map(impact => {
        const provider = providers.find(p => p.id === impact.providerId)!;
        const steps: JavaAdvisoryTraceStep[] = [
          {
            kind: 'PROVIDER',
            file: provider.file,
            span: provider.span,
            detail: `${provider.fqcn}${provider.memberName ? '#' + provider.memberName : ''} (${provider.change})`
          }
        ];
        if (impact.referenceKind === 'EXTENDS') {
          steps.push({ kind: 'EXTENDS', file: impact.consumerFile, span: null, detail: `${impact.consumerFqcn} extends ${provider.fqcn}` });
        } else if (impact.referenceKind === 'IMPLEMENTS') {
          steps.push({ kind: 'IMPLEMENTS', file: impact.consumerFile, span: null, detail: `${impact.consumerFqcn} implements ${provider.fqcn}` });
        } else if (impact.referenceKind === 'CALL_SITE' || impact.referenceKind === 'METHOD_REFERENCE' || impact.referenceKind === 'CONSTRUCTOR_REFERENCE') {
          const consumerRef = consumers.find(c => c.providerId === impact.providerId && c.consumerFqcn === impact.consumerFqcn && c.referenceKind === impact.referenceKind);
          const cs = consumerRef?.callSite;
          steps.push({
            kind: 'CONSUMER',
            file: impact.consumerFile,
            span: cs ? { file: impact.consumerFile, line: cs.line } : null,
            detail: `${impact.consumerFqcn} invokes ${cs?.receiverText ? cs.receiverText + '.' : ''}${cs?.calleeName ?? provider.memberName}() [${cs?.evidenceKind ?? 'STATIC_AST'}]`
          });
        } else {
          steps.push({ kind: 'IMPORT', file: impact.consumerFile, span: null, detail: `${impact.referenceKind} reference to ${provider.fqcn}` });
        }
        steps.push({ kind: 'CONSUMER', file: impact.consumerFile, span: null, detail: impact.consumerFqcn });
        if (impact.classification === 'ADVISORY_ONLY_LIMIT') {
          steps.push({ kind: 'LIMIT', file: impact.consumerFile, span: null, detail: 'Body-level analysis (Phase J-5) required for certainty' });
        }
        const completeness: 'COMPLETE' | 'INCONCLUSIVE' =
          impact.classification === 'ADVISORY_ONLY_LIMIT' || impact.classification === 'UNRESOLVED'
            ? 'INCONCLUSIVE'
            : 'COMPLETE';
        return { providerId: provider.id, classification: impact.classification, completeness, steps };
      }).sort((a, b) => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0));

      // --- Resource budget check ---
      const executionBudgetExceeded =
        (input.resourceLimits?.maxExecutionMs !== undefined &&
          performance.now() - started > input.resourceLimits.maxExecutionMs) ||
        (input.resourceLimits?.maxRssBytes !== undefined &&
          process.memoryUsage().rss > input.resourceLimits.maxRssBytes);

      const targetMissing =
        targetFqcn !== undefined &&
        !parentWorld.host.getClassByFQCN(targetFqcn) &&
        !candidateWorld.host.getClassByFQCN(targetFqcn);

      const incomplete =
        executionBudgetExceeded ||
        targetMissing ||
        parentWorld.unresolved.length > 0 ||
        candidateWorld.unresolved.length > 0;

      const totalClasses = parentWorld.host.getAllClasses().length + candidateWorld.host.getAllClasses().length;

      // --- Verdict ---
      // Two soundness guards sit on top of the aggregation. They only demote a
      // PRESERVED the snapshot cannot prove; they can never promote one.
      // Pillar 2: High-confidence violations outrank fallback unknowns. Only fatal toolchain failures
      // (budget exceeded or target missing) fail-close above proven violations.
      const fatalToolchainFailure = executionBudgetExceeded || targetMissing;
      const hasViolations = impacts.some(i => i.classification === 'LIKELY_BROKEN');

      const verdictBeforeGuards: JavaAdvisoryVerdict =
        fatalToolchainFailure || totalClasses === 0
          ? 'INCONCLUSIVE'
          : hasViolations
            ? 'LIKELY_VIOLATED'
            : incomplete || impacts.some(i => i.classification === 'ADVISORY_ONLY_LIMIT' || i.classification === 'UNRESOLVED')
              ? 'INCONCLUSIVE'
              : providers.length === 0 ||
                impacts.every(i => i.classification === 'UNAFFECTED' || i.classification === 'LIKELY_COMPATIBLE')
                ? 'LIKELY_PRESERVED'
                : 'INCONCLUSIVE';

      const parentFiles = input.parent.files;
      const candidateFiles = input.candidate.files;
      const isCandidateProvider = 'readTextFile' in candidateFiles && typeof (candidateFiles as any).readTextFile === 'function';
      const isParentProvider = 'readTextFile' in parentFiles && typeof (parentFiles as any).readTextFile === 'function';
      const allSealedFiles: JavaSnapshotProvider = {
        trackedFiles: Array.from(new Set([
          ...(isParentProvider ? ((parentFiles as any).trackedFiles as readonly string[]) : Object.keys(parentFiles)),
          ...(isCandidateProvider ? ((candidateFiles as any).trackedFiles as readonly string[]) : Object.keys(candidateFiles))
        ])).sort(),
        readTextFile(p: string) {
          if (isCandidateProvider) {
            const text = (candidateFiles as any).readTextFile(p);
            if (text !== undefined) return text;
          } else {
            const text = (candidateFiles as Record<string, string>)[p];
            if (text !== undefined) return text;
          }
          if (isParentProvider) {
            return (parentFiles as any).readTextFile(p);
          } else {
            return (parentFiles as Record<string, string>)[p];
          }
        }
      };
      const frameworkReachableProviders: { provider: JavaProviderDeclaration; evidence: FrameworkReachabilityEvidence }[] = [];
      for (const provider of providers) {
        const context = providerDiff.irContexts.get(provider.id);
        const cls = context?.classAfter ?? context?.classBefore;
        const method = context?.methodAfter ?? context?.methodBefore;
        const field = context?.fieldAfter ?? context?.fieldBefore;
        const evidence = scanProviderFrameworkReachability(
          provider.id,
          provider.fqcn,
          provider.memberName,
          allSealedFiles,
          cls,
          method,
          field
        );
        if (evidence) {
          frameworkReachableProviders.push({ provider, evidence });
        }
      }

      const BREAKING_OR_CONTRACT_CHANGES: ReadonlySet<JavaProviderChangeKind> = new Set([
        ...INTERFACE_CONTRACT_CHANGES,
        'METHOD_RETURN_TYPE_CHANGED',
        'METHOD_PARAMETER_REMOVED',
        'METHOD_PARAMETER_ADDED',
        'METHOD_PARAMETER_TYPE_CHANGED',
        'METHOD_STATIC_CHANGED',
        'FIELD_REMOVED',
        'FIELD_TYPE_CHANGED',
        'FIELD_FINAL_CHANGED',
        'FIELD_STATIC_CHANGED',
        'CLASS_VISIBILITY_NARROWED',
        'METHOD_VISIBILITY_NARROWED',
        'FIELD_VISIBILITY_NARROWED'
      ]);

      const guardsApply = verdictBeforeGuards === 'LIKELY_PRESERVED';
      const unsealedInterfaces = guardsApply
        ? providers.filter(provider => {
          if (!INTERFACE_CONTRACT_CHANGES.has(provider.change)) return false;
          const context = providerDiff.irContexts.get(provider.id);
          const cls = context?.classAfter ?? context?.classBefore;
          return cls?.kind === 'interface' && implementorSetIsOpen(cls, getTypeIndex());
        })
        : [];
      const coverageGaps = guardsApply ? unindexedDeclarationGaps(parentWorld, candidateWorld) : [];
      const frameworkReachabilityGaps = guardsApply
        ? frameworkReachableProviders.filter(fp => BREAKING_OR_CONTRACT_CHANGES.has(fp.provider.change))
        : [];

      const guardDemotedPreserved =
        verdictBeforeGuards === 'LIKELY_PRESERVED' &&
        (unsealedInterfaces.length > 0 || coverageGaps.length > 0 || frameworkReachabilityGaps.length > 0);

      const verdict: JavaAdvisoryVerdict = guardDemotedPreserved ? 'INCONCLUSIVE' : verdictBeforeGuards;

      // --- Deduplicate consumers ---
      const uniqueConsumers = [
        ...new Map(consumers.map(c => [JSON.stringify(c), c])).values()
      ].sort((a, b) => (a.consumerFqcn < b.consumerFqcn ? -1 : a.consumerFqcn > b.consumerFqcn ? 1 : 0));

      // --- Unresolved file list ---
      const unresolvedFiles = [
        ...parentWorld.unresolved,
        ...candidateWorld.unresolved,
        ...(targetMissing ? [`TARGET -> ${targetFqcn}`] : []),
        ...(executionBudgetExceeded ? ['BUDGET -> EXECUTION_OR_RSS'] : [])
      ].filter((v, i, arr) => arr.indexOf(v) === i).sort();

      // --- Confidence rationale ---
      const confidenceRationale: string[] = [];
      if (incomplete) {
        confidenceRationale.push('Snapshot resolution or resource budget is incomplete; result cannot be treated as preserved.');
      }
      if (impacts.some(i => i.classification === 'ADVISORY_ONLY_LIMIT')) {
        confidenceRationale.push('Some consumer impacts require body-level analysis (Phase J-5) for certainty; result is conservative.');
      }
      if (!incomplete && !impacts.some(i => i.classification === 'ADVISORY_ONLY_LIMIT')) {
        confidenceRationale.push('Structural static analysis of sealed parent/candidate Java sources was compared; no unresolved symbols.');
      }
      if (guardDemotedPreserved) {
        if (unsealedInterfaces.length > 0) {
          confidenceRationale.push(
            `Interface contract changed on ${unsealedInterfaces.length} type(s) with no implementor inside either sealed world; preservation cannot be proven from an open implementor set.`
          );
        }
        if (coverageGaps.length > 0) {
          confidenceRationale.push(
            `Type declarations changed in ${coverageGaps.length} file(s) at a nesting level the IR does not index; the provider diff is not authoritative there.`
          );
        }
        if (frameworkReachabilityGaps.length > 0) {
          confidenceRationale.push(
            `Framework-managed lifecycle member or XML/SPI descriptor detected for ${frameworkReachabilityGaps.length} provider(s); runtime invocation cannot be statically ruled out.`
          );
        }
      }

      // --- Attributed abstention codes ---
      // Per-impact attribution reads out of the already-fixed verdict and world state,
      // so an unattributed INCONCLUSIVE becomes falsifiable instead of changing
      // behaviour. The two guard codes are the exception: they name the reason a
      // `LIKELY_PRESERVED` was retracted.
      const derivedAbstentionCodes: JavaAdvisoryAbstentionCode[] = [];
      if (verdict === 'INCONCLUSIVE') {
        const codes = new Set<JavaAdvisoryAbstentionCode>(impactAbstentions);
        if (totalClasses === 0) codes.add('ABST_EMPTY_SNAPSHOT');
        if (executionBudgetExceeded) codes.add('ABST_BUDGET_EXCEEDED');
        if (targetMissing) codes.add('ABST_TARGET_MISSING');
        if (!candidateWorld.buildQualified || !parentWorld.buildQualified) codes.add('ABST_BUILD_INCOMPLETE');
        if (guardDemotedPreserved) {
          if (unsealedInterfaces.length > 0) codes.add('ABST_UNSEALED_IMPLEMENTOR_SET');
          if (coverageGaps.length > 0) codes.add('ABST_UNINDEXED_DECLARATION');
          if (frameworkReachabilityGaps.length > 0) codes.add('ABST_FRAMEWORK_REACHABLE');
        }
        if (frameworkReachableProviders.length > 0) {
          codes.add('ABST_FRAMEWORK_REACHABLE');
        }
        const worldUnresolved = parentWorld.unresolved.length > 0 || candidateWorld.unresolved.length > 0;
        const syntheticPrefixes = ['BUILD_MODEL_EXTRACTION_FAILURE', 'SNAPSHOT_BUILD_FAILURE', 'TARGET -> ', 'BUDGET -> '];
        if (unresolvedFiles.some(u => !syntheticPrefixes.some(p => u.startsWith(p)))) codes.add('ABST_SNAPSHOT_UNRESOLVED');
        for (const impact of impacts) {
          if (impact.classification === 'ADVISORY_ONLY_LIMIT') {
            codes.add(
              impact.referenceKind === 'STATIC_WILDCARD_IMPORT'
                ? 'ABST_STATIC_WILDCARD_IMPORT'
                : impact.referenceKind === 'WILDCARD_IMPORT'
                  ? 'ABST_WILDCARD_IMPORT'
                  : 'ABST_ADVISORY_ONLY_LIMIT'
            );
          } else if (impact.classification === 'UNRESOLVED' && !worldUnresolved) {
            // A world-level unresolved gate labels every impact UNRESOLVED; attributing
            // it per reference kind would report a coarse gate as a receiver failure.
            codes.add(
              impact.referenceKind === 'CALL_SITE' ||
                impact.referenceKind === 'METHOD_REFERENCE' ||
                impact.referenceKind === 'CONSTRUCTOR_REFERENCE'
                ? 'ABST_RECEIVER_UNRESOLVED'
                : 'ABST_UNRESOLVED_SYMBOL'
            );
          }
        }
        derivedAbstentionCodes.push(...[...codes].sort());
      }

      return {
        schemaVersion: ADVISORY_JAVA_SCHEMA_VERSION,
        certificationStatus: 'ADVISORY_ONLY',
        verdict,
        parentCommitSha: input.parent.commitSha,
        candidateCommitSha: input.candidate.commitSha,
        providers: providers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        consumers: uniqueConsumers,
        impacts: impacts.sort((a, b) =>
          (a.providerId !== b.providerId ? (a.providerId < b.providerId ? -1 : 1) : (a.consumerFqcn < b.consumerFqcn ? -1 : a.consumerFqcn > b.consumerFqcn ? 1 : 0))
        ),
        traces,
        completeness: {
          status: incomplete ? 'INCOMPLETE' : 'COMPLETE',
          consumersAnalyzed: uniqueConsumers.length,
          unresolvedDependencyCount: unresolvedFiles.length,
          unresolvedFiles,
          symbolResolutionQuality: (!candidateWorld.buildQualified || !parentWorld.buildQualified)
            ? 'NAMESPACE_FALLBACK'
            : 'FULL_BUILD_MODEL',
          selection: {
            parent: input.parent.selection ?? null,
            candidate: input.candidate.selection ?? null
          }
        },
        confidenceRationale,
        evidenceReferences: providers.map(p => p.id),
        abstentionCodes: derivedAbstentionCodes
      };
    } catch (error) {
      // Fail closed: ANALYSIS_ERROR is always ADVISORY_ONLY; never enters the certified pipeline
      return {
        schemaVersion: ADVISORY_JAVA_SCHEMA_VERSION,
        certificationStatus: 'ADVISORY_ONLY',
        verdict: 'ANALYSIS_ERROR',
        parentCommitSha: input?.parent?.commitSha ?? '',
        candidateCommitSha: input?.candidate?.commitSha ?? '',
        providers: [],
        consumers: [],
        impacts: [],
        traces: [],
        completeness: {
          status: 'INCOMPLETE',
          consumersAnalyzed: 0,
          unresolvedDependencyCount: 0,
          unresolvedFiles: [],
          selection: {
            parent: input?.parent?.selection ?? null,
            candidate: input?.candidate?.selection ?? null
          }
        },
        confidenceRationale: [error instanceof Error ? error.message : String(error)],
        evidenceReferences: [],
        abstentionCodes: []
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 7: Reconciliation for Java Advisory Findings (casebgoal.md §Phase 7)
// ---------------------------------------------------------------------------

export type JavaCertifiedVerdict = 'PRESERVED' | 'VIOLATED' | 'NOT_APPLICABLE' | 'UNKNOWN';

export interface JavaCertifiedOutcome {
  readonly verdict: JavaCertifiedVerdict;
  readonly reason: string;
  readonly evidenceReferences?: readonly string[];
}

export interface JavaReconciliationConflict {
  readonly certifiedVerdict: JavaCertifiedVerdict;
  readonly advisoryVerdict: JavaAdvisoryVerdict;
  readonly reason: string;
}

export interface JavaReconciledImpactResult {
  readonly certified: JavaCertifiedOutcome;
  readonly advisory: JavaAdvisoryImpactResult;
  readonly final: {
    readonly certificationStatus: 'CERTIFIED';
    readonly verdict: JavaCertifiedVerdict;
    readonly advisoryFinding: JavaAdvisoryVerdict | null;
    readonly conflict: JavaReconciliationConflict | null;
  };
}

const conflicts = (certified: JavaCertifiedVerdict, advisory: JavaAdvisoryVerdict): boolean =>
  (certified === 'PRESERVED' && advisory === 'LIKELY_VIOLATED') ||
  (certified === 'VIOLATED' && advisory === 'LIKELY_PRESERVED');

/**
 * Phase 7 Reconciliation policy for Java advisory results.
 * Strictly enforces:
 *  1. Certified VIOLATED -> final certified VIOLATED.
 *  2. Certified PRESERVED -> final certified PRESERVED.
 *  3. Certified NOT_APPLICABLE -> final certified NOT_APPLICABLE.
 *  4. Certified UNKNOWN + advisory result -> certified UNKNOWN, plus advisory finding.
 *  5. Conflicting results -> certified UNKNOWN, conflict report.
 *
 * Advisory evidence NEVER upgrades UNKNOWN to certified PRESERVED or VIOLATED,
 * and NEVER bypasses VerdictAuthority gates.
 */
export function reconcileJavaAdvisoryResult(
  certified: JavaCertifiedOutcome,
  advisory: JavaAdvisoryImpactResult
): JavaReconciledImpactResult {
  if (conflicts(certified.verdict, advisory.verdict)) {
    return {
      certified,
      advisory,
      final: {
        certificationStatus: 'CERTIFIED',
        verdict: 'UNKNOWN',
        advisoryFinding: advisory.verdict,
        conflict: {
          certifiedVerdict: certified.verdict,
          advisoryVerdict: advisory.verdict,
          reason: 'Certified and Java advisory conclusions conflict; final certified result fails closed to UNKNOWN.'
        }
      }
    };
  }
  if (certified.verdict === 'UNKNOWN') {
    return {
      certified,
      advisory,
      final: {
        certificationStatus: 'CERTIFIED',
        verdict: 'UNKNOWN',
        advisoryFinding: advisory.verdict,
        conflict: null
      }
    };
  }
  return {
    certified,
    advisory,
    final: {
      certificationStatus: 'CERTIFIED',
      verdict: certified.verdict,
      advisoryFinding: advisory.verdict,
      conflict: null
    }
  };
}

// ---------------------------------------------------------------------------
// Phase 8: Dual-Panel Report & Markdown Rendering (casebgoal.md §Phase 8)
// ---------------------------------------------------------------------------

export interface JavaAdvisoryReport {
  readonly schemaVersion: 'ADVISORY_JAVA_REPORT_V1';
  readonly certifiedPanel: {
    readonly verdict: JavaCertifiedVerdict;
    readonly reason: string;
    readonly conflict: JavaReconciliationConflict | null;
  };
  readonly broaderImpactPanel: {
    readonly verdict: JavaAdvisoryVerdict;
    readonly confidence: 'HIGH' | 'LIMITED';
    readonly consumersAffected: number;
    readonly consumersAnalyzed: number;
    readonly unresolvedDependencies: number;
  };
  readonly evidence: {
    readonly parentCommitSha: string;
    readonly candidateCommitSha: string;
    readonly language: 'java';
    readonly providers: readonly JavaProviderDeclaration[];
    readonly traces: readonly JavaAdvisoryImpactTrace[];
    readonly unresolvedDependencies: readonly string[];
    readonly confidenceRationale: readonly string[];
    readonly selection: JavaAdvisoryImpactResult['completeness']['selection'];
  };
}

export function createJavaAdvisoryReport(result: JavaReconciledImpactResult): JavaAdvisoryReport {
  const advisory = result.advisory;
  const consumersAffected = advisory.impacts.filter(i => i.classification === 'LIKELY_BROKEN').length;
  return {
    schemaVersion: 'ADVISORY_JAVA_REPORT_V1',
    certifiedPanel: {
      verdict: result.final.verdict,
      reason: result.final.conflict?.reason ?? result.certified.reason,
      conflict: result.final.conflict
    },
    broaderImpactPanel: {
      verdict: advisory.verdict,
      confidence: advisory.completeness.status === 'COMPLETE' ? 'HIGH' : 'LIMITED',
      consumersAffected,
      consumersAnalyzed: advisory.completeness.consumersAnalyzed,
      unresolvedDependencies: advisory.completeness.unresolvedDependencyCount
    },
    evidence: {
      parentCommitSha: advisory.parentCommitSha,
      candidateCommitSha: advisory.candidateCommitSha,
      language: 'java',
      providers: advisory.providers,
      traces: advisory.traces,
      unresolvedDependencies: advisory.completeness.unresolvedFiles,
      confidenceRationale: advisory.confidenceRationale,
      selection: advisory.completeness.selection
    }
  };
}

export function renderJavaAdvisoryMarkdown(report: JavaAdvisoryReport): string {
  const lines: string[] = [
    '## Certified result',
    '',
    `Certified verdict: ${report.certifiedPanel.verdict}`,
    `Reason: ${report.certifiedPanel.reason}`,
    '',
    '## Broader impact analysis (Java)',
    '',
    `Advisory result: ${report.broaderImpactPanel.verdict}`,
    `Confidence: ${report.broaderImpactPanel.confidence}`,
    `Consumers affected: ${report.broaderImpactPanel.consumersAffected}`,
    `Consumers analyzed: ${report.broaderImpactPanel.consumersAnalyzed}`,
    `Unresolved dependencies: ${report.broaderImpactPanel.unresolvedDependencies}`
  ];

  if (report.evidence.traces.length > 0) {
    lines.push('', '### Evidence Traces');
    for (const trace of report.evidence.traces) {
      lines.push('', `#### Provider: ${trace.providerId} (${trace.classification})`);
      for (const step of trace.steps) {
        const spanStr = step.span ? `:${step.span.line}` : '';
        lines.push(`- ${step.kind}: ${step.file}${spanStr} — ${step.detail}`);
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Phase 9: Java Advisory Validation Benchmark (casebgoal.md §Phase 9)
// ---------------------------------------------------------------------------

export interface JavaAdvisoryBenchmarkCase {
  readonly name: string;
  readonly input: JavaAdvisoryInput;
  readonly expectedVerdict: JavaAdvisoryVerdict;
  readonly expectedConsumerCount?: number;
  readonly tags: readonly string[];
}

export interface JavaAdvisoryBenchmarkCaseResult {
  readonly name: string;
  readonly tags: readonly string[];
  readonly expectedVerdict: JavaAdvisoryVerdict;
  readonly actualVerdict: JavaAdvisoryVerdict;
  readonly expectedConsumerCount: number | null;
  readonly actualConsumerCount: number;
  readonly deterministic: boolean;
  readonly elapsedMs: number;
  readonly rssDeltaBytes: number;
}

export interface JavaAdvisoryBenchmarkReport {
  readonly schemaVersion: 'ADVISORY_JAVA_BENCHMARK_V1';
  readonly cases: readonly JavaAdvisoryBenchmarkCaseResult[];
  readonly metrics: {
    readonly consumerDiscoveryRecall: number | null;
    readonly truePositiveRate: number | null;
    readonly falsePositiveRate: number | null;
    readonly falseNegativeRate: number | null;
    readonly unresolvedRate: number;
    readonly deterministicRepeatability: number;
    readonly runtimeMs: number;
    readonly peakRssDeltaBytes: number;
  };
}

export function runJavaAdvisoryBenchmark(
  cases: readonly JavaAdvisoryBenchmarkCase[],
  analyzer = new AdvisoryJavaImpactAnalyzer()
): JavaAdvisoryBenchmarkReport {
  const results = cases
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(testCase => {
      const rssBefore = process.memoryUsage().rss;
      const started = performance.now();
      const first = analyzer.analyze(testCase.input);
      const elapsedMs = performance.now() - started;
      const second = analyzer.analyze(testCase.input);
      const deterministic = JSON.stringify(first) === JSON.stringify(second);
      return {
        name: testCase.name,
        tags: [...testCase.tags].sort(),
        expectedVerdict: testCase.expectedVerdict,
        actualVerdict: first.verdict,
        expectedConsumerCount: testCase.expectedConsumerCount ?? null,
        actualConsumerCount: first.consumers.length,
        deterministic,
        elapsedMs,
        rssDeltaBytes: Math.max(0, process.memoryUsage().rss - rssBefore)
      };
    });

  const expectedConsumers = results
    .filter(r => r.expectedConsumerCount !== null)
    .reduce((n, r) => n + r.expectedConsumerCount!, 0);
  const discoveredConsumers = results
    .filter(r => r.expectedConsumerCount !== null)
    .reduce((n, r) => n + Math.min(r.actualConsumerCount, r.expectedConsumerCount!), 0);

  const positives = results.filter(r => r.expectedVerdict === 'LIKELY_VIOLATED');
  const actualPositives = results.filter(r => r.actualVerdict === 'LIKELY_VIOLATED');
  const tp = positives.filter(r => r.actualVerdict === 'LIKELY_VIOLATED').length;
  const fp = actualPositives.filter(r => r.expectedVerdict !== 'LIKELY_VIOLATED').length;

  return {
    schemaVersion: 'ADVISORY_JAVA_BENCHMARK_V1',
    cases: results,
    metrics: {
      consumerDiscoveryRecall: expectedConsumers ? discoveredConsumers / expectedConsumers : null,
      truePositiveRate: positives.length ? tp / positives.length : null,
      falsePositiveRate: actualPositives.length ? fp / actualPositives.length : null,
      falseNegativeRate: positives.length ? (positives.length - tp) / positives.length : null,
      unresolvedRate: results.length ? results.filter(r => r.actualVerdict === 'INCONCLUSIVE').length / results.length : 0,
      deterministicRepeatability: results.length ? results.filter(r => r.deterministic).length / results.length : 1,
      runtimeMs: results.reduce((n, r) => n + r.elapsedMs, 0),
      peakRssDeltaBytes: Math.max(0, ...results.map(r => r.rssDeltaBytes))
    }
  };
}

// ---------------------------------------------------------------------------
// Real Git Commit Ingestion: JavaRepositoryRevisionAnalyzer
// ---------------------------------------------------------------------------

export interface JavaRepositoryRevisionInput {
  readonly repositoryPath: string;
  readonly parentSha: string;
  readonly candidateSha: string;
  readonly target?: JavaTargetDeclaration;
  readonly resourceLimits?: {
    readonly maxSelectedFiles?: number;
    readonly maxSelectedBytes?: number;
    readonly maxScanFiles?: number;
    readonly maxScanBytes?: number;
    readonly maxExecutionMs?: number;
    readonly maxRssBytes?: number;
  };
}

export interface JavaSealedRevisionPair {
  readonly repositoryId: string;
  readonly parentCommitSha: string;
  readonly candidateCommitSha: string;
  readonly parent: JavaSealedRevision;
  readonly candidate: JavaSealedRevision;
}

interface JavaGitLimits {
  readonly maxSelectedFiles: number;
  readonly maxSelectedBytes: number;
  readonly maxScanFiles: number;
  readonly maxScanBytes: number;
  readonly maxExecutionMs: number;
  readonly maxRssBytes: number;
}

const defaultGitLimits: JavaGitLimits = Object.freeze({
  maxSelectedFiles: 512,
  maxSelectedBytes: 32 * 1024 * 1024,
  maxScanFiles: 20_000,
  maxScanBytes: 64 * 1024 * 1024,
  maxExecutionMs: 30_000,
  maxRssBytes: 1024 * 1024 * 1024
});

/**
 * Production bridge for real Git repositories.
 * Materializes sealed in-memory snapshots directly from Git blob objects at parent and
 * candidate commit SHAs, then executes sealed advisory Java impact analysis.
 */
export class JavaRepositoryRevisionAnalyzer {
  public validate(input: JavaRepositoryRevisionInput): {
    readonly repositoryId: string;
    readonly parentCommitSha: string;
    readonly candidateCommitSha: string;
  } {
    const repository = new GitRepository(input.repositoryPath);
    repository.validate();
    const commit = (sha: string) => repository.text(['rev-parse', '--verify', `${sha}^{commit}`]).trim();
    return {
      repositoryId: repository.repositoryId(),
      parentCommitSha: commit(input.parentSha),
      candidateCommitSha: commit(input.candidateSha)
    };
  }

  public materialize(input: JavaRepositoryRevisionInput): JavaSealedRevisionPair {
    const { repositoryId, parentCommitSha, candidateCommitSha } = this.validate(input);
    const repository = new GitRepository(input.repositoryPath);
    const objects = new GitObjectReader(repository);
    const limits = { ...defaultGitLimits, ...input.resourceLimits };

    const parent = this.selectRevision(objects, parentCommitSha, limits);
    const candidate = this.selectRevision(objects, candidateCommitSha, limits);

    return {
      repositoryId,
      parentCommitSha,
      candidateCommitSha,
      parent,
      candidate
    };
  }

  public analyze(input: JavaRepositoryRevisionInput): JavaAdvisoryImpactResult {
    const pair = this.materialize(input);
    const limits = { ...defaultGitLimits, ...input.resourceLimits };
    const analyzer = new AdvisoryJavaImpactAnalyzer();
    return analyzer.analyze({
      parent: pair.parent,
      candidate: pair.candidate,
      target: input.target,
      resourceLimits: {
        maxExecutionMs: limits.maxExecutionMs,
        maxRssBytes: limits.maxRssBytes
      }
    });
  }

  private selectRevision(
    objects: GitObjectReader,
    commitSha: string,
    limits: JavaGitLimits
  ): JavaSealedRevision {
    const isJava = (p: string) => p.endsWith('.java');
    const isBuild = (p: string) =>
      p.endsWith('pom.xml') ||
      p.endsWith('build.gradle') ||
      p.endsWith('build.gradle.kts') ||
      p.endsWith('settings.gradle') ||
      p.endsWith('settings.gradle.kts');
    const isRelevant = (p: string) => isJava(p) || isBuild(p);

    const allEntries = objects.entries(commitSha).filter(e => e.type === 'blob');
    const relevantEntries = allEntries.filter(e => isRelevant(e.path));
    const reasons: string[] = [];

    const files: Record<string, string> = {};
    let selectedBytes = 0;
    let selectedCount = 0;

    for (const entry of relevantEntries) {
      if (selectedCount >= limits.maxSelectedFiles || selectedBytes > limits.maxSelectedBytes) {
        reasons.push('BUDGET -> SELECTED_FILES_OR_BYTES');
        break;
      }
      const text = objects.blob(entry.objectId).toString('utf8');
      const normPath = slash(entry.path);
      files[normPath] = text;
      selectedBytes += Buffer.byteLength(text, 'utf8');
      selectedCount++;
    }

    return {
      commitSha,
      files,
      selection: {
        selectedFiles: selectedCount,
        selectedBytes,
        scannedFiles: relevantEntries.length,
        scannedBytes: selectedBytes,
        incompleteReasons: reasons
      }
    };
  }
}


