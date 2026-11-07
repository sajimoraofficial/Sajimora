import { UsageRole } from './usage';

export type RelationKind =
  | 'ASSIGNABLE_TO'
  | 'IDENTICAL_TO'
  | 'PARAMETER_ACCEPTS_ARGUMENT'
  | 'RETURN_SATISFIES_CONTEXT'
  | 'CALLBACK_PARAMETER_SAFE'
  | 'CALLBACK_RETURN_SAFE'
  | 'PROPERTY_READ_SAFE'
  | 'PROPERTY_WRITE_SAFE'
  | 'TYPE_ARGUMENT_SATISFIES_CONSTRAINT'
  | 'ARITY_SATISFIED'
  | 'OVERLOAD_SELECTION_VALID'
  | 'STRUCTURAL_PROPERTY_COMPATIBLE'
  | 'INDEX_SIGNATURE_COMPATIBLE'
  | 'CALLABLE_SIGNATURE_COMPATIBLE'
  | 'CONSTRUCT_SIGNATURE_COMPATIBLE'
  | 'MEMBER_ORIGIN_VERIFIED'
  | 'POLYMORPHIC_FUNCTION_ASSIGNABLE';

export type RelationStatus = 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNDECIDABLE';

export interface VarianceFrame {
  readonly level: number;
  readonly position: 'PARAMETER' | 'RETURN' | 'PROPERTY_READ' | 'PROPERTY_WRITE' | 'TYPE_ARGUMENT';
  readonly localVariance: 'COVARIANT' | 'CONTRAVARIANT' | 'INVARIANT';
  readonly composedVariance: 'COVARIANT' | 'CONTRAVARIANT' | 'INVARIANT';
  readonly declarationSyntax: 'METHOD' | 'PROPERTY_FUNCTION' | 'ARROW' | 'FUNCTION_TYPE';
  readonly isActualCallSiteArgument: boolean;
}

export interface LanguageContractIR<TTypeIR> {
  readonly schemaVersion: 'SAJIMORA_LANGUAGE_CONTRACT_V1';
  readonly languageId: string;
  readonly symbolId: string;
  readonly qualifiedName: string;
  readonly declarationKind:
    | 'FUNCTION'
    | 'METHOD'
    | 'CLASS'
    | 'INTERFACE'
    | 'VARIABLE'
    | 'TYPE_ALIAS'
    | 'ENUM'
    | 'MODULE'
    | 'FIELD'
    | 'CONSTRUCTOR'
    | 'RECORD';
  readonly contractType: TTypeIR;
  readonly memberContracts?: ReadonlyArray<[string, LanguageContractIR<TTypeIR>]>;
  readonly contractHash: string;
}

export interface ArgumentSpecializationContext<TTypeIR> {
  readonly position: number;
  readonly type: TTypeIR;
  readonly isFreshLiteral: boolean;
  readonly argumentName?: string;
}

export interface GenericTypeArgumentContext<TTypeIR> {
  readonly position: number;
  readonly type: TTypeIR;
  readonly provenance: 'EXPLICIT' | 'INFERRED' | 'DEFAULT';
  readonly typeParameterName?: string;
}

export interface SpecializedUsageContract<TTypeIR> {
  readonly schemaVersion: 'SAJIMORA_USAGE_CONTRACT_V1';
  readonly languageId: string;
  readonly usageRole: UsageRole;
  readonly expectedType: TTypeIR;
  readonly arguments?: ReadonlyArray<ArgumentSpecializationContext<TTypeIR>>;
  readonly genericTypeArguments?: ReadonlyArray<GenericTypeArgumentContext<TTypeIR>>;
  readonly receiverRequirementType?: TTypeIR;
  readonly predicateOrAssertionRequirement?: unknown;
  readonly isDiscardedReturn: boolean;
  readonly hasCompleteSpecializationEvidence: boolean;
  readonly hasDownstreamInferredUses?: boolean;
  readonly hasDownstreamWrites?: boolean;
  readonly downstreamWrittenProperties?: ReadonlyArray<string>;
  readonly parentPredicate?: any;
  readonly usageHash: string;
}

export interface RelationPolicy {
  readonly languageId: string;
  readonly flags: ReadonlyArray<[string, 'boolean' | 'string' | 'number', boolean | string | number]>;
}

