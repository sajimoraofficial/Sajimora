/**
 * @file canonicalEncoding.ts
 * Strict JSON decode, canonical encode, domain-separated hashes, exact-byte validation.
 */

import * as crypto from 'crypto';
import { ArtifactDomain, SchemaVersion, INITIAL_RESOURCE_PROFILE } from './protocol';

/**
 * Encodes an object into canonical JSON format.
 * - Binary-ordered keys.
 * - No undefined values.
 * - Set arrays should already be sorted by canonical member encoding before passing here.
 */
export class CanonicalSet<T> extends Set<T> {}

export function canonicalEncode(obj: any): string {
  if (obj === undefined) {
    throw new Error('undefined is not permitted in canonical encoding; use explicit null');
  }
  if (obj === null) return 'null';
  if (typeof obj === 'number') {
    if (Number.isNaN(obj) || !Number.isFinite(obj)) {
      throw new Error('Forbidden number value in canonical encode');
    }
    if (Object.is(obj, -0)) return '0';
    return String(obj);
  }
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'string') {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(obj)) {
      throw new Error('Unpaired surrogate in string');
    }
    return JSON.stringify(obj);
  }
  if (obj instanceof CanonicalSet) {
    const encodedItems = Array.from(obj).map(item => canonicalEncode(item));
    encodedItems.sort();
    for (let i = 1; i < encodedItems.length; i++) {
      if (encodedItems[i] === encodedItems[i - 1]) {
        throw new Error('Duplicate semantic member in set array');
      }
    }
    return `[${encodedItems.join(',')}]`;
  }
  if (Array.isArray(obj)) {
    const encodedItems = obj.map(item => canonicalEncode(item));
    return `[${encodedItems.join(',')}]`;
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort(); // binary ordered
    const parts = [];
    for (const key of keys) {
      const val = obj[key];
      if (val === undefined) {
        throw new Error('undefined is not permitted in canonical encoding; use explicit null');
      }
      parts.push(`${JSON.stringify(key)}:${canonicalEncode(val)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new Error(`Unsupported type for canonical encode: ${typeof obj}`);
}

/**
 * Computes a domain-separated SHA-256 hash.
 * hash = SHA256( domainTag || NUL || schemaVersion || NUL || canonicalPayloadBytes )
 */
export function computeDomainSeparatedHash(
  domain: ArtifactDomain,
  schemaVersion: SchemaVersion,
  payloadBytes: Buffer
): string {
  const hash = crypto.createHash('sha256');
  hash.update(domain, 'utf8');
  hash.update(Buffer.from([0]));
  hash.update(schemaVersion, 'utf8');
  hash.update(Buffer.from([0]));
  hash.update(payloadBytes);
  return hash.digest('hex');
}

export function strictJsonDecode(json: string | Buffer, maxDepth: number = INITIAL_RESOURCE_PROFILE.maxSyntaxNesting): any {
  let str: string;
  if (Buffer.isBuffer(json)) {
    str = json.toString('utf8');
    if (Buffer.from(str, 'utf8').compare(json) !== 0) {
      throw new Error('Invalid UTF-8');
    }
  } else {
    str = json;
  }

  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(str)) {
    throw new Error('Unpaired surrogate');
  }

  let pos = 0;
  function skipWhitespace() {
    while (pos < str.length && (str[pos] === ' ' || str[pos] === '\n' || str[pos] === '\r' || str[pos] === '\t')) pos++;
  }

  function parseValue(depth: number = 0): any {
    skipWhitespace();
    if (pos >= str.length) throw new Error('Unexpected end of JSON input');
    const char = str[pos];
    if (char === '{') return parseObject(depth);
    if (char === '[') return parseArray(depth);
    if (char === '"') return parseString();
    if (char === 't' || char === 'f' || char === 'n') return parseLiteral();
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber();
    throw new Error(`Unexpected token at position ${pos}`);
  }

  function parseObject(depth: number) {
    if (depth > maxDepth) throw new Error('Maximum nesting depth exceeded');
    const obj: any = {};
    pos++;
    skipWhitespace();
    if (str[pos] === '}') { pos++; return obj; }
    while (true) {
      skipWhitespace();
      if (str[pos] !== '"') throw new Error(`Expected string key at position ${pos}`);
      const key = parseString();
      skipWhitespace();
      if (str[pos] !== ':') throw new Error(`Expected ':' at position ${pos}`);
      pos++;
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        throw new Error(`Duplicate key "${key}"`);
      }
      obj[key] = parseValue(depth + 1);
      skipWhitespace();
      if (str[pos] === '}') { pos++; break; }
      if (str[pos] === ',') { pos++; } 
      else throw new Error(`Expected ',' or '}' at position ${pos}`);
    }
    return obj;
  }

  function parseArray(depth: number) {
    if (depth > maxDepth) throw new Error('Maximum nesting depth exceeded');
    const arr: any[] = [];
    pos++;
    skipWhitespace();
    if (str[pos] === ']') { pos++; return arr; }
    while (true) {
      arr.push(parseValue(depth + 1));
      skipWhitespace();
      if (str[pos] === ']') { pos++; break; }
      if (str[pos] === ',') { pos++; } 
      else throw new Error(`Expected ',' or ']' at position ${pos}`);
    }
    return arr;
  }

  function parseString() {
    let end = pos + 1;
    while (end < str.length) {
      if (str[end] === '"') {
        let escapes = 0, p = end - 1;
        while (p >= pos && str[p] === '\\') { escapes++; p--; }
        if (escapes % 2 === 0) break;
      }
      end++;
    }
    if (end >= str.length) throw new Error('Unterminated string');
    const s = str.substring(pos, end + 1);
    pos = end + 1;
    const parsed = JSON.parse(s);
    if (typeof parsed === 'string' && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(parsed)) {
      throw new Error('Unpaired surrogate');
    }
    return parsed;
  }

  function parseLiteral() {
    if (str.startsWith('true', pos)) { pos += 4; return true; }
    if (str.startsWith('false', pos)) { pos += 5; return false; }
    if (str.startsWith('null', pos)) { pos += 4; return null; }
    throw new Error(`Unexpected token at position ${pos}`);
  }

  function parseNumber() {
    const start = pos;
    if (str[pos] === '-') pos++;
    while (pos < str.length && ((str[pos] >= '0' && str[pos] <= '9') || str[pos] === '.' || str[pos] === 'e' || str[pos] === 'E' || str[pos] === '+' || str[pos] === '-')) pos++;
    const num = Number(str.substring(start, pos));
    if (Number.isNaN(num)) throw new Error(`Invalid number at position ${start}`);
    return num;
  }

  const result = parseValue();
  skipWhitespace();
  if (pos < str.length) throw new Error('Trailing data');
  return result;
}

/**
 * Helper to compute the digest of a given contract object.
 */
export function hashContract(domain: ArtifactDomain, schemaVersion: SchemaVersion, contract: any): string {
  const canonicalString = canonicalEncode(contract);
  const payloadBytes = Buffer.from(canonicalString, 'utf8');
  return computeDomainSeparatedHash(domain, schemaVersion, payloadBytes);
}
