import { GitRepository } from './GitRepository';
export interface ResolvedRevisions { parentSha: string; candidateSha: string; candidateParents: string[]; parentSelection: { strategy: 'EXPLICIT_PARENT'; selectedParentSha: string } }
export class RevisionResolver {
  constructor(private readonly repository: GitRepository) {}
  resolve(parent: string, candidate: string): ResolvedRevisions {
    if (!parent.trim() || !candidate.trim()) throw new Error('Parent and candidate revisions are required.');
    const parentSha = this.commit(parent); const candidateSha = this.commit(candidate);
    if (parentSha === candidateSha) throw new Error('Parent and candidate must resolve to different commits.');
    const candidateParents = this.repository.text(['rev-list', '--parents', '-n', '1', '--end-of-options', candidateSha]).trim().split(/\s+/).slice(1);
    if (!candidateParents.includes(parentSha)) throw new Error('The selected parent is not a direct parent of the candidate commit.');
    return { parentSha, candidateSha, candidateParents, parentSelection: { strategy: 'EXPLICIT_PARENT', selectedParentSha: parentSha } };
  }
  private commit(revision: string): string {
    if (revision.startsWith('-')) throw new Error(`Invalid revision argument: revision must not start with '-'`);
    const sha = this.repository.text(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Revision did not resolve to a full commit SHA: ${revision}`);
    return sha;
  }
}
