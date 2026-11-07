import { RelationKind } from './relation';

export type Phase4BlockerId =
  // Unsupported TypeScript constructs
  | 'CONDITIONAL_TYPE_NOT_REDUCIBLE'
  | 'MAPPED_TYPE_OPEN_KEY_SPACE'
  | 'INDEXED_ACCESS_KEY_UNKNOWN'
  | 'TEMPLATE_LITERAL_OPEN_PATTERN'
  | 'TYPE_IR_BUDGET_EXCEEDED'
  | 'INFER_CAPTURE_NOT_SUPPORTED'
  | 'CONDITIONAL_DISTRIBUTIVITY_UNDECIDABLE'
  | 'NAMESPACE_MERGE_UNDECIDABLE'
  | 'DECLARATION_MERGE_UNDECIDABLE'
  | 'TYPE_IR_EXTRACTION_UNSUPPORTED'
  | 'INTERSECTION_EXPANSION_UNSUPPORTED'
  // Incomplete compiler information
  | 'CHECKER_TYPE_ERROR'
  | 'OVERLOAD_SELECTION_UNAVAILABLE'
  | 'GENERIC_BINDING_UNAVAILABLE'
  | 'CONTEXTUAL_TYPE_UNAVAILABLE'
  | 'SOURCE_FILE_MISSING'
  | 'CONSUMER_HAS_COMPILE_ERROR'
  // Unresolved symbols
  | 'CONSUMER_SYMBOL_UNRESOLVED'
  | 'DECLARATION_TYPE_UNAVAILABLE'
  | 'IMPORT_RESOLUTION_FAILED'
  | 'CROSS_PROJECT_DECLARATION_UNAVAILABLE'
  // Missing declarations / identity
  | 'TARGET_DECLARATION_REMOVED'
  | 'CONSUMER_BINDING_REMOVED'
  | 'CANDIDATE_DECLARATION_MISSING'
  | 'IDENTITY_UNCERTAIN'
  // any Dependency
  | 'ANY_DEPENDENCY_SOURCE'
  | 'ANY_DEPENDENCY_TARGET'
  | 'ANY_DEPENDENCY_RETURN'
  | 'ANY_DEPENDENCY_BOTH'
  // Historical reconstruction failures
  | 'HISTORICAL_EXPECTATION_UNRECOVERABLE'
  | 'RETURN_OBLIGATION_REQUIRES_DOWNSTREAM_ANALYSIS'
  | 'RETURN_OBLIGATION_UNDETERMINED'
  | 'POLYMORPHIC_FUNCTION_REFERENCE_UNSUPPORTED'
  | 'OMITTED_HISTORICAL_CONSUMER'
  | 'EXCLUDED_SITE_IDENTITY_UNVERIFIED'
  | 'HISTORICAL_USAGE_SPECIALIZATION_INCOMPLETE'
  // Structural typing
  | 'NOMINAL_MEMBER_ORIGIN_UNVERIFIABLE'
  | 'FRESHNESS_STATUS_UNVERIFIABLE'
  | 'UNGUARDED_RECURSIVE_CYCLE'
  | 'VACUOUS_RECURSIVE_CYCLE'
  | 'PRIVATE_MEMBER_ORIGIN_MISMATCH'
  | 'EXCESS_PROPERTY_REJECTED'
  | 'REQUIRED_PROPERTY_MISSING'
  // Configuration and compiler
  | 'CONFIGURATION_CHANGE_UNSUPPORTED'
  | 'COMPILER_VERSION_UNSUPPORTED'
  // Other runtime & budget limits
  | 'CONSUMER_AST_UNRESOLVABLE'
  | 'CHECKER_RUNTIME_FAILURE'
  | 'CONSUMER_IDENTITY_AMBIGUOUS'
  | 'AMBIENT_TYPE_RELATION_UNSUPPORTED'
  | 'WORK_BUDGET_EXCEEDED'
  | 'DEPTH_BUDGET_EXCEEDED'
  | 'TYPE_POSITION_VARIANCE_UNDECIDABLE'
  | 'CALLBACK_VARIANCE_UNSUPPORTED'
  | 'INFERENCE_CHAIN_DEPTH_EXCEEDED'
  | 'UNSUPPORTED_TYPE_RELATION'
  | 'INVALID_PROOF_TREE'
  | 'COMPILER_API_FAILURE'
  | 'PHASE4_PREREQUISITES_UNAVAILABLE'
  | 'PHASE4_COVERAGE_GAP'
  | 'UNSUPPORTED_CALLABILITY'
  | 'UNSUPPORTED_TYPE_CONSTRUCT'
  | 'DOWNSTREAM_RETURN_OBLIGATION_UNPROVEN';

export interface WitnessLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

export type WitnessPosition =
  | { readonly kind: 'PARAMETER'; readonly index: number; readonly name?: string }
  | { readonly kind: 'RETURN' }
  | { readonly kind: 'PROPERTY'; readonly name: string }
  | { readonly kind: 'TYPE_ARGUMENT'; readonly index: number; readonly name?: string }
  | { readonly kind: 'TUPLE_ELEMENT'; readonly index: number }
  | { readonly kind: 'ROOT' };

export interface TypeDisplay {
  readonly display: string;
  readonly irContentHash?: string;
}

export interface IncompatibilityWitness {
  readonly witnessId: string;
  readonly consumerLocation: WitnessLocation;
  readonly targetDeclaration: WitnessLocation;
  readonly semanticRelation: RelationKind;
  readonly position: WitnessPosition;
  readonly parentType: TypeDisplay;
  readonly candidateType: TypeDisplay;
  readonly failedRelation: string;
  readonly evidenceChain: ReadonlyArray<string>;
  readonly ruleId?: string;
}

export interface RelationBlocker {
  readonly blockerId: Phase4BlockerId;
  readonly consumerLocation?: WitnessLocation;
  readonly ruleAttempted?: string;
  readonly sourceIRContentHash?: string;
  readonly targetIRContentHash?: string;
  readonly snapshot: 'PARENT' | 'CANDIDATE';
  readonly detail: string;
}
