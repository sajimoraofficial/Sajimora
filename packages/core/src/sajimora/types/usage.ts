import { SymbolRef } from './symbol';
import { IdentityResolution } from './identity';
import { EnumerationInconsistencyCause } from './binding';

export type SemanticRole = 'VALUE' | 'TYPE' | 'UNDECIDABLE';

export type ReferenceExpressionContext =
  | 'ARGUMENT'
  | 'RETURN'
  | 'ARRAY_ELEMENT'
  | 'OBJECT_PROPERTY'
  | 'CONDITIONAL'
  | 'DESTRUCTURING'
  | 'DEFAULT_PARAMETER'
  | 'CALLBACK'
  | 'TYPEOF'
  | 'VOID'
  | 'SPREAD'
  | 'JSX_EXPRESSION'
  | 'TAGGED_TEMPLATE'
  | 'OPTIONAL_CALL'
  | 'HIGHER_ORDER'
  | 'OTHER_EXPRESSION';

export type UsageRole =
  | 'CALL_SITE'
  | 'VALUE_ASSIGNMENT'
  | 'RETURN_VALUE'
  | 'TYPE_ANNOTATION'
  | 'GENERIC_ARGUMENT'
  | 'INTERFACE_IMPLEMENTATION'
  | 'METHOD_OVERRIDE'
  | 'INHERITANCE'
  | 'RE_EXPORTER'
  | 'METHOD_REFERENCE'
  | 'CONSTRUCTOR_REFERENCE'
  | 'JSX_ELEMENT'
  | 'JSX_ATTRIBUTE_VALUE'
  | 'JSX_CHILD_EXPRESSION'
  | 'AMBIENT_AUGMENTATION'
  | 'REFERENCE_OCCURRENCE';

export type ResolutionStatus =
  | 'RESOLVED'
  | 'AMBIGUOUS'
  | 'UNRESOLVED'
  | 'CYCLIC'
  | 'UNDECIDABLE';

export interface ProvenanceHop {
  hopKind:
    | 'DIRECT_IMPORT'
    | 'ALIAS_RESOLUTION'
    | 'RE_EXPORT'
    | 'INHERITANCE'
    | 'NAMESPACE_ACCESS'
    | 'PATH_ALIAS_MAPPING'
    | 'PACKAGE_EXPORT_MAPPING';
  fromModuleIdentity: string;
  fromSpan: { line: number; column: number };
  toModuleIdentity: string;
  toSpan: { line: number; column: number };
  symbolName: string;
}

export interface DeclarationAnchor {
  moduleIdentity: string;
  symbolLocalName: string;
  kind: string;
  parameterTypeFingerprint: string;
  declarationOrdinal: number;
  syntaxKind: number;
}

export interface CanonicalReferenceOccurrence {
  occurrenceId: string;
  sourceFile: string;
  consumerFile?: string; // backwards compatibility
  sourceSpan: { start: number; end: number; line: number; column: number };
  location?: { line: number; column: number }; // backwards compatibility
  syntaxKind: number;
  semanticRole: SemanticRole;
  usageRole: UsageRole;
  referenceContext?: ReferenceExpressionContext | null; // backwards compatibility

  referencedSymbol: string;
  declarationSymbol: string;
  signatureAnchor?: string;

  resolutionStatus: ResolutionStatus;
  enumerationStatus: 'COMPLETE' | 'INCOMPLETE' | 'FAILED';

  provenance: ProvenanceHop[];
}

export interface UsageSite {
  usageSiteId: string;
  canonicalOccurrence: CanonicalReferenceOccurrence;
  deletionProof?: CandidateDeletionProof;
  
  existenceAtParent: 'PRESENT' | 'ABSENT';
  mutationStatus: 'UNCHANGED' | 'CHANGED' | 'REMOVED';
  bindingPresenceAtCandidate: 'PRESENT' | 'ABSENT';
  bindingState: 'BOUND' | 'WAS_BOUND_NOW_ABSENT' | 'NEVER_BOUND';

  evaluationStatus:
    | 'EVALUABLE'
    | 'EXCLUDED_REMOVED_VIA_BINDING'
    | 'EXCLUDED_RE_EXPORTER'
    | 'UNCERTAIN_IDENTITY'
    | 'ENUMERATION_INCONSISTENCY';

  identityResult: IdentityResolution | null;
  enumerationInconsistencyCause: EnumerationInconsistencyCause | null;
  provenance: 'UNCHANGED' | 'CHANGED_SAME_COMMIT' | 'REMOVED_SAME_COMMIT_VIA_BINDING' | 'RE_EXPORTED';
}

export interface CandidateDeletionProof {
  status: 'PROVEN_ABSENT' | 'IDENTITY_UNPROVEN' | 'AMBIGUOUS';
  evidenceId: string;
  proofHash: string;
  occurrenceId: string;
  persistentSymbolId: string;
  declarationId: string;
  sourceFile: string;
  sourceSpan: CanonicalReferenceOccurrence['sourceSpan'];
  parentBinding: string | null;
  candidateBindingTargets: string[];
  plausibleCandidateDeclarations: string[];
  aliasChain: ProvenanceHop[];
  candidateAliasChain: string[];
  closureProvenance: string[];
  deduplicationKey: string;
  candidateUniverseComplete: boolean;
  candidateUniverseFingerprint: string;
  blockers: string[];
}
