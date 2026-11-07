import * as ts from 'typescript';
import {createHash} from 'node:crypto';

export interface CallIdentity {
  readonly version: 'SAJIMORA_CALL_V1';
  readonly snapshot?: string;
  readonly file: string;
  readonly sourceSha256: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly adapterKind: string;
}
const hashes = new WeakMap<ts.SourceFile, string>();
export function sourceHash(sf: ts.SourceFile): string {
  let hash = hashes.get(sf);
  if (!hash) { hash = createHash('sha256').update(sf.text).digest('hex'); hashes.set(sf, hash); }
  return hash;
}
export function callIdentity(node: ts.CallExpression, adapterKind: string): CallIdentity {
  const sf = node.getSourceFile();
  return {version:'SAJIMORA_CALL_V1',file:sf.fileName.replace(/\\/g,'/'),sourceSha256:sourceHash(sf),startOffset:node.getStart(sf),endOffset:node.getEnd(),adapterKind};
}
