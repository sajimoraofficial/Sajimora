import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as ts from 'typescript';

/** Trusted toolchain input, never a fallback to the analyzed repository's disk.
 * All compiler-distributed libraries are captured once and content-addressed.
 * Virtual names cannot collide with snapshot files. */
export const COMPILER_LIBRARY_ROOT = '__sajimora_typescript_libs__';
let distribution: { files: ReadonlyMap<string, string>; digest: string } | undefined;
export function compilerLibraries(): { files: ReadonlyMap<string, string>; digest: string } {
  if (distribution) return distribution;
  if (ts.version !== '5.9.3') throw new Error(`UNQUALIFIED_TYPESCRIPT_VERSION: ${ts.version}`);
  const directory = path.dirname(ts.getDefaultLibFilePath({}));
  const files = new Map<string, string>();
  const hash = crypto.createHash('sha256').update(ts.version);
  for (const name of fs.readdirSync(directory).filter(n => /^lib(?:\.[\w.-]+)?\.d\.ts$/.test(n)).sort()) {
    const content = fs.readFileSync(path.join(directory, name), 'utf8');
    files.set(`${COMPILER_LIBRARY_ROOT}/${name}`, content);
    hash.update(name).update('\0').update(content).update('\0');
  }
  if (!files.has(`${COMPILER_LIBRARY_ROOT}/lib.d.ts`)) throw new Error('MISSING_COMPILER_LIBRARIES');
  distribution = { files, digest: hash.digest('hex') };
  return distribution;
}