export interface ExtractionOptions {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

export interface ExtractionResult<TTypeIR> {
  readonly success: boolean;
  readonly typeIR?: TTypeIR;
  readonly blockerId?: string;
  readonly errorDetail?: string;
}

export interface SpecializationResult<TTypeIR> {
  readonly success: boolean;
  readonly specializedContract?: SpecializedUsageContract<TTypeIR>;
  readonly blockerId?: string;
  readonly errorDetail?: string;
}

export interface RelationContext {
  readonly workBudget: number;
  readonly depth: number;
  readonly visitedPairs: Set<string>;
  readonly varianceStack: ReadonlyArray<VarianceFrame>;
  readonly effectivePolicy: Record<string, unknown>;
  readonly hypothesisStack?: ReadonlyArray<string>;
  readonly structuralGuardDepth?: number;
}

export interface RuleExecutionResult<TTypeIR> {
  readonly status: RelationStatus;
  readonly ruleId: string;
  readonly premises: ReadonlyArray<{ premiseId: string; description: string; verified: boolean }>;
  readonly dischargedObligations: ReadonlyArray<string>;
  readonly subRelations?: ReadonlyArray<{
    readonly source: TTypeIR;
    readonly target: TTypeIR;
    readonly relation: RelationKind;
    readonly policy: unknown;
    readonly context: RelationContext;
  }>;
  readonly aggregationMode?: 'UNIVERSAL_CONJUNCTION' | 'EXISTENTIAL_DISJUNCTION';
  readonly witness?: unknown;
  readonly blockers?: ReadonlyArray<unknown>;
  readonly anyDependency?: boolean;
}

export interface RelationEngineDriver<TTypeIR, TPolicy> {
  evaluateSubRelation(
    source: TTypeIR,
    target: TTypeIR,
    relation: RelationKind,
    policy: TPolicy,
    context: RelationContext
  ): unknown;
  consumeWorkBudget(units: number): void;
}

export interface LanguageSemanticRule<TTypeIR, TPolicy> {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  matches(source: TTypeIR, target: TTypeIR, relation: RelationKind, policy: TPolicy): boolean;
  evaluate(
    source: TTypeIR,
    target: TTypeIR,
    relation: RelationKind,
    policy: TPolicy,
    driver: RelationEngineDriver<TTypeIR, TPolicy>,
    context: RelationContext
  ): RuleExecutionResult<TTypeIR>;
}

export interface LanguageSemanticRuleSet<TTypeIR, TPolicy> {
  readonly rules: ReadonlyArray<LanguageSemanticRule<TTypeIR, TPolicy>>;
  selectRule(
    source: TTypeIR,
    target: TTypeIR,
    relation: RelationKind,
    policy: TPolicy
  ): LanguageSemanticRule<TTypeIR, TPolicy> | null;
}

export interface LanguageAdapter<TTypeIR, TPolicy, TSnapshot = unknown, TASTNode = unknown> {
  readonly languageId: string;
  readonly schemaVersion: string;

  extractTypeIR(node: TASTNode, snapshot: TSnapshot, options?: ExtractionOptions): ExtractionResult<TTypeIR>;
  extractContract(declarationNode: TASTNode, snapshot: TSnapshot): LanguageContractIR<TTypeIR>;
  extractUsageContract(usageNode: TASTNode, snapshot: TSnapshot): SpecializedUsageContract<TTypeIR>;

  readonly semanticRules: LanguageSemanticRuleSet<TTypeIR, TPolicy>;

  specializeUsage(
    historicalUsage: SpecializedUsageContract<TTypeIR>,
    candidateDeclaration: LanguageContractIR<TTypeIR>,
    policy: TPolicy
  ): SpecializationResult<TTypeIR>;

  hashTypeIR(typeIR: TTypeIR): string;
  hashPolicy(policy: TPolicy): string;
}

export const HASH_SCHEMA_VERSION = 'V1';

export type CanonicalHashDomain =
  | 'TYPE_IR'
  | 'CONTRACT_IR'
  | 'USAGE_CONTRACT'
  | 'POLICY'
  | 'PROOF_NODE'
  | 'CYCLE_KEY'
  | 'WITNESS'
  | 'EVIDENCE';

export function binaryCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number in canonicalJson');
    return Object.is(value, -0) ? '0' : value.toString();
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object).sort(binaryCompare);
    const entries: string[] = [];
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) {
        entries.push(JSON.stringify(k) + ':' + canonicalJson(v));
      }
    }
    return '{' + entries.join(',') + '}';
  }
  throw new Error(`Unsupported value type in canonicalJson: ${typeof value}`);
}
