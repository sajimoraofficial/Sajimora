import { GenericRepositorySnapshot } from '../../../../../../core/src/sajimora/verification';

/** Canonical identity for a path inside a sealed repository snapshot.
 * The identity is POSIX-separated, repository-root-relative, dot-normalized,
 * case-preserving, and independent of the host operating system. */
export function canonicalRepositoryPath(input: string, rootIdentifier = '/'): string {
  const slash = (value: string) => value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  let value = slash(input.trim());
  let root = slash(rootIdentifier.trim());
  const drive = (text: string) => /^[A-Za-z]:\//.exec(text)?.[0].toLowerCase();
  if (root !== '/' && root !== '') {
    root = root.replace(/\/$/, '');
    const comparableValue = drive(value) ? value.toLowerCase() : value;
    const comparableRoot = drive(root) ? root.toLowerCase() : root;
    if (comparableValue === comparableRoot) value = '';
    else if (comparableValue.startsWith(`${comparableRoot}/`)) value = value.slice(root.length + 1);
  }
  value = value.replace(/^[A-Za-z]:\//, '').replace(/^\/+/, '');
  const resolved: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!resolved.length) return '__ESCAPE_ROOT__';
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join('/');
}

export function readSnapshotText(snapshot: GenericRepositorySnapshot, input: string): string | undefined {
  const canonical = canonicalRepositoryPath(input, snapshot.rootIdentifier);
  if (canonical === '__ESCAPE_ROOT__') return undefined;
  const direct = snapshot.readTextFile(canonical);
  if (direct !== undefined) return direct;
  const descriptor = snapshot.files.find(file => canonicalRepositoryPath(file.path, snapshot.rootIdentifier) === canonical);
  return descriptor ? snapshot.readTextFile(descriptor.path) : undefined;
}

export function readSnapshotBinary(snapshot: GenericRepositorySnapshot, input: string): Uint8Array | undefined {
  const canonical = canonicalRepositoryPath(input, snapshot.rootIdentifier);
  if (canonical === '__ESCAPE_ROOT__') return undefined;
  const direct = snapshot.readBinaryFile(canonical);
  if (direct !== undefined) return direct;
  const descriptor = snapshot.files.find(file => canonicalRepositoryPath(file.path, snapshot.rootIdentifier) === canonical);
  return descriptor ? snapshot.readBinaryFile(descriptor.path) : undefined;
}
