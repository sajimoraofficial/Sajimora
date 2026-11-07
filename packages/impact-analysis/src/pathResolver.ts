import * as fs from 'fs';
import * as path from 'path';

export function getCanonicalRepoRoot(customRoot?: string): string {
  if (customRoot && customRoot.trim() !== '') {
    return path.resolve(customRoot);
  }
  return path.resolve(process.cwd());
}

export interface PathResolutionResult {
  accepted: boolean;
  rawPath: string;
  resolvedPath: string;
  canonicalRepoRoot: string;
  normalizedRelativePath: string;
  exists: boolean;
  isFile: boolean;
  rejectionReason?: string;
}

export const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /^\.env(?:\.|$)/i,
  /\/\.env(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /(?:^|[/\\])id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?$/i,
  /\bprivate[_-]?key\b/i,
  /[a-z0-9_\-]*cred[a-z0-9_\-]*\.(?:json|ya?ml|toml|ini|txt)$/i,
  /[a-z0-9_\-]*secret[a-z0-9_\-]*\.(?:json|ya?ml|toml|ini|txt)$/i,
  /[a-z0-9_\-]*apikey[a-z0-9_\-]*\.(?:json|ya?ml|toml|ini|txt)$/i,
  /[a-z0-9_\-]*token[a-z0-9_\-]*\.(?:json|ya?ml|toml|ini|txt)$/i,
  /\btmp-.*cred/i
];

const SOURCE_CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.rb', '.php', '.swift', '.kt', '.scala',
  '.html', '.css', '.scss', '.sass', '.less',
  '.md', '.markdown', '.prisma', '.json'
]);

export function isSensitiveFile(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  const normalized = filePath.replace(/\\/g, '/');
  const basename = path.basename(normalized);
  const ext = path.extname(basename).toLowerCase();

  if (basename.startsWith('.env') || /\/\.env(?:\.|$)/i.test(normalized)) {
    return true;
  }

  if (SOURCE_CODE_EXTENSIONS.has(ext)) {
    return false;
  }

  return SENSITIVE_FILE_PATTERNS.some(p => p.test(basename) || p.test(normalized));
}

export function admitRepositoryFiles(files: string[]): string[] {
  if (!Array.isArray(files)) return [];
  return files.filter(f => !isSensitiveFile(f) && !f.replace(/\\/g, '/').startsWith('benchmarks/'));
}

export function resolveCanonicalRepositoryPath(
  rawCandidate: string,
  repoRoot: string = getCanonicalRepoRoot()
): PathResolutionResult {
  const canonicalRoot = getCanonicalRepoRoot(repoRoot);

  if (!rawCandidate || typeof rawCandidate !== 'string' || rawCandidate.trim() === '') {
    return {
      accepted: false,
      rawPath: String(rawCandidate),
      resolvedPath: '',
      canonicalRepoRoot: canonicalRoot,
      normalizedRelativePath: '',
      exists: false,
      isFile: false,
      rejectionReason: 'Empty or invalid candidate path string'
    };
  }

  const cleaned = rawCandidate.trim();
  let resolved: string;
  if (path.isAbsolute(cleaned)) {
    resolved = path.resolve(cleaned);
  } else {
    resolved = path.resolve(canonicalRoot, cleaned);
  }

  const isWindows = process.platform === 'win32';
  const normRootRaw = path.resolve(canonicalRoot).replace(/\\/g, '/');
  const normResolvedRaw = path.resolve(resolved).replace(/\\/g, '/');
  const normRoot = isWindows ? normRootRaw.toLowerCase() : normRootRaw;
  const normResolved = isWindows ? normResolvedRaw.toLowerCase() : normResolvedRaw;

  const rootWithSlash = normRoot.endsWith('/') ? normRoot : normRoot + '/';
  const isInside = normResolved === normRoot || normResolved.startsWith(rootWithSlash);
  const rel = path.relative(canonicalRoot, resolved).replace(/\\/g, '/');
  const escapesRelative = rel.startsWith('..') || path.isAbsolute(rel);

  if (!isInside || escapesRelative) {
    return {
      accepted: false,
      rawPath: rawCandidate,
      resolvedPath: resolved,
      canonicalRepoRoot: canonicalRoot,
      normalizedRelativePath: '',
      exists: false,
      isFile: false,
      rejectionReason: 'Path escapes repository boundary'
    };
  }

  let exists = false;
  let isFile = false;
  try {
    const stat = fs.statSync(resolved);
    exists = true;
    isFile = stat.isFile();
  } catch {
    exists = false;
    isFile = false;
  }


  return {
    accepted: exists && isFile,
    rawPath: rawCandidate,
    resolvedPath: resolved,
    canonicalRepoRoot: canonicalRoot,
    normalizedRelativePath: rel,
    exists,
    isFile,
    rejectionReason: exists ? (isFile ? undefined : 'Not a regular file') : 'File does not exist'
  };
}
