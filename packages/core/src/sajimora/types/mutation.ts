export type ProviderMutationClassification =
  | 'PUBLIC_SYMBOL_EXPORTED'
  | 'EXPORTED_SIGNATURE_MUTATED'
  | 'TYPE_DEF_MUTATED'
  | 'SYMBOL_DELETED';

export interface ProviderMutationCharacterization {
  targetSymbolId: string;
  beforeExists: boolean;
  afterExists: boolean;
  classification: ProviderMutationClassification;
  isAstDiffDerived: boolean;
  beforeParsed: boolean;
  afterParsed: boolean;
}

export function isProviderMutationValidlyCharacterized(
  mutation: ProviderMutationCharacterization
): boolean {
  return (
    mutation.beforeExists === true &&
    mutation.beforeParsed === true &&
    (mutation.classification === 'SYMBOL_DELETED' || mutation.afterParsed === true) &&
    mutation.isAstDiffDerived === true &&
    ['PUBLIC_SYMBOL_EXPORTED', 'EXPORTED_SIGNATURE_MUTATED', 'TYPE_DEF_MUTATED', 'SYMBOL_DELETED'].includes(
      mutation.classification
    )
  );
}
