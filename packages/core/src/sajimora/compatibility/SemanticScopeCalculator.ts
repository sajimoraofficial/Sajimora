import { ProofObligation, ObligationSemanticScope } from '../types/obligation';
import { SymbolKind } from '../types/symbol';

export class SemanticScopeCalculator {
  
  public static calculate(
    obligation: ProofObligation, 
    language: 'typescript' | 'java', 
    symbolKind: SymbolKind
  ): ObligationSemanticScope {
    
    if (language === 'java') {
      return {
        unsupportedRelationshipPossible: false,
        reason: 'JAVA_ALL_EXPLICIT'
      };
    }

    // TypeScript evaluation
    if (symbolKind === 'INTERFACE') {
      return {
        unsupportedRelationshipPossible: true,
        reason: 'TS_INTERFACE_STRUCTURAL_POSSIBLE'
      };
    }

    if (symbolKind === 'TYPE_ALIAS') {
      return {
        unsupportedRelationshipPossible: true,
        reason: 'TS_TYPE_ALIAS_STRUCTURAL_POSSIBLE'
      };
    }

    if (symbolKind === 'CLASS') {
      return {
        unsupportedRelationshipPossible: false,
        reason: 'TS_CLASS_VALUE_LEVEL'
      };
    }

    // Default for METHOD, FUNCTION, ENUM
    return {
      unsupportedRelationshipPossible: false,
      reason: 'TS_VALUE_LEVEL_NO_IMPLICIT'
    };
  }
}
