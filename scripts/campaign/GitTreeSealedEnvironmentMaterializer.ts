import { GitRepository, GitObjectReader } from '@sajimora/analysis';
import { VerificationBudget } from '../../packages/analysis/src/sajimora/certified/proof/VerificationBudget';
import type { PilotSourceFile } from './CertifiedCampaignAdapter';

export interface MaterializedGitRevision {
  revision: string;
  treeId: string;
  files: PilotSourceFile[];
  logicalPaths: string[];
}

/**
 * Reads a revision exclusively from Git objects and supplies the complete set
 * of source files and package metadata that the existing F0 resolver can see.
 * It deliberately does not interpret configuration or broaden resolution.
 */
export class GitTreeSealedEnvironmentMaterializer {
  public constructor(
    private readonly repository: GitRepository,
    private readonly reader: GitObjectReader
  ) {}

  public materialize(revision: string, budget?: VerificationBudget): MaterializedGitRevision {
    const entries = this.reader.entries(revision)
      .filter(entry => entry.type === 'blob' && this.isAdmittedArtifactPath(entry.path))
      .sort((left, right) => left.path.localeCompare(right.path));

    const blobs = this.reader.batchBlobs(entries.map(entry => entry.objectId));
    const files: PilotSourceFile[] = [];
    for (const entry of entries) {
      budget?.allocate('VERTICES', 1);
      const bytes = blobs.get(entry.objectId);
      if (!bytes) {
        throw new Error(`Missing Git blob ${entry.objectId} for ${revision}:${entry.path}`);
      }
      budget?.allocate('INPUT_BYTES', bytes.length);
      files.push({ path: entry.path, content: bytes.toString('utf8') });
    }

    const treeId = this.repository.text(['rev-parse', `${revision}^{tree}`]).trim();
    if (!treeId) {
      throw new Error(`Missing Git tree for revision ${revision}`);
    }
    return { revision, treeId, files, logicalPaths: files.map(file => file.path) };
  }

  private isAdmittedArtifactPath(logicalPath: string): boolean {
    return logicalPath.endsWith('.ts') ||
      logicalPath.endsWith('.tsx') ||
      logicalPath.endsWith('.d.ts') ||
      logicalPath === 'tsconfig.json' ||
      logicalPath.endsWith('/tsconfig.json') ||
      logicalPath === 'package.json' ||
      logicalPath.endsWith('/package.json');
  }
}
