import { GitRepository } from './GitRepository';

export interface GitDiffFileEvidence {
  parentPath: string | null; candidatePath: string | null;
  status: 'ADDED' | 'DELETED' | 'MODIFIED' | 'RENAMED';
  similarity: number | null;
  hunks: Array<{ parentStart: number; parentLines: number; candidateStart: number; candidateLines: number }>;
}

export class GitDiffReader {
  constructor(private readonly repository: GitRepository) {}
  read(parent: string, candidate: string): GitDiffFileEvidence[] {
    if (parent.startsWith('-') || candidate.startsWith('-')) {
      throw new Error(`Invalid revision argument: revisions must not start with '-'`);
    }
    const records = this.repository.buffer(['diff', '--name-status', '-z', '--find-renames', '--end-of-options', parent, candidate]).toString('utf8').split('\0');
    const result: GitDiffFileEvidence[] = [];
    for (let i = 0; i < records.length;) {
      const code = records[i++]; if (!code) break;
      if (code.startsWith('R')) { const parentPath = records[i++]; const candidatePath = records[i++]; result.push({ parentPath, candidatePath, status: 'RENAMED', similarity: Number(code.slice(1)), hunks: [] }); }
      else { const file = records[i++]; const status = code[0] === 'A' ? 'ADDED' : code[0] === 'D' ? 'DELETED' : 'MODIFIED'; result.push({ parentPath: status === 'ADDED' ? null : file, candidatePath: status === 'DELETED' ? null : file, status, similarity: null, hunks: [] }); }
    }
    const patch = this.repository.text(['diff', '--no-ext-diff', '--no-color', '--unified=0', '--find-renames', '--end-of-options', parent, candidate]); let current: GitDiffFileEvidence | undefined; let pendingParent: string | null | undefined;
    for (const line of patch.split(/\r?\n/)) {
      if (line.startsWith('diff --git ')) { current = undefined; pendingParent = undefined; continue; }
      if (line.startsWith('--- ')) { const value=line.slice(4); pendingParent=value==='/dev/null'?null:value.replace(/^a\//,''); continue; }
      if (line.startsWith('+++ ')) { const value=line.slice(4); const candidatePath=value==='/dev/null'?null:value.replace(/^b\//,''); current=result.find(r=>r.parentPath===pendingParent && r.candidatePath===candidatePath); continue; }
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line); if (match && current) current.hunks.push({ parentStart:Number(match[1]), parentLines:Number(match[2]??1), candidateStart:Number(match[3]), candidateLines:Number(match[4]??1) });
    }
    for (const item of result) item.hunks.sort((a,b)=>a.parentStart-b.parentStart || a.candidateStart-b.candidateStart);
    return result.sort((a,b) => {
      const ka = `${a.parentPath ?? ''}:${a.candidatePath ?? ''}`;
      const kb = `${b.parentPath ?? ''}:${b.candidatePath ?? ''}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
}
