export type PersistentSymbolId = string;

export type SymbolKind = 
  | 'FUNCTION'
  | 'CLASS'
  | 'INTERFACE'
  | 'TYPE_ALIAS'
  | 'ENUM'
  | 'METHOD'
  | 'FIELD'
  | 'VARIABLE';

export interface SymbolFingerprint {
  value: string;
  components: {
    globallyQualifiedOwner: string; // full repo-relative module path + "::" + owner chain
    symbolLocalName: string;
    kind: SymbolKind;
    parameterTypeFingerprint: string;
  };
}

export interface SymbolRef {
  persistentSymbolId: PersistentSymbolId;
  symbolId?: string; // backwards/convenience identifier matching persistentSymbolId or symbolLocalName
  fingerprint: SymbolFingerprint;
  qualifiedName: string;  // locator only; NOT the identity key
  kind: SymbolKind;
  ownerId: string | null;
  declarationLocation: { filePath: string; line: number };
}

export function getSymbolName(symbol: SymbolRef): string {
  return symbol.symbolId ?? symbol.fingerprint?.components?.symbolLocalName ?? symbol.qualifiedName ?? symbol.persistentSymbolId;
}

export function getSymbolPersistentId(symbol: SymbolRef): string {
  return symbol.persistentSymbolId ?? symbol.symbolId ?? getSymbolName(symbol);
}
