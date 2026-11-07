import { SymbolRef } from './symbol';

export type TypeScriptBindingKind = 
  | 'TS-1:NAMED_IMPORT'
  | 'TS-2:DEFAULT_IMPORT'
  | 'TS-3:NAMESPACE_IMPORT'
  | 'TS-4:TYPE_ONLY_NAMED_IMPORT'
  | 'TS-5:TYPE_ONLY_DEFAULT_IMPORT'
  | 'TS-6:NAMED_RE_EXPORT'
  | 'TS-7:ALIASED_RE_EXPORT'
  | 'TS-8:STAR_RE_EXPORT'
  | 'TS-9:STAR_RE_EXPORT_ALIAS'
  | 'TS-10:CJS_REQUIRE'
  | 'TS-11:CJS_DESTRUCTURE'
  | 'TS-12:LOCAL_DECLARATION'
  | 'TS-13:QUALIFIED_NAMESPACE_MEMBER'
  | 'TS-14:STRING_LITERAL_COMPUTED_MEMBER'
  | 'TS-15:CLASS_INHERITANCE'
  | 'TS-16:INTERFACE_INHERITANCE'
  | 'TS-17:EXPLICIT_IMPLEMENTS'
  | 'TS-18:DESTRUCTURED_NAMED_IMPORT'
  | 'TS-19:CJS_EXPORT_ASSIGNMENT';

export type JavaBindingKind = 
  | 'J-1:SINGLE_TYPE_IMPORT'
  | 'J-2:WILDCARD_IMPORT'
  | 'J-3:STATIC_SINGLE_IMPORT'
  | 'J-4:STATIC_WILDCARD_IMPORT'
  | 'J-5:QUALIFIED_TYPE_ACCESS'
  | 'J-6:LOCAL_DECLARATION'
  | 'J-7:CLASS_INHERITANCE'
  | 'J-8:INTERFACE_IMPLEMENTATION'
  | 'J-9:INTERFACE_INHERITANCE'
  | 'J-10:METHOD_REFERENCE'
  | 'J-11:CONSTRUCTOR_REFERENCE'
  | 'J-12:ANONYMOUS_CLASS';

export type SupportedBindingKind = TypeScriptBindingKind | JavaBindingKind;

export interface SupportedBindingForm {
  type: 'SUPPORTED';
  sourceModule: string;
  exportedSymbolName: string;
  localAlias: string;
  resolvedSymbol: SymbolRef;
  bindingKind: SupportedBindingKind;
}

export interface UnrecognizedBindingForm {
  type?: 'UNRECOGNIZED';
  description?: string;
  rawSyntaxContext?: string;
  sourceFile?: string;
  sourceSpan?: { start: number; end: number; line: number; column: number };
  syntaxKind?: number;
  attemptedClassification?: string;
  cause?: 'UNSUPPORTED_AST_FORM' | 'AMBIGUOUS_CLASSIFICATION' | 'CHECKER_FAILURE';
  encounteredInClosures?: string[];
  isTargetRelevant?: boolean;
}

export type ExplicitlyUndecidableReason = 
  | 'TS-X1:DYNAMIC_IMPORT'
  | 'TS-X2:NON_LITERAL_COMPUTED_MEMBER'
  | 'TS-X3:EVAL_EVALUATION'
  | 'TS-X4:IMPLICIT_STRUCTURAL_RELATIONSHIP'
  | 'J-X1:REFLECTION'
  | 'J-X2:DYNAMIC_PROXY'
  | 'J-X3:BYTECODE_MANIPULATION';

export interface ExplicitlyUndecidableForm {
  type: 'EXPLICITLY_UNDECIDABLE';
  reason: ExplicitlyUndecidableReason;
}

export type AnyBindingForm = SupportedBindingForm | UnrecognizedBindingForm | ExplicitlyUndecidableForm;

export type EnumerationInconsistencyCause =
  | 'TRAVERSAL_MISS'
  | 'UNSUPPORTED_AST_FORM'
  | 'ALIAS_RESOLUTION_FAILURE'
  | 'DEAD_IMPORT_SUSPECTED'
  | 'TYPE_ONLY_REFERENCE'
  | 'NAMESPACE_BINDING'
  | 'COMPILER_GENERATED_RELATIONSHIP';
