import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';

export class GitRepository {
  readonly root: string;
  constructor(root: string) { this.root = path.resolve(root); }
  text(args: string[]): string { return execFileSync('git', ['--no-optional-locks', '-C', this.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024 }); }
  buffer(args: string[]): Buffer { return execFileSync('git', ['--no-optional-locks', '-C', this.root, ...args], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024 }) as Buffer; }
  bufferWithInput(args: string[], input: Buffer | string): Buffer { return execFileSync('git', ['--no-optional-locks', '-C', this.root, ...args], { input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }) as Buffer; }
  validate(): void { if (this.text(['rev-parse', '--is-inside-work-tree']).trim() !== 'true') throw new Error('Not a Git working tree.'); }
  statusFingerprint(): string {
    const indexPath = this.text(['rev-parse', '--git-path', 'index']).trim();
    const absoluteIndex = path.isAbsolute(indexPath) ? indexPath : path.resolve(this.root, indexPath);
    const indexHash = fs.existsSync(absoluteIndex) ? createHash('sha256').update(fs.readFileSync(absoluteIndex)).digest('hex') : 'NO_INDEX';
    return [this.text(['rev-parse', 'HEAD']).trim(), this.text(['status', '--porcelain=v1', '-z', '--untracked-files=all']), indexHash, this.text(['for-each-ref', '--format=%(refname):%(objectname)']).split(/\r?\n/).filter(Boolean).sort().join('\n')].join('\0');
  }
  repositoryId(): string {
    const roots = this.text(['rev-list', '--max-parents=0', '--all']).split(/\r?\n/).filter(Boolean).sort();
    if (!roots[0]) throw new Error('Repository has no root commit.');
    return `git-root:${roots[0]}`;
  }
}
