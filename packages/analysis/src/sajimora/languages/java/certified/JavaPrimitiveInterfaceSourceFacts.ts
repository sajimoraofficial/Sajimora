import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { GenericRepositorySnapshot } from '../../../../../../core/src/sajimora/verification';

export const JAVA_PRIMITIVE_INTERFACE_SOURCE_FACTS_V1 = 'JAVA_PRIMITIVE_INTERFACE_SOURCE_FACTS_V1';
type Primitive = 'boolean' | 'byte' | 'short' | 'char' | 'int' | 'long' | 'float' | 'double';
const primitives = new Set<string>(['boolean', 'byte', 'short', 'char', 'int', 'long', 'float', 'double']);
const reserved = new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null _ exports module non-sealed open opens permits provides record requires sealed to transitive uses var when with yield').split(' '));
const objectMethods = new Set(['getClass', 'hashCode', 'equals', 'clone', 'toString', 'notify', 'notifyAll', 'wait', 'finalize']);

export interface JavaPrimitiveInterfaceFacts {
  readonly profileId: typeof JAVA_PRIMITIVE_INTERFACE_SOURCE_FACTS_V1;
  readonly snapshotId: string;
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly fqcn: string;
  readonly methods: readonly {
    readonly name: string;
    readonly parameters: readonly Primitive[];
    readonly result: Primitive | 'void';
  }[];
}

export type JavaSourceFactResult =
  | { readonly status: 'SOURCE_FACTS_CHECKED'; readonly facts: JavaPrimitiveInterfaceFacts }
  | { readonly status: 'UNSUPPORTED'; readonly reason: string };

/** A source-fact leaf checker, NOT a Java compatibility/certification checker.
 * Grammar: [package Id(.Id)*;] public interface Id { Method+ }
 * Method: [public] [abstract] (Primitive|void) Id([Primitive Id (, Primitive Id)*]);
 * No overloads, inheritance, Object methods, arrays, annotations, generics,
 * bodies, Unicode escapes or non-ASCII source. All tokens must be consumed.
 * The grammar and implementation still require a soundness/correspondence proof
 * before these facts can support a registered F0 proof checker.
 */
export class JavaPrimitiveInterfaceSourceFacts {
  static read(snapshot: GenericRepositorySnapshot, path: string): JavaSourceFactResult {
    try {
      if (!path.endsWith('.java') || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path) ||
          path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('INVALID_SOURCE_PATH');
      const matches = snapshot.files.filter(file => file.path === path);
      if (matches.length !== 1) throw new Error('SOURCE_INVENTORY_NOT_UNIQUE');
      const entry = matches[0];
      if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 1 || entry.byteLength > 256_000) throw new Error('SOURCE_SIZE_LIMIT');
      const source = snapshot.readTextFile(path);
      if (source === undefined) throw new Error('SOURCE_MISSING');
      if (source.length > 256_000) throw new Error('SOURCE_SIZE_LIMIT');
      const bytes = Buffer.from(source, 'utf8');
      const binary = snapshot.readBinaryFile(path);
      if (bytes.length !== entry.byteLength || (binary !== undefined &&
          (binary.byteLength !== bytes.length || !bytes.equals(Buffer.from(binary)))) ||
          createHash('sha256').update(bytes).digest('hex') !== entry.hash) throw new Error('SOURCE_BYTES_MISMATCH');
      // Java translates Unicode escapes before lexing, including inside comments.
      // Reject them before skipping comments; stripping first would be unsound.
      if (/[^\x09\x0a\x0c\x0d\x20-\x7e]/.test(source) || source.includes('\\')) throw new Error('UNSUPPORTED_LEXICAL_INPUT');
      const tokens: string[] = [];
      const token = /[\t\n\f\r ]+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_$][A-Za-z0-9_$]*|[{}();,.]/y;
      let offset = 0;
      while (offset < source.length) {
        token.lastIndex = offset;
        const match = token.exec(source);
        if (!match) throw new Error('UNSUPPORTED_TOKEN');
        offset = token.lastIndex;
        if (!/^\s|^\//.test(match[0])) tokens.push(match[0]);
        if (tokens.length > 20_000) throw new Error('TOKEN_LIMIT');
      }
      let cursor = 0;
      const take = (expected: string): void => { if (tokens[cursor++] !== expected) throw new Error('UNSUPPORTED_GRAMMAR'); };
      const identifier = (): string => {
        const value = tokens[cursor++];
        if (!value || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) || reserved.has(value)) throw new Error('INVALID_IDENTIFIER');
        return value;
      };
      let packageName = '';
      if (tokens[cursor] === 'package') {
        cursor++;
        const segments = [identifier()];
        while (tokens[cursor] === '.') { cursor++; segments.push(identifier()); }
        take(';'); packageName = segments.join('.');
      }
      take('public'); take('interface');
      const name = identifier();
      if (path.split('/').at(-1) !== `${name}.java`) throw new Error('PUBLIC_TYPE_FILE_MISMATCH');
      take('{');
      const methods: Array<JavaPrimitiveInterfaceFacts['methods'][number]> = [];
      const names = new Set<string>();
      while (tokens[cursor] !== '}') {
        if (tokens[cursor] === 'public') cursor++;
        if (tokens[cursor] === 'abstract') cursor++;
        const result = tokens[cursor++];
        if (!primitives.has(result) && result !== 'void') throw new Error('UNSUPPORTED_RESULT_TYPE');
        const methodName = identifier();
        if (names.has(methodName) || objectMethods.has(methodName)) throw new Error('OVERLOAD_OR_OBJECT_METHOD_UNSUPPORTED');
        names.add(methodName); take('(');
        const parameters: Primitive[] = [];
        const parameterNames = new Set<string>();
        if (tokens[cursor] !== ')') {
          do {
            const type = tokens[cursor++];
            if (!primitives.has(type)) throw new Error('UNSUPPORTED_PARAMETER_TYPE');
            const parameterName = identifier();
            if (parameterNames.has(parameterName)) throw new Error('DUPLICATE_PARAMETER_NAME');
            parameterNames.add(parameterName); parameters.push(type as Primitive);
            if (parameters.length > 64) throw new Error('PARAMETER_LIMIT');
            if (tokens[cursor] !== ',') break;
            cursor++;
          } while (true);
        }
        take(')'); take(';');
        methods.push({ name: methodName, parameters, result: result as Primitive | 'void' });
        if (methods.length > 256) throw new Error('METHOD_LIMIT');
      }
      take('}');
      if (cursor !== tokens.length || methods.length === 0) throw new Error('INCOMPLETE_OR_EMPTY_PROFILE');
      methods.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      return { status: 'SOURCE_FACTS_CHECKED', facts: {
        profileId: JAVA_PRIMITIVE_INTERFACE_SOURCE_FACTS_V1, snapshotId: snapshot.snapshotId,
        path, sha256: entry.hash, byteLength: bytes.length, fqcn: packageName ? `${packageName}.${name}` : name, methods
      } };
    } catch (error) {
      return { status: 'UNSUPPORTED', reason: error instanceof Error ? error.message : 'SOURCE_READ_FAILED' };
    }
  }

  /** Recompute from the source; a hash or producer boolean alone never suffices. */
  static verify(snapshot: GenericRepositorySnapshot, proposed: JavaPrimitiveInterfaceFacts): boolean {
    try {
      const actual = this.read(snapshot, proposed.path);
      return actual.status === 'SOURCE_FACTS_CHECKED' && isDeepStrictEqual(actual.facts, proposed);
    } catch { return false; }
  }
}
